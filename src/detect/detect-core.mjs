/**
 * detect-core.mjs — 自动打框的**纯逻辑**：letterbox、输出解码、NMS、跨模型合并、扩张、对齐、上限
 *
 * 为什么单独拆一个模块
 * --------------------
 * 1) 这里全是可判定的整数/浮点运算，**不碰 DOM、不碰 ONNX Runtime**，所以能直接在 node 里单测
 *    （见 test/detect/detect-core.test.mjs：不需要浏览器、不需要模型、不需要 GPU）。
 * 2) 页面侧只负责"拿图 → 调这里 → 把结果塞进 MOB.regions"，出问题时能立刻分清是
 *    "模型/运行时的问题" 还是 "几何换算的问题"。
 * 3) 对齐规则必须与 src/image-crypto.js 的 pV3 完全一致（同口径才不会有"列表显示的和
 *    实际打的不一样"），所以 alignRegion() 是照 pV3（第 1418–1425 行）逐条抄的，
 *    单测里用一份独立实现对照，任何一侧改动都会立刻被测试抓到。
 *
 * 术语
 * ----
 *   640 坐标系   把原图 letterbox 到 640×640 后的坐标（模型输出就在这个坐标系里）
 *   钳子约束     分块时把块内检出钳在窗口内（绝不外扩到没看过的像素）；
 *                比窗口还大的要素不做特殊覆盖 —— 那是滑窗法的固有限制，网页端不处理
 *   原图坐标系   用户看到的、也是 MOB.regions / 元数据里用的坐标
 *   掩膜外接框   分割模型掩膜（阈值化后）的外接矩形，比检测框更贴合目标
 */

/** 默认参数：与实测结论一致（阈值 0.30 时干净图零误报；扩张 1.0 表示不动） */
export const DEFAULT_OPTS = {
    conf: 0.30,          // 置信度阈值
    iou: 0.45,           // 类内 NMS 的 IoU
    maskThr: 0.5,        // 掩膜阈值（sigmoid 之后）
    // 默认 union 而不是 near：near 只保留高分框、**丢弃**与之重叠的低分框，会有
    // "敏感像素没被盖住"的风险（漏盖 = 泄露像素）。打码工具宁可多盖，不可漏盖。
    merge: 'union',      // 'none' | 'near'（重叠即同一处，保留高分框） | 'union'（合并成一个外接框）
    mergeIou: 0.30,      // 视为"同一处"的 IoU
    mergeContain: 0.80,  // 或 小框被大框包含的比例超过这个值也算同一处
    cap: 12,             // 上限：网页端硬限制（MOB.addRegion / IA.parseMeta 都是 12）
    capPolicy: 'score',  // 'score' | 'area'
    unit: 8,             // 与 pV3 的 PNG 路径一致；JPEG 路径会用到 16
    minSize: 8,          // 与手动框同标准（拖拽时 w>8 && h>8）
    tileOverlap: 0.5,    // 大图分块的窗口重叠：0.5 = 半步扫描
    tileMax: 128,        // 单张图最多切多少块（估算超过就拒绝，避免浏览器卡死）
};

/** 网页端只编码这 4 个字段（见 image-crypto.js 的 metaBytes：只读 x/y/w/h） */
export const ENCODED_FIELDS = ['x', 'y', 'w', 'h'];

/** 只保留参与编码的字段：标签/来源/分数是**纯展示**，绝不能混进编码路径与签名 */
export function encodeProjection(region) {
    return { x: region.x, y: region.y, w: region.w, h: region.h };
}

/* ────────────────────────────── 1. letterbox ────────────────────────────── */

/**
 * 与训练/推理一致的 letterbox：等比缩放 + 居中填充（114 灰）。
 * 返回的比例与偏移就是"640 坐标系 ↔ 原图坐标系"的唯一换算依据。
 */
export function letterbox(W, H, size = 640) {
    const r = Math.min(size / H, size / W);
    const nw = Math.round(W * r), nh = Math.round(H * r);
    return { r, nw, nh, dw: Math.floor((size - nw) / 2), dh: Math.floor((size - nh) / 2), size };
}

/** 640 坐标 → 原图坐标（并钳制进图内） */
export function from640(box, lb, W, H) {
    const x1 = (Math.min(box[0], box[2]) - lb.dw) / lb.r;
    const y1 = (Math.min(box[1], box[3]) - lb.dh) / lb.r;
    const x2 = (Math.max(box[0], box[2]) - lb.dw) / lb.r;
    const y2 = (Math.max(box[1], box[3]) - lb.dh) / lb.r;
    return [clamp(x1, 0, W), clamp(y1, 0, H), clamp(x2, 0, W), clamp(y2, 0, H)];
}

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ───────────────────── 1b. 大图分块（"半步扫描"） ───────────────────── */

/**
 * 把原图切成"模型输入大小"的方形窗口，**相邻窗口重叠一半**（半步扫描）。
 *
 * 为什么必须重叠一半，而不是刚好铺满：
 *   · 刚好铺满时，落在接缝上的部位会被两个窗口各切掉一半，两边都看不全 ——
 *     这正是最常见的漏检来源（这个模型基本靠"完整轮廓"给分）；
 *   · 重叠 50% 时，任何"最长边不超过半个窗口"的部位，至少能在某一个窗口里**完整出现**，
 *     所以接缝处不会丢。代价是同一处会被相邻窗口各检到一次 —— 交给
 *     mergeBySource（IoU / 小框包含率判据）合并成一处，结果里会带 `tiles` 说明它跨了几块。
 *
 * 边界一律**贴图内**（末列/末行不足一格时向内贴），所以
 *   · 每个窗口是 size×size（整图本身不足一格时就是整图），不产生填充边；
 *   · 右下角那带的窗口重叠比中间更多，不会出现"没覆盖到"的缝。
 *
 * @returns {{size, step, overlap, cols, rows, count, tiles:[{x,y,w,h}]}}
 */
export function planTiles(W, H, { size = 640, overlap = DEFAULT_OPTS.tileOverlap } = {}) {
    const s = Math.max(1, Math.round(size));
    const w = Math.max(1, Math.round(W)), h = Math.max(1, Math.round(H));
    const ov = Math.min(0.9, Math.max(0, overlap));
    const step = Math.max(1, Math.round(s * (1 - ov)));
    // 每个轴上窗口的滑动范围是 [0, len - s]；len ≤ s 时只有一个窗口（也就是整图）
    const axis = (len) => {
        if (len <= s) return [0];
        const span = len - s;
        const n = Math.ceil(span / step) + 1;
        const pos = [];
        for (let i = 0; i < n; i++) pos.push(Math.min(span, i * step));
        return pos;
    };
    const xs = axis(w), ys = axis(h);
    const tiles = [];
    for (const y of ys) for (const x of xs) tiles.push({ x, y, w: Math.min(s, w), h: Math.min(s, h) });
    return { size: s, step, overlap: ov, cols: xs.length, rows: ys.length, count: tiles.length, tiles };
}

/** 只想知道"要切几块"时用它（面板在跑之前先算一遍，块太多就提示换更大的尺度） */
export function tileCount(W, H, opts) { return planTiles(W, H, opts).count; }

/* ─────────────────────── 2. 模型输出 → 检测（640 坐标系）─────────────────────── */

/**
 * 解码 YOLO(11)-seg/detect 的输出。
 *
 * 张量布局（与训练侧一致，也是"必须写对"的地方）：
 *   preds  : [1, 4 + nc + numMask, anchors] —— 4=框(cx,cy,w,h)，nc=类别分，numMask=掩膜系数
 *   protos : [1, numMask, ph, pw]           —— 掩膜原型（**只有分割模型才有**）
 * 注意 preds 的索引是**列优先**：第 c 个通道的第 i 个锚点是 preds[c * anchors + i]。
 *
 * numMask 必须由调用方按模型类型给出（分割 32 / 纯检测 0）：
 * 用 (channels - 36) 反推 nc 是错的 —— 纯检测模型的 channels 只有 4+nc，
 * 反推会得到负数，然后静默产出一堆垃圾框。所以这里显式校验，算不对就直接抛。
 */
export function decodeDetections(preds, dims, opts = {}) {
    const conf = opts.conf ?? DEFAULT_OPTS.conf;
    const numMask = opts.numMask ?? 32;
    const [, channels, anchors] = dims;
    const nc = channels - 4 - numMask;
    if (nc <= 0) {
        throw new Error(`detect-core: 张量通道数 ${channels} 与 numMask=${numMask} 不匹配（算出的类别数为 ${nc}）；` +
            `分割模型应给 32 个掩膜系数、纯检测模型应给 0`);
    }
    const out = [];
    for (let i = 0; i < anchors; i++) {
        let best = -1, cls = -1;
        for (let c = 0; c < nc; c++) {
            const v = preds[(4 + c) * anchors + i];
            if (v > best) { best = v; cls = c; }
        }
        if (best <= conf) continue;
        const cx = preds[i], cy = preds[anchors + i];
        const w = preds[2 * anchors + i], h = preds[3 * anchors + i];
        let coeffs = null;
        if (numMask > 0) {
            coeffs = new Float32Array(numMask);
            for (let k = 0; k < numMask; k++) coeffs[k] = preds[(4 + nc + k) * anchors + i];
        }
        out.push({ box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], score: best, cls, coeffs });
    }
    return { detections: out, nc };
}

/** 类内 NMS（不同类别之间不互相压制 —— 这点很重要：同一处会被多类各框一次） */
export function nmsClassAware(detections, iouThr = DEFAULT_OPTS.iou) {
    const byClass = new Map();
    detections.forEach((d, i) => {
        if (!byClass.has(d.cls)) byClass.set(d.cls, []);
        byClass.get(d.cls).push(i);
    });
    const keep = [];
    for (const idxs of byClass.values()) {
        // 分数降序；同分按原始顺序（保证结果可复现）
        const rest = idxs.slice().sort((a, b) => detections[b].score - detections[a].score || a - b);
        while (rest.length) {
            const i = rest.shift();
            keep.push(i);
            for (let k = rest.length - 1; k >= 0; k--) {
                const j = rest[k];
                if (iou(detections[i].box, detections[j].box) > iouThr) rest.splice(k, 1);
            }
        }
    }
    return keep.sort((a, b) => a - b).map((i) => detections[i]);
}

export function iou(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    const ua = area(a) + area(b) - inter;
    return ua > 0 ? inter / ua : 0;
}

export function area(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }

/** 小框被大框包含的比例（用于"同一处"的第二种判据） */
export function containment(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    const small = Math.min(area(a), area(b));
    return small > 0 ? inter / small : 0;
}

export function unionBox(a, b) {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/* ───────────────────────── 3. 掩膜 → 原图坐标的外接框 ───────────────────────── */

/**
 * 分割模型：把该检测的掩膜（阈值化）取外接框，换回原图坐标。
 * 掩膜为空时返回 null，调用方退回检测框（纯检测模型天然走这条路）。
 *
 * 掩膜网格是 ph×pw（YOLO-seg 为 160×160），映射关系：proto 像素 → 640 坐标 → 原图坐标。
 */
export function maskToBox(det, protos, protoDims, lb, W, H, thr = DEFAULT_OPTS.maskThr) {
    if (!protos || !det.coeffs) return null;
    const [, K, ph, pw] = protoDims;
    const [x1, y1, x2, y2] = det.box;
    const px0 = clamp(Math.floor(x1 / lb.size * pw), 0, pw);
    const py0 = clamp(Math.floor(y1 / lb.size * ph), 0, ph);
    const px1 = clamp(Math.ceil(x2 / lb.size * pw), 0, pw);
    const py1 = clamp(Math.ceil(y2 / lb.size * ph), 0, ph);
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity, hits = 0;
    for (let py = py0; py < py1; py++) {
        for (let px = px0; px < px1; px++) {
            let s = 0;
            for (let k = 0; k < K; k++) s += det.coeffs[k] * protos[k * ph * pw + py * pw + px];
            if (1 / (1 + Math.exp(-s)) > thr) {
                hits++;
                const X = px / pw * lb.size, Y = py / ph * lb.size;
                if (X < mx0) mx0 = X;
                if (Y < my0) my0 = Y;
                if (X > mx1) mx1 = X;
                if (Y > my1) my1 = Y;
            }
        }
    }
    if (!hits) return null;
    // 与已验证的 Python/浏览器对照实现保持同一口径：取映射后的极值（不再 +1 个 proto 像素），
    // 后续的整块对齐（unit=8）本来就会向外扩到完整块，这里多算反而会让期望值对不上。
    return { box: from640([mx0, my0, mx1, my1], lb, W, H), hits };
}

/* ─────────────────────────── 4. 多个模型的输出合并 ─────────────────────────── */

/**
 * 把每个模型的结果折成"一处一个框"。
 *
 * 为什么要合并：同一部位会被多个类、多个模型各框一次（实测 nipples/pussy/anus 会互相抢
 * 同一个位置），不合并的话 12 个上限很快被无意义的重复框吃光，而且打码会重叠处理。
 *
 * merge='none'  ：只做类内 NMS，原样保留（调试用）
 * merge='near'  ：跨类/跨模型，IoU > mergeIou 或 小框包含率 > mergeContain → 只留分高者
 * merge='union' ：同一组的框合并成一个外接框（标签取组内最高分那个）
 */
export function mergeBySource(items, opts = {}) {
    const mode = opts.merge ?? DEFAULT_OPTS.merge;
    const thr = opts.mergeIou ?? DEFAULT_OPTS.mergeIou;
    const cthr = opts.mergeContain ?? DEFAULT_OPTS.mergeContain;
    const sorted = items.slice().sort((a, b) => b.score - a.score || (a.order ?? 0) - (b.order ?? 0));
    if (mode === 'none') return sorted;
    const groups = [];
    for (const d of sorted) {
        let hit = null;
        for (const g of groups) {
            if (iou(g.box, d.box) > thr || containment(g.box, d.box) > cthr) { hit = g; break; }
        }
        if (!hit) {
            // kind（掩膜外接框 / 检测框）也要带走：页面上要标明这个框是怎么来的
            groups.push({ box: d.box.slice(), score: d.score, cls: d.cls, label: d.label, src: d.src,
                          kind: d.kind, group: [d], merged: 0,
                          clipped: !!d.clipped, anyClipped: !!d.clipped, repSwitched: 0 });
        } else {
            hit.merged++;
            hit.group.push(d);
            hit.anyClipped = hit.anyClipped || !!d.clipped;
            if (mode === 'union') {
                hit.box = unionBox(hit.box, d.box);
                if (!d.clipped) hit.clipped = false;      // 组里出现了完整的框 → 外接框已完整
            } else if (hit.clipped && !d.clipped) {
                // 钳子约束的第二半：代表换成"完整的那个"。
                // 否则会出现"被窗口切掉一半、分数却更高"的框当代表，打码区域就偏小。
                hit.box = d.box.slice(); hit.score = d.score; hit.cls = d.cls; hit.label = d.label;
                hit.src = d.src; hit.kind = d.kind; hit.clipped = false; hit.repSwitched++;
            }
        }
    }
    return groups.map((g) => ({
        box: g.box, score: g.score, cls: g.cls, label: g.label, src: g.src, kind: g.kind,
        merged: g.merged, mergedWith: g.group.slice(1).map((x) => `${x.label || ''}@${x.src || ''}`),
        sources: [...new Set(g.group.map((x) => x.src))],
        // 大图分块时：这一处是被哪几块检到的（>1 说明它跨在接缝上，已被合并成一处）
        tiles: [...new Set(g.group.map((x) => x.tile).filter((v) => v !== null && v !== undefined))],
        // 钳子读数（两个口径分清楚）：
        //   clipped     = **最终代表框**仍是被窗口钳过的那个 → 这个区域可能不完整（要素比窗口大）
        //   clampedSeen = 这一处的组成员里出现过被钳的框（诊断用，哪怕最后被完整框替换了）
        clipped: !!g.clipped, clampedSeen: !!g.anyClipped, repSwitched: g.repSwitched,
    }));
}

/* ─────────────────────────── 5. 扩张 / 对齐 / 上限 ─────────────────────────── */

/**
 * 扩张：等比缩放（绕中心）或固定像素外扩。
 * 需求 4 明确要求**对手动框同样适用**，所以这里是通用函数，不区分来源。
 */
export function expandBox(box, { mode = 'scale', factor = 1, pad = 0 } = {}, W, H) {
    const [x1, y1, x2, y2] = box;
    let nx1, ny1, nx2, ny2;
    if (mode === 'pad') {
        nx1 = x1 - pad; ny1 = y1 - pad; nx2 = x2 + pad; ny2 = y2 + pad;
    } else {
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        const hw = (x2 - x1) / 2 * factor, hh = (y2 - y1) / 2 * factor;
        nx1 = cx - hw; ny1 = cy - hh; nx2 = cx + hw; ny2 = cy + hh;
    }
    return [clamp(nx1, 0, W), clamp(ny1, 0, H), clamp(nx2, 0, W), clamp(ny2, 0, H)];
}

export function expandRegions(regions, opts, W, H) {
    return regions.map((r) => {
        const b = expandBox([r.x, r.y, r.x + r.w, r.y + r.h], opts, W, H);
        return Object.assign({}, r, { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
    });
}

/**
 * 与 pV3 完全同口径的整块对齐（PNG 路径 unit=8）：
 *   x0 = floor(x/unit)*unit ；w 也回落成完整块的倍数，且右下不越界。
 * 出处：src/image-crypto.js 第 1418–1425 行。**显示值必须用对齐后的值**，
 * 否则列表里写的是"对齐前"，实际打的是"对齐后"，用户会以为打错了地方。
 */
export function alignRegion(r, unit = DEFAULT_OPTS.unit, W, H) {
    const x = Math.max(0, Math.floor(r.x / unit) * unit);
    const y = Math.max(0, Math.floor(r.y / unit) * unit);
    const w = Math.max(0, Math.floor(Math.min(W - x, Math.ceil(r.w / unit) * unit) / unit) * unit);
    const h = Math.max(0, Math.floor(Math.min(H - y, Math.ceil(r.h / unit) * unit) / unit) * unit);
    return Object.assign({}, r, { x, y, w, h });
}

/** 对齐后的归一化 + 最小尺寸过滤（对齐后不足 minSize 的块在网页端做不出有意义的打码） */
export function normalizeRegion(r, opts = {}, W, H) {
    const al = alignRegion(r, opts.unit ?? DEFAULT_OPTS.unit, W, H);
    const min = opts.minSize ?? DEFAULT_OPTS.minSize;
    if (al.w < min || al.h < min) return null;
    return al;
}

/** 上限策略：网页端硬上限 12（超了就打不进元数据；详见 MOB.addRegion / IA.parseMeta） */
export function capRegions(regions, cap = DEFAULT_OPTS.cap, policy = DEFAULT_OPTS.capPolicy) {
    if (regions.length <= cap) return { kept: regions, dropped: [] };
    const key = policy === 'area' ? (r) => r.w * r.h : (r) => r.score ?? 0;
    const sorted = regions.slice().sort((a, b) => key(b) - key(a));
    const kept = sorted.slice(0, cap);
    const dropped = sorted.slice(cap);
    // 保持"区域内顺序 = 用户看到的顺序"，并按分数降序输出（与 kept 一致）
    return { kept, dropped };
}

/* ──────────────────────────── 6. 一步到位的高层入口 ──────────────────────────── */

/**
 * 单个模型的原始输出 → 原图坐标的候选框（未合并、未扩张、未对齐）
 *
 * letterbox 的取法（**多尺度混用时的关键**）：模型结果自带 `m.letterbox` 就用它 ——
 * runModel() 知道这次实际送进去的尺寸（ONNX 静态输入形状），所以"哪个模型用哪个尺度"
 * 由结果自己带回来，调用方不用猜；只有结果没带时才用这一轮统一给的 lb。
 *
 * 分块偏移（`m.crop` / `lb.crop`）：大图按 planTiles 切块时，模型看到的是一块局部图，
 * 它输出的一切坐标都是**块内坐标**，所以换算回原图后要加上块的左上角。
 * @param {object} m 模型推理结果：{preds, dims, protos?, protoDims?, task, classes, id, letterbox?, crop?, tile?}
 */
export function modelToCandidates(m, lb, W, H, opts = {}) {
    const l = m.letterbox || lb;
    if (!l) throw new Error('detect-core: 缺少 letterbox（模型结果没带，调用方也没给）—— 无法把框换算回原图');
    const cr = m.crop || l.crop || null;
    const ox = cr ? cr.x : 0, oy = cr ? cr.y : 0;
    // 掩膜系数的个数由"有没有原型张量"决定，不靠通道数反推（纯检测模型就是 0）
    const numMask = m.numMask ?? (m.protos ? 32 : 0);
    const { detections } = decodeDetections(m.preds, m.dims, Object.assign({}, opts, { numMask }));
    const kept = nmsClassAware(detections, opts.iou ?? DEFAULT_OPTS.iou);
    const out = [];
    kept.forEach((d, i) => {
        const label = (m.classes && m.classes[d.cls]) || ('class' + d.cls);
        let box = from640(d.box, l, W, H);
        let kind = 'box';
        if (m.task === 'segment' && m.protos) {
            const mb = maskToBox(d, m.protos, m.protoDims, l, W, H, opts.maskThr ?? DEFAULT_OPTS.maskThr);
            if (mb) { box = mb.box; kind = 'mask'; }
        }
        if (ox || oy) {          // 块内坐标 → 原图坐标
            box = [clamp(box[0] + ox, 0, W), clamp(box[1] + oy, 0, H),
                   clamp(box[2] + ox, 0, W), clamp(box[3] + oy, 0, H)];
        }
        // ── 钳子约束（只在分块时生效）─────────────────────────────────────────
        // 窗口就是"钳子"：块内的检出若越出窗口边界，一律**钳回窗口内** ——
        // 绝不外扩到"这块根本没看过"的像素上。被钳过就记 clipped，
        // 合并时同组里若还有完整的那个，代表会换成完整的（见 mergeBySource）。
        let clipped = false;
        if (cr && opts.tileClamp !== false) {
            const x1 = clamp(box[0], cr.x, cr.x + cr.w), y1 = clamp(box[1], cr.y, cr.y + cr.h);
            const x2 = clamp(box[2], cr.x, cr.x + cr.w), y2 = clamp(box[3], cr.y, cr.y + cr.h);
            clipped = (x1 !== box[0] || y1 !== box[1] || x2 !== box[2] || y2 !== box[3]);
            box = [x1, y1, x2, y2];
        }
        if (box[2] - box[0] < 1 || box[3] - box[1] < 1) return;
        out.push({ box, score: d.score, cls: d.cls, label, src: m.id, kind, order: i,
                   tile: (m.tile ?? null), clipped });
    });
    return out;
}

/**
 * 多模型输出 → 最终区域（合并 → 扩张 → 对齐 → 上限）
 * 返回 { regions, dropped, stats }，regions 里带 label/score/src/source 等**展示字段**，
 * 编码前请用 encodeProjection() 只取 x/y/w/h。
 *
 * @param {Array} models 各模型的推理结果；`lb` 只是"结果里没带 letterbox 时"的兜底，
 *   正常情况下每个结果自带（见 modelToCandidates），所以**可以混用不同尺度**的模型。
 */
export function buildRegions(models, lb, W, H, opts = {}) {
    const o = Object.assign({}, DEFAULT_OPTS, opts);
    const candidates = [];
    const perModel = [];
    for (const m of models) {
        // m.candidates 存在 = 这一项**已经解码过**（分块路径每块跑完就解码，避免把所有
        // 块的原始张量攒到最后：@1280 单块的 protos 就是 12.5 MiB，54 块约 1 GB 堆）
        const c = m.candidates || modelToCandidates(m, lb, W, H, o);
        perModel.push({ id: m.id, count: c.length, imgsz: (m.letterbox && m.letterbox.size) || null,
                        tile: (m.tile ?? null), crop: (m.crop || (m.letterbox && m.letterbox.crop)) || null });
        candidates.push(...c);
    }
    let grouped = mergeBySource(candidates, o);
    if (o.expandApply !== false) {
        grouped = grouped.map((g) => Object.assign({}, g, {
            box: expandBox(g.box, o.expand || { mode: 'scale', factor: 1 }, W, H),
        }));
    }
    let regions = [];
    for (const g of grouped) {
        const r = normalizeRegion({ x: g.box[0], y: g.box[1], w: g.box[2] - g.box[0], h: g.box[3] - g.box[1] }, o, W, H);
        if (!r) continue;
        regions.push(Object.assign(r, {
            label: g.label, score: +g.score.toFixed(3), src: g.src, kind: g.kind,
            merged: g.merged, mergedWith: g.mergedWith, sources: g.sources, tiles: g.tiles || [],
            clipped: !!g.clipped, clampedSeen: !!g.clampedSeen, repSwitched: g.repSwitched || 0,
        }));
    }
    const { kept, dropped } = capRegions(regions, o.cap, o.capPolicy);
    return {
        regions: kept, dropped,
        stats: {
            candidates: candidates.length, grouped: grouped.length,
            kept: kept.length, dropped: dropped.length, cap: o.cap,
            // 分块扫描的读数：跑了几块 + 有几处是"跨接缝、被合并成一处"的
            tiled: models.some((m) => m.tile !== null && m.tile !== undefined),
            tilesRun: models.filter((m) => m.tile !== null && m.tile !== undefined).length,
            crossTile: kept.filter((r) => (r.tiles || []).length > 1).length,
            // 钳子读数：最终框仍被钳的（可能不完整）/ 组里见过被钳的 / 因此改判代表的
            clamped: kept.filter((r) => r.clipped).length,
            clampedSeen: kept.filter((r) => r.clampedSeen).length,
            repSwitched: kept.filter((r) => (r.repSwitched || 0) > 0).length,
            perModel, options: o,
        },
    };
}

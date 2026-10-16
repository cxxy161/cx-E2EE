/* ═══════════════════════════════════════════════════════════════════
 * 自动打框 · 纯逻辑测试（Node 直跑，不需要浏览器 / 模型 / GPU）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 覆盖：
 *   T1  letterbox 换算（比例/偏移 + 往返）
 *   T2  输出解码：分割（32 掩膜系数）/ 纯检测（0 系数）/ 通道数不匹配必须抛错
 *   T3  类内 NMS：**不同类别之间不互相压制**（同一处被多类各框一次是常态）
 *   T4  掩膜 → 外接框（合成原型，构造已知矩形）
 *   T5  真实模型输出 fixture：与 ultralytics 自己的 predict() 对照（跨实现验证）
 *   T6  跨模型合并：near / union / none
 *   T7  扩张：等比缩放 / 固定像素 / 贴边钳制 / 最小尺寸
 *   T8  整块对齐：与 pV3（image-crypto.js 1418–1425 行）的独立实现逐条对照
 *   T9  上限 12：两种取舍策略 + 丢弃项可追溯
 *   T10 标签/来源/分数**不进编码字段**（编码只认 x/y/w/h，签名因此不受影响）
 *   T11 端到端：两个模型（seg + bbox）→ buildRegions → 区域满足网页端全部硬约束
 *   T12 多尺度：模型结果自带的 letterbox 优先（混选 640/960 不错换算）；缺 lb 必须抛错
 *   T13 大图分块：窗口计划（全覆盖 / 半步位移 / 贴图内 / 块数）
 *   T14 分块坐标：块内 → 原图（crop 偏移）
 *   T15 跨块合并：接缝上的同一处只留一个框，且记录来自哪几块
 *   T16 钳子约束：块内检出钳回窗口；同组里完整的框当代表（避免半截高分框）
 *
 * 运行： node test/detect/detect-core.test.mjs
 *        FIXTURE=<路径>   换一份 fixture（默认 test/detect/fixtures/bbox-foot-640.json）
 *
 * fixture 说明：`bbox-foot-640.json` 是**真实模型在真实图片上的原始输出**裁到前 64 个锚点
 * （只含数字、不含图片），由 tools/detect-make-fixture.py 生成，可重跑复核。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    DEFAULT_OPTS, ENCODED_FIELDS, letterbox, from640, decodeDetections, nmsClassAware, iou,
    containment, maskToBox, mergeBySource, expandBox, expandRegions, alignRegion, normalizeRegion,
    capRegions, modelToCandidates, buildRegions, encodeProjection,
    planTiles, tileCount,
} from '../../src/detect/detect-core.mjs';

/* ── 迷你测试框架（与 test/stego 保持一致） ── */
let pass = 0, fail = 0; const failures = [];
function ok(cond, name, extra = '') {
    if (cond) { pass++; } else { fail++; failures.push(name + (extra ? '  :: ' + extra : '')); }
}
const eq = (a, b, name) => ok(a === b, name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (a, b, tol, name) => ok(Math.abs(a - b) <= tol, name, `got ${a} want ${b}±${tol}`);
const boxNear = (a, b, tol, name) => ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), name,
    `${JSON.stringify(a.map(v => +v.toFixed(2)))} vs ${JSON.stringify(b)}`);
const iouOf = (a, b) => iou(a, b);

const HERE = dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
console.log('detect-core 纯逻辑测试 · 不需要浏览器/模型\n');

/* ═══ T1 letterbox ═══ */
{
    const a = letterbox(1152, 1920);
    eq(a.r.toFixed(6), (1 / 3).toFixed(6), 'T1 1152×1920 的比例 = 1/3');
    eq(a.nw, 384, 'T1 nw=384'); eq(a.nh, 640, 'T1 nh=640');
    eq(a.dw, 128, 'T1 dw=128（横向居中）'); eq(a.dh, 0, 'T1 dh=0');

    const b = letterbox(1000, 500);
    eq(b.r.toFixed(2), '0.64', 'T1 1000×500 的比例 = 0.64');
    eq(b.dw, 0, 'T1 宽边贴合 dw=0'); eq(b.dh, 160, 'T1 纵向居中 dh=160');

    // 往返：整个 letterbox 区域映射回原图 = 整张图
    const back = from640([b.dw, b.dh, b.dw + b.nw, b.dh + b.nh], b, 1000, 500);
    boxNear(back, [0, 0, 1000, 500], 1e-9, 'T1 letterbox 框往返回到整图');

    // 越界要钳制而不是给负值
    const clamped = from640([-100, -100, 9999, 9999], a, 1152, 1920);
    boxNear(clamped, [0, 0, 1152, 1920], 1e-9, 'T1 越界框被钳制到图内');
}

/* ═══ T2 输出解码 ═══ */
{
    // 手搓 [1, 4+nc+32, anchors] 张量：nc=2, anchors=5
    const anchors = 5, nc = 2, numMask = 32, C = 4 + nc + numMask;
    const preds = new Float32Array(C * anchors);
    const set = (c, i, v) => { preds[c * anchors + i] = v; };
    // 通道 0/1/2/3 = cx/cy/w/h —— 注意通道下标是常量，别把它写成锚点下标
    const putBox = (i, cx, cy, w, h) => { set(0, i, cx); set(1, i, cy); set(2, i, w); set(3, i, h); };
    putBox(0, 100, 200, 40, 20); set(4, 0, 0.90); set(5, 0, 0.10);   // 类 0
    putBox(1, 101, 201, 40, 20); set(4, 1, 0.85); set(5, 1, 0.05);   // 与 0 几乎重合 → NMS 会压掉
    putBox(2, 500, 500, 60, 60); set(4, 2, 0.10); set(5, 2, 0.70);   // 类 1，别处
    putBox(3, 300, 300, 10, 10); set(4, 3, 0.05); set(5, 3, 0.02);   // 低于阈值
    putBox(4, 500, 500, 60, 60); set(4, 4, 0.20); set(5, 4, 0.65);   // 类 1，与 2 重合 → NMS 压掉
    set(4 + nc + 0, 0, 1.5);                                          // 掩膜系数（只验搬运）

    const { detections, nc: gotNc } = decodeDetections(preds, [1, C, anchors], { conf: 0.30, numMask });
    eq(gotNc, 2, 'T2 从通道数推出 nc=2');
    eq(detections.length, 4, 'T2 阈值 0.30 留下 4 个锚点（解码阶段不做 NMS）');
    eq(nmsClassAware(detections, 0.45).length, 2, 'T2 类内 NMS 之后剩 2 个（每类一个）');
    eq(detections[0].cls, 0, 'T2 锚点 0 判为类 0');
    eq(detections[0].coeffs.length, 32, 'T2 掩膜系数 32 个');
    near(detections[0].coeffs[0], 1.5, 1e-6, 'T2 掩膜系数被正确搬运（列优先索引）');
    boxNear(detections[0].box, [80, 190, 120, 210], 1e-4, 'T2 xywh → xyxy');

    // 纯检测模型：没有掩膜系数（numMask=0），通道数只有 4+nc
    const C2 = 4 + 3, pr2 = new Float32Array(C2 * 2);
    for (let i = 0; i < 2; i++) { pr2[0 * 2 + i] = 10 + i; pr2[1 * 2 + i] = 20; pr2[2 * 2 + i] = 4; pr2[3 * 2 + i] = 4; }
    pr2[4 * 2 + 0] = 0.9; pr2[6 * 2 + 1] = 0.8;
    const d2 = decodeDetections(pr2, [1, C2, 2], { conf: 0.3, numMask: 0 });
    eq(d2.nc, 3, 'T2 纯检测模型 nc=3');
    eq(d2.detections.length, 2, 'T2 纯检测模型两个锚点都保留');
    eq(d2.detections[0].coeffs, null, 'T2 纯检测模型没有掩膜系数（null 而不是全 0 数组）');

    // 通道数算不出正数类别时必须抛错，而不是静默产出垃圾框
    let threw = '';
    try { decodeDetections(new Float32Array(3 * 4), [1, 3, 4], { numMask: 0 }); } catch (e) { threw = e.message; }
    ok(/不匹配/.test(threw), 'T2 通道数不匹配必须抛错', threw);
}

/* ═══ T3 类内 NMS ═══ */
{
    const same = { box: [0, 0, 100, 100], score: 0.9, cls: 0 };
    const other = { box: [0, 0, 100, 100], score: 0.8, cls: 1 };   // 完全重合但类别不同
    const kept = nmsClassAware([same, other], 0.45);
    eq(kept.length, 2, 'T3 不同类别的重合框互不压制');

    const dup = { box: [2, 2, 98, 98], score: 0.7, cls: 0 };
    const kept2 = nmsClassAware([same, dup], 0.45);
    eq(kept2.length, 1, 'T3 同类别的重合框只留分高的');
    near(kept2[0].score, 0.9, 1e-6, 'T3 留下的是分数高的那个');

    // 结果顺序必须确定（同分时按原始下标）
    const tied = nmsClassAware([{ box: [0, 0, 10, 10], score: 0.5, cls: 0 },
                                { box: [500, 500, 510, 510], score: 0.5, cls: 0 }], 0.45);
    eq(tied.length, 2, 'T3 同分不互相压制');
}

/* ═══ T4 掩膜 → 外接框 ═══ */
{
    const pw = 8, ph = 8, K = 32;
    const protos = new Float32Array(K * ph * pw).fill(-2);       // 背景：sigmoid(-2)≈0.12
    for (let y = 3; y <= 6; y++) for (let x = 2; x <= 5; x++) protos[y * pw + x] = 2;  // sigmoid(2)≈0.88
    const coeffs = new Float32Array(K); coeffs[0] = 1;           // 只用第 0 个原型
    const det = { box: [0, 0, 640, 640], score: 0.9, cls: 0, coeffs };
    const lb = letterbox(640, 640);                              // r=1, dw=dh=0
    const mb = maskToBox(det, protos, [1, K, ph, pw], lb, 640, 640, 0.5);
    // 掩膜块 x=2..5 → 640 坐标 160..400；y=3..6 → 240..480
    boxNear(mb.box, [160, 240, 400, 480], 1e-6, 'T4 掩膜外接框落点正确（640 正方图）');
    eq(mb.hits, 16, 'T4 命中 16 个掩膜像素');

    // 换成 1152×1920 的图：同样的掩膜要按 letterbox 换算成原图坐标
    const lb2 = letterbox(1152, 1920);
    const mb2 = maskToBox(det, protos, [1, K, ph, pw], lb2, 1152, 1920, 0.5);
    boxNear(mb2.box, [(160 - 128) * 3, 240 * 3, (400 - 128) * 3, 480 * 3], 1e-6, 'T4 掩膜外接框换算到原图坐标');

    // 全背景 → 没有命中，返回 null（调用方据此退回检测框）
    const empty = new Float32Array(K * ph * pw).fill(-2);
    eq(maskToBox(det, empty, [1, K, ph, pw], lb, 640, 640, 0.5), null, 'T4 掩膜为空时返回 null');
    eq(maskToBox(det, null, null, lb, 640, 640, 0.5), null, 'T4 没有原型张量时返回 null');
}

/* ═══ T5 真实 fixture 对照 ═══ */
{
    const fixPath = process.env.FIXTURE || join(HERE, 'fixtures', 'bbox-foot-640.json');
    const fx = JSON.parse(readFileSync(fixPath, 'utf8'));
    const buf = Buffer.from(fx.preds_b64, 'base64');
    const preds = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const { W, H } = fx.image;
    const lb = letterbox(W, H, fx.imgsz);
    const model = {
        id: fx.model, task: fx.task, classes: fx.classes, dims: fx.dims,
        preds, protos: null, numMask: fx.numMask ?? 0,
    };
    console.log(`  T5 fixture：${fx.model} 在 ${W}×${H} 上，裁剪 ${fx.dims[2]} 个锚点，`
        + `参考框 ${fx.reference.boxes.length} 个（${fx.reference.source}）`);

    const cands = modelToCandidates(model, lb, W, H, { conf: 0.30 });
    console.log('     本实现检出：' + JSON.stringify(cands.map(c => ({
        cls: c.label, score: +c.score.toFixed(3), box: c.box.map(v => +v.toFixed(1)),
    }))));

    ok(cands.length >= fx.reference.boxes.length, 'T5 检出数不少于参考框数',
        `${cands.length} vs ${fx.reference.boxes.length}`);
    let allMatched = true, allTight = true;
    const marks = [];
    fx.reference.boxes.forEach((rb, i) => {
        const best = Math.max(...cands.map(c => iouOf(c.box, rb)));
        const clsOk = cands.some(c => iouOf(c.box, rb) === best && Number(fx.classes[c.cls]) === undefined
            ? true : c.cls === fx.reference.classes[i]);
        marks.push(`${i}: IoU ${best.toFixed(3)}`);
        if (best < 0.90) allMatched = false;
        if (!clsOk) allTight = false;
    });
    ok(allMatched, 'T5 每个参考框都能被本实现复现（IoU ≥ 0.90）', marks.join(', '));
    ok(allTight, 'T5 类别判定与 ultralytics 一致');

    // 反向：本实现不能凭空多出对不上的框
    const spurious = cands.filter(c => Math.max(...fx.reference.boxes.map(rb => iouOf(c.box, rb))) < 0.30);
    eq(spurious.length, 0, 'T5 没有凭空多出的框', JSON.stringify(spurious.map(s => s.box)));

    // 阈值边界：参考里最低分那个框，其分数略高于 0.30，所以阈值 0.35 应当把它去掉
    const lowConf = Math.min(...fx.reference.scores);
    const hi = modelToCandidates(model, lb, W, H, { conf: lowConf + 0.05 });
    ok(hi.length < cands.length, 'T5 提高阈值会减少检出（阈值确实生效）',
        `${hi.length} < ${cands.length}（最低参考分 ${lowConf}）`);
}

/* ═══ T6 跨模型合并 ═══ */
{
    const items = [
        { box: [100, 100, 200, 200], score: 0.90, cls: 1, label: 'pussy', src: 'm1', order: 0 },
        { box: [104, 104, 204, 204], score: 0.50, cls: 2, label: 'anus', src: 'm2', order: 1 },   // 与上者 IoU≈0.74
        { box: [600, 600, 700, 700], score: 0.80, cls: 0, label: 'nipples', src: 'm2', order: 2 },
    ];
    ok(iou(items[0].box, items[1].box) > 0.3, 'T6 构造的两个框确实重叠');

    const nearG = mergeBySource(items, { merge: 'near', mergeIou: 0.30 });
    eq(nearG.length, 2, 'T6 near：重叠的两处合并成一处');
    eq(nearG[0].label, 'pussy', 'T6 near：保留分数高的标签');
    eq(nearG[0].merged, 1, 'T6 near：记录被合并掉 1 个');
    ok(nearG[0].mergedWith.some(s => s.includes('anus')), 'T6 near：可追溯被合并的来源');
    eq(nearG[0].box.join(','), '100,100,200,200', 'T6 near：保留高分框本身（不并成一个更大的框）');

    const unionG = mergeBySource(items, { merge: 'union', mergeIou: 0.30 });
    eq(unionG.length, 2, 'T6 union：同样是两处');
    eq(unionG[0].box.join(','), '100,100,204,204', 'T6 union：合并成一个外接框');

    const noneG = mergeBySource(items, { merge: 'none' });
    eq(noneG.length, 3, 'T6 none：不做跨类合并');

    // 包含关系：小框几乎完全落在大框里，也算同一处
    const contain = mergeBySource([
        { box: [0, 0, 100, 100], score: 0.9, cls: 0, label: 'a', src: 'm1', order: 0 },
        { box: [10, 10, 40, 40], score: 0.4, cls: 1, label: 'b', src: 'm2', order: 1 },
    ], { merge: 'near', mergeIou: 0.9, mergeContain: 0.8 });
    eq(contain.length, 1, 'T6 near：小框被包含也算同一处（阈值靠 mergeContain 兜）');
}

/* ═══ T7 扩张 ═══ */
{
    boxNear(expandBox([100, 100, 200, 200], { mode: 'scale', factor: 1.5 }, 1000, 1000),
        [75, 75, 225, 225], 1e-9, 'T7 等比 1.5×（绕中心）');
    boxNear(expandBox([100, 100, 200, 200], { mode: 'pad', pad: 10 }, 1000, 1000),
        [90, 90, 210, 210], 1e-9, 'T7 固定外扩 10px');
    boxNear(expandBox([100, 100, 200, 200], { mode: 'scale', factor: 1 }, 1000, 1000),
        [100, 100, 200, 200], 1e-9, 'T7 1.0× 是恒等变换');
    boxNear(expandBox([0, 0, 20, 20], { mode: 'scale', factor: 2 }, 50, 50),
        [0, 0, 30, 30], 1e-9, 'T7 贴左上角扩张后仍被钳制在图内');
    boxNear(expandBox([30, 30, 50, 50], { mode: 'pad', pad: 100 }, 50, 50),
        [0, 0, 50, 50], 1e-9, 'T7 外扩超过画布时钳到整图');

    const rs = expandRegions([{ x: 100, y: 100, w: 100, h: 100, label: 'x' }], { mode: 'scale', factor: 2 }, 1000, 1000);
    eq(rs[0].w, 200, 'T7 批量扩张改的是 w/h');
    eq(rs[0].label, 'x', 'T7 扩张保留展示字段（标签不会丢）');

    // 注意：整块对齐是"向外取整"，3px 的小框会被撑成 1 个完整块（=8px），这是 pV3 的既有行为
    eq(normalizeRegion({ x: 0, y: 0, w: 3, h: 3 }, DEFAULT_OPTS, 100, 100).w, 8, 'T7 小框被对齐撑成整块');
    eq(normalizeRegion({ x: 120, y: 0, w: 10, h: 10 }, DEFAULT_OPTS, 100, 100), null, 'T7 完全在图外的框被丢弃');
    eq(normalizeRegion({ x: 0, y: 0, w: 3, h: 3 }, { unit: 8, minSize: 16 }, 100, 100), null,
        'T7 minSize 生效（对齐后 8px < 16px → 丢弃）');
    ok(normalizeRegion({ x: 1, y: 1, w: 20, h: 20 }, DEFAULT_OPTS, 100, 100) !== null, 'T7 正常尺寸保留');
}

/* ═══ T8 整块对齐（与 pV3 同口径） ═══ */
{
    // 独立实现（照 image-crypto.js 1418–1425 行重写一遍，用来对照，避免"实现与测试一起错"）
    const ref = (r, unit, W, H) => {
        const rx2 = Math.floor(r.x / unit) * unit;
        const ry2 = Math.floor(r.y / unit) * unit;
        const rw2 = Math.max(0, Math.floor((Math.min(W - rx2, Math.ceil(r.w / unit) * unit)) / unit) * unit);
        const rh2 = Math.max(0, Math.floor((Math.min(H - ry2, Math.ceil(r.h / unit) * unit)) / unit) * unit);
        return { x: rx2, y: ry2, w: rw2, h: rh2 };
    };
    const cases = [
        { x: 552, y: 704, w: 192, h: 216 },          // 已对齐
        { x: 601, y: 585, w: 96, h: 88 },            // 非整块
        { x: 0, y: 0, w: 1152, h: 1920 },            // 整图
        { x: 1140, y: 1900, w: 30, h: 30 },          // 贴右下角（越界）
        { x: 7, y: 7, w: 1, h: 1 },                  // 极小
        { x: 960, y: 1600, w: 193, h: 321 },         // 尾巴不足一块
    ];
    let mism = 0;
    for (const unit of [8, 16]) {
        for (const c of cases) {
            const got = alignRegion(c, unit, 1152, 1920);
            const want = ref(c, unit, 1152, 1920);
            if (got.x !== want.x || got.y !== want.y || got.w !== want.w || got.h !== want.h) {
                mism++;
                ok(false, `T8 unit=${unit} ${JSON.stringify(c)}`,
                    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
            }
        }
    }
    eq(mism, 0, `T8 与 pV3 规则逐条一致（unit=8/16 × ${cases.length} 组用例）`);
    eq(alignRegion({ x: 1140, y: 1900, w: 30, h: 30 }, 8, 1152, 1920).w, 16,
        'T8 贴右边界：x 落到 1136，右边余 16px → 2 个完整块（不越界）');
    eq(alignRegion({ x: 1150, y: 0, w: 10, h: 10 }, 8, 1152, 1920).w, 8, 'T8 只剩 2px 尾巴时回落到 1 个块');
    eq(alignRegion({ x: 601, y: 585, w: 96, h: 88 }, 8, 1152, 1920).x, 600, 'T8 x 向左对齐到块边界');
}

/* ═══ T9 上限 12 ═══ */
{
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ x: i * 8, y: 0, w: 8, h: 8, score: i / 100 }));
    const byScore = capRegions(mk(15), 12, 'score');
    eq(byScore.kept.length, 12, 'T9 按分数保留 12 个');
    eq(byScore.dropped.length, 3, 'T9 丢弃 3 个且可追溯');
    ok(byScore.kept[0].score > byScore.kept[11].score, 'T9 按分数降序');

    const big = Array.from({ length: 15 }, (_, i) => ({ x: 0, y: 0, w: 8 * (i + 1), h: 8, score: 0.5 }));
    const byArea = capRegions(big, 12, 'area');
    eq(byArea.kept.length, 12, 'T9 按面积保留 12 个');
    eq(byArea.kept[0].w, 8 * 15, 'T9 按面积降序（最大的在前）');
    eq(capRegions(mk(5), 12).kept.length, 5, 'T9 不足上限时原样返回');
}

/* ═══ T10 标签不进编码字段 ═══ */
{
    const r = { x: 8, y: 16, w: 32, h: 48, label: 'pussy', score: 0.881, src: 'ntd11', kind: 'mask' };
    const p = encodeProjection(r);
    eq(Object.keys(p).sort().join(','), 'h,w,x,y', 'T10 编码投影只有 x/y/w/h');
    eq(ENCODED_FIELDS.join(','), 'x,y,w,h', 'T10 ENCODED_FIELDS 与元数据编码器读的字段一致');
    // 逐字段确认没有别的键混进去（元数据的签名只由坐标决定，标签变了不会影响解密）
    let extra = 0;
    for (const k of Object.keys(p)) if (!ENCODED_FIELDS.includes(k)) extra++;
    eq(extra, 0, 'T10 没有任何额外字段进入编码');
}

/* ═══ T11 端到端：seg + bbox 两个模型 ═══ */
{
    const anchors = 6, nc = 2, numMask = 32, C = 4 + nc + numMask;
    const mkPreds = (rows) => {
        const p = new Float32Array(C * anchors);
        rows.forEach((r, i) => {
            p[i] = r[0]; p[anchors + i] = r[1]; p[2 * anchors + i] = r[2]; p[3 * anchors + i] = r[3];
            p[4 * anchors + i] = r[4]; p[5 * anchors + i] = r[5];
        });
        return p;
    };
    // seg 模型：类 1（pussy）在 640 坐标 (320,320) 处给两个重复锚点 + 类 0 在图内另一处。
    // 坐标必须落在 letterbox 的"图像区"内（本图图像区是 x 128..512, y 0..640），
    // 落在灰色填充带里会被钳成零宽框而丢弃 —— 这也正是实现该有的行为。
    const segPreds = mkPreds([
        [320, 320, 60, 60, 0.30, 0.88],
        [322, 321, 60, 60, 0.28, 0.80],
        [200, 150, 40, 40, 0.75, 0.10],
        [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
    ]);
    // 掩膜系数：第 0 号原型 + 掩膜落在检测框内 → 才能走"掩膜外接框"这条路
    [0, 1].forEach(i => { segPreds[(4 + nc + 0) * anchors + i] = 1; });
    // 掩膜网格用 32×32（真实分割模型是 160×160）：太粗的网格会让"掩膜外接框"整格溢出检测框，
    // 那是合成数据的假象，不是实现问题。格子里放一块与检测框大致重合的掩膜。
    const pw = 32, ph = 32, K = 32;
    const protos = new Float32Array(K * ph * pw).fill(-2);
    for (let y = 14; y <= 17; y++) for (let x = 14; x <= 17; x++) protos[y * pw + x] = 2;

    // bbox 模型（纯检测）：同一处又框了一次（跨模型重复），外加一个自己的目标
    const C2 = 4 + 2;
    const bboxPreds = new Float32Array(C2 * 2);
    const put = (i, cx, cy, w, h, s0, s1) => {
        bboxPreds[i] = cx; bboxPreds[2 + i] = cy; bboxPreds[4 + i] = w; bboxPreds[6 + i] = h;
        bboxPreds[8 + i] = s0; bboxPreds[10 + i] = s1;
    };
    put(0, 330, 330, 70, 70, 0.10, 0.70);   // 与 seg 那处重叠 → 应被合并
    put(1, 430, 500, 80, 80, 0.90, 0.05);   // bbox 自己的目标（同样必须在图像区内）

    const W = 1152, H = 1920;
    const lb = letterbox(W, H);
    const out = buildRegions([
        { id: 'seg1', task: 'segment', classes: { 0: 'nipples', 1: 'pussy' }, dims: [1, C, anchors], preds: segPreds, protos, protoDims: [1, K, ph, pw], numMask },
        { id: 'bbox1', task: 'detect', classes: { 0: 'nipples', 1: 'pussy' }, dims: [1, C2, 2], preds: bboxPreds, numMask: 0 },
    ], lb, W, H, { conf: 0.30, merge: 'near', cap: 12, unit: 8, minSize: 8 });

    console.log('  T11 区域：' + JSON.stringify(out.regions.map(r => ({
        label: r.label, src: r.src, kind: r.kind, score: r.score, box: [r.x, r.y, r.w, r.h],
    }))));
    eq(out.stats.perModel.length, 2, 'T11 两个模型都参与了');
    eq(out.regions.length, 3, 'T11 三处：seg/bbox 重叠的那处已合并 + 各自另外一处');
    ok(out.regions.length <= 12, 'T11 不超过网页端硬上限 12');
    ok(out.regions.every(r => r.x % 8 === 0 && r.y % 8 === 0 && r.w % 8 === 0 && r.h % 8 === 0),
        'T11 每个区域的坐标/尺寸都是 8 的整数倍（与 pV3 同口径）');
    ok(out.regions.every(r => r.w >= 8 && r.h >= 8), 'T11 每个区域都不小于 8×8');
    ok(out.regions.every(r => typeof r.label === 'string' && r.src), 'T11 每个区域都带标签与来源（供页面标明）');
    ok(out.regions.some(r => r.kind === 'mask'), 'T11 分割模型的区域来自掩膜');
    ok(out.regions.some(r => r.kind === 'box' && r.src === 'bbox1'), 'T11 纯检测模型的区域来自框');
    ok(out.regions.some(r => (r.sources || []).length === 2), 'T11 存在被两个模型同时命中的区域（已合并并记录来源）');
    // 扩张仍然生效且不破坏对齐
    const ex = buildRegions([{
        id: 'bbox1', task: 'detect', classes: { 0: 'x' }, dims: [1, C2, 2], preds: bboxPreds, numMask: 0,
    }], lb, W, H, { conf: 0.30, expand: { mode: 'scale', factor: 1.5 } });
    const base = buildRegions([{
        id: 'bbox1', task: 'detect', classes: { 0: 'x' }, dims: [1, C2, 2], preds: bboxPreds, numMask: 0,
    }], lb, W, H, { conf: 0.30 });
    ok(ex.regions[0].w >= base.regions[0].w && ex.regions[0].h >= base.regions[0].h,
        'T11 1.5× 扩张后区域变大', `${ex.regions[0].w}×${ex.regions[0].h} vs ${base.regions[0].w}×${base.regions[0].h}`);
    ok(ex.regions[0].x % 8 === 0 && ex.regions[0].w % 8 === 0, 'T11 扩张后仍然对齐到 8 的整数倍');
}

/* ═══ T12 多尺度（imgsz 跟随模型，而不是写死 640） ═══
 *
 * 背景（实测）：同一份权重、同一张 1664×2432 的图，imgsz=640 时该部位只有 0.076（漏检），
 * imgsz=960 时 0.873（检到）。所以 ONNX 会按 640 / 960 各导一份（id 带 @960 后缀），
 * 用户可能**同时勾选两个尺度**。这里守住两件事：
 *   1) 每个模型结果自带的 letterbox 优先 —— 混选尺度时框不会换算错；
 *   2) 结果没带、调用方也没给 → 必须抛错，不能静默按 640 换算（那才是真正的错框）。
 */
{
    const W = 1152, H = 1920;
    const anchors = 4, C = 4 + 2 + 32, K = 32;
    const mk = (cx, cy, w, h, cls, score) => {
        const p = new Float32Array(C * anchors);
        p[0] = cx; p[anchors] = cy; p[2 * anchors] = w; p[3 * anchors] = h;
        p[(4 + cls) * anchors] = score;
        return p;
    };
    // 同一个"图像位置"（1152×1920 中心偏上）在两种尺度下的 640/960 坐标
    const lb640 = letterbox(W, H, 640), lb960 = letterbox(W, H, 960);
    const c640 = (x) => (x * lb640.r + lb640.dw), c960 = (x) => (x * lb960.r + lb960.dw);
    const preds640 = mk(c640(400), c640(500), 40 * lb640.r, 40 * lb640.r, 1, 0.8);
    const preds960 = mk(c960(400), c960(500), 40 * lb960.r, 40 * lb960.r, 1, 0.8);
    const protoSmall = new Float32Array(K * 4 * 4).fill(-1);

    // 混选：一个 640 的构建 + 一个 960 的构建，都带自己的 letterbox
    const withLb = buildRegions([
        { id: 'seg@640', task: 'segment', classes: { 1: 'pussy' }, dims: [1, C, anchors], preds: preds640,
          protos: protoSmall, protoDims: [1, K, 4, 4], numMask: 32, letterbox: lb640 },
        { id: 'seg@960', task: 'segment', classes: { 1: 'pussy' }, dims: [1, C, anchors], preds: preds960,
          protos: protoSmall, protoDims: [1, K, 4, 4], numMask: 32, letterbox: lb960 },
    ], null, W, H, { conf: 0.3, merge: 'none', cap: 12, unit: 8, minSize: 8 });
    eq(withLb.regions.length, 2, 'T12 两个尺度的模型各出一处（没有传兜底 lb 也能跑）');
    // 两处都落在同一个图像位置附近（容差 = 框宽的一半：掩膜外接框本来就有量化误差）
    const d = Math.abs(withLb.regions[0].x - withLb.regions[1].x);
    ok(d <= 40, 'T12 两种尺度的框都换算回同一个图像位置', `Δx=${d}`);
    eq(withLb.stats.perModel[0].imgsz, 640, 'T12 perModel 记下第 1 个模型的尺度');
    eq(withLb.stats.perModel[1].imgsz, 960, 'T12 perModel 记下第 2 个模型的尺度');

    // 只有全局 lb 时（老调用路径）→ 仍按全局 lb 换算，且结果与"模型自带同一个 lb"一致
    const globalOnly = buildRegions([
        { id: 'seg@640', task: 'segment', classes: { 1: 'pussy' }, dims: [1, C, anchors], preds: preds640,
          protos: protoSmall, protoDims: [1, K, 4, 4], numMask: 32 },
    ], lb640, W, H, { conf: 0.3, merge: 'none', cap: 12, unit: 8, minSize: 8 });
    eq(globalOnly.regions[0].x, withLb.regions[0].x, 'T12 兜底 lb 与自带 lb 等价（老调用不受影响）');

    // 关键防线：一个 960 的模型结果被错传了 640 的全局 lb → 结果必然偏，所以宁可抛错
    let threw = false;
    try {
        buildRegions([
            { id: 'seg@960', task: 'detect', classes: { 1: 'pussy' }, dims: [1, C, anchors], preds: preds960, numMask: 32 },
        ], null, W, H, { conf: 0.3 });
    } catch (e) { threw = /letterbox/.test(e.message); }
    ok(threw, 'T12 两个来源都没有 letterbox 时抛错（不静默按 640 换算）');
}

/* ═══ T13 大图分块（半步扫描）：窗口计划 ═══
 *
 * 目标不是"切得漂亮"，而是三条硬约束：
 *   1) 全覆盖 —— 每个像素至少落在一个窗口里（不然那块就是盲区）；
 *   2) 半步   —— 相邻窗口位移 = size/2（重叠 50%），保证"最长边 ≤ size/2 的部位"
 *               至少有一个窗口能让它完整出现（接缝不丢的关键）；
 *   3) 不越界 —— 末列/末行向内贴，窗口全在图内，且除"整图不足一格"外都是 size×size。
 */
{
    const p = planTiles(1664, 2432, { size: 1280, overlap: 0.5 });
    eq(p.step, 640, 'T13 step = size/2（半步）');
    eq(p.cols, 2, 'T13 1664 宽 → 2 列');
    eq(p.rows, 3, 'T13 2432 高 → 3 行');
    eq(p.count, 6, 'T13 共 6 块');
    ok(p.tiles.every((t) => t.w === 1280 && t.h === 1280), 'T13 每块都是 1280×1280');
    ok(p.tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= 1664 && t.y + t.h <= 2432),
        'T13 每块都在图内（向内贴边）');
    // 全覆盖：把每个像素盖一次，不能有 0
    const cov = new Uint8Array(1664 * 2432);
    for (const t of p.tiles) for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) cov[y * 1664 + x] = 1;
    eq(cov.indexOf(0), -1, 'T13 全图无盲区（每个像素都被至少一块覆盖）');
    // 半步的实质：图内任意一点，至少有一块把它连同"半个窗口的邻域"一起装进去
    // —— 等价判据：任意 (x,y) 都存在一块满足 t.x ≤ x 且 x+size/2 ≤ t.x+t.w（x 方向同理）
    // 只检查"图内还能放下半个窗口"的位置：贴到图像右缘时本来就没有右侧像素可放，
    // 那是图像边界（不是接缝）问题
    let seamOk = true;
    for (let x = 0; x <= 1664 - 640 && seamOk; x++) {
        if (!p.tiles.some((t) => t.x <= x && x + 640 <= t.x + t.w)) seamOk = false;
    }
    ok(seamOk, 'T13 x 方向：任意位置向右半步都有窗口装得下（接缝不丢的充要条件）');

    // 两个方向都不超过窗口 → 只有 1 块（也就是整图，等价于以前的老路径）
    const small = planTiles(1152, 1200, { size: 1280, overlap: 0.5 });
    eq(small.count, 1, 'T13 图两个方向都 ≤ 窗口 → 只有 1 块（整图）');
    eq(small.tiles[0].w, 1152, 'T13 该块宽度 = 图宽');
    eq(small.tiles[0].h, 1200, 'T13 该块高度 = 图高');
    // 只有一个方向超过窗口：只在那一个方向切（1152×1920 @1280 → 竖向 2 块）
    const tall = planTiles(1152, 1920, { size: 1280, overlap: 0.5 });
    eq(tall.count, 2, 'T13 1152×1920 @1280 → 竖向 2 块');
    ok(tall.tiles.every((t) => t.w === 1152 && t.h === 1280), 'T13 两块都是 1152×1280');
    eq(tall.tiles[1].y, 640, 'T13 第二块 y=640（向内贴到图底）');

    const huge = planTiles(4024, 6048, { size: 1280, overlap: 0.5 });
    eq(huge.count, 54, 'T13 4024×6048 @1280 → 54 块（6×9）');
    const huge640 = planTiles(4024, 6048, { size: 640, overlap: 0.5 });
    eq(huge640.count, 216, 'T13 同图 @640 → 216 块（尺度越小块越多）');
    eq(tileCount(4024, 6048, { size: 1280 }), 54, 'T13 tileCount 与 planTiles 一致');
    eq(planTiles(800, 600, { size: 640, overlap: 0.5 }).count, 2, 'T13 800×600 @640：宽向 2 块、高向 1 块');
}

/* ═══ T14 分块坐标：块内 → 原图 ═══ */
{
    const W = 1664, H = 2432;
    const plan = planTiles(W, H, { size: 1280, overlap: 0.5 });
    const anchors = plan.tiles.length;
    // 造一个"块内中心处"的检出（纯检测模型，省掉掩膜），检查它落到原图的哪个位置
    const C = 4 + 2, mkDet = () => {
        const p = new Float32Array(C * anchors);
        const cx = 640, cy = 640, w = 100, h = 100;      // 块内 640 坐标系（1280 输入的几何中心）
        p[0] = cx; p[anchors] = cy; p[2 * anchors] = w; p[3 * anchors] = h;
        p[(4 + 1) * anchors] = 0.9;                       // 类别 1
        return p;
    };
    const lbt = (t) => Object.assign(letterbox(t.w, t.h, 1280), { crop: { x: t.x, y: t.y, w: t.w, h: t.h } });
    // 取"中间那块"（x 有偏移、y 有偏移），验证偏移真的加上了
    const t = plan.tiles.find((q) => q.x > 0 && q.y > 0);
    const r = buildRegions([{ id: 'm', task: 'detect', classes: { 1: 'pussy' }, dims: [1, C, anchors],
                              preds: mkDet(), numMask: 0, letterbox: lbt(t), crop: t, tile: 0 }],
        null, W, H, { conf: 0.3, merge: 'none', cap: 12, unit: 8, minSize: 8 });
    eq(r.regions.length, 1, 'T14 块内一处检出 → 原图一处');
    // 期望：块内 640-坐标的 640 中心（1280 输入的几何中心）→ 块内 (t.w/2, t.h/2) → 原图 + 偏移
    near(r.regions[0].x, Math.floor((t.x + t.w / 2 - 50) / 8) * 8, 8, 'T14 加上块偏移后的 x 落在原图对应位置');
    near(r.regions[0].y, Math.floor((t.y + t.h / 2 - 50) / 8) * 8, 8, 'T14 加上块偏移后的 y 落在原图对应位置');
    eq(r.stats.perModel[0].tile, 0, 'T14 perModel 记下块号');
    ok(r.stats.tiled, 'T14 stats.tiled = true');
    // 不给 crop 的结果（整图路径）偏移必须是 0：坐标只由 letterbox 决定
    const r0 = buildRegions([{ id: 'm', task: 'detect', classes: { 1: 'pussy' }, dims: [1, C, anchors],
                               preds: mkDet(), numMask: 0, letterbox: letterbox(W, H, 1280), tile: null }],
        null, W, H, { conf: 0.3, merge: 'none', cap: 12, unit: 8, minSize: 8 });
    ok(r0.regions[0].x < r.regions[0].x, 'T14 无偏移的整图路径坐标更靠左上（偏移确实生效了）');
    ok(!r0.stats.tiled, 'T14 整图路径 stats.tiled = false');
}

/* ═══ T15 跨块合并：接缝上的同一处只能变成一个框 ═══ */
{
    const W = 1664, H = 2432;
    const plan = planTiles(W, H, { size: 1280, overlap: 0.5 });
    const anchors = 2, C = 4 + 2;
    // 同一个"原图里的部位"（跨在两块接缝上）在两个相邻块里各被检出一次：
    //   A 块里它偏右下，B 块里它偏左上 —— 块内坐标不同，但换算回原图是同一处
    const px = 660, py = 700, pw = 120, ph = 120;          // 原图坐标
    // 第一行的前两块（1664 宽、窗口 1280 → x = 0 与 x = 384，重叠 896 —— 接缝正落在两者之间）
    const row0 = plan.tiles.filter((q) => q.y === 0);
    const tA = row0[0], tB = row0[1];
    eq(tA.x, 0, 'T15 第一块 x=0'); eq(tB.x, 384, 'T15 第二块 x=384（末列向内贴）');
    const mkAt = (t) => {
        const lb = letterbox(t.w, t.h, 1280), c = lb.r;
        const cx = (px - t.x + pw / 2) * c + lb.dw, cy = (py - t.y + ph / 2) * c + lb.dh;
        const p = new Float32Array(C * anchors);
        p[0] = cx; p[anchors] = cy; p[2 * anchors] = pw * c; p[3 * anchors] = ph * c;
        p[(4 + 0) * anchors] = 0.8;
        return { id: 'm', task: 'detect', classes: { 0: 'nipples' }, dims: [1, C, anchors], preds: p,
                 numMask: 0, letterbox: Object.assign(lb, { crop: { x: t.x, y: t.y, w: t.w, h: t.h } }),
                 crop: t, tile: plan.tiles.indexOf(t) };
    };
    const out = buildRegions([mkAt(tA), mkAt(tB)], null, W, H,
        { conf: 0.3, merge: 'near', cap: 12, unit: 8, minSize: 8 });
    eq(out.regions.length, 1, 'T15 相邻两块检到的同一处 → 合并成 1 个框');
    eq(out.stats.crossTile, 1, 'T15 stats.crossTile 记下"跨块合并 1 处"');
    eq((out.regions[0].tiles || []).length, 2, 'T15 该框记录了它来自 2 个块');
    eq(out.stats.tilesRun, 2, 'T15 tilesRun = 2');
    // 合并后的框仍落在原图那个位置（不是被偏移推到别处）
    near(out.regions[0].x, Math.floor(px / 8) * 8, 8, 'T15 合并后的 x 仍在原图原位');
    near(out.regions[0].y, Math.floor(py / 8) * 8, 8, 'T15 合并后的 y 仍在原图原位');
    // 反向验证：关掉合并（merge='none'）时就是两个框 —— 说明合并这一步真的在起作用
    const raw = buildRegions([mkAt(tA), mkAt(tB)], null, W, H, { conf: 0.3, merge: 'none', cap: 12, unit: 8, minSize: 8 });
    eq(raw.regions.length, 2, 'T15 merge=none 时保留 2 个框（对照）');
}

/* ═══ T16 钳子约束：块内检出钳回窗口；同组里完整的框当代表 ═══
 *
 * 用户口径：「只要模型能在一定程度上无损识别全要素即可；比窗口大的要素就不覆盖了」。
 * 于是分块的两条硬规矩：
 *   a) 块内的检出**不得越出窗口**（那是"这块根本没看过"的像素）；
 *   b) 同一处若既被某块切过、又在另一块里完整出现，代表必须换成**完整的那个** ——
 *      否则会出现"被切掉一半却分数更高"的框当代表，打码区域就偏小。
 */
{
    const W = 1664, H = 2432;
    const plan = planTiles(W, H, { size: 1280, overlap: 0.5 });
    const tA = plan.tiles[0];                       // x=0,y=0,w=1280,h=1280（右边界 1280）
    const tB = plan.tiles.find((q) => q.x === 384 && q.y === 0);
    const anchors = 2, C = 4 + 2;
    const mkIn = (t, x, y, w, h, score) => {        // 把一个"原图坐标的框"放进某一块的 640 坐标系
        const lb = letterbox(t.w, t.h, 1280);
        const cx = (x - t.x + w / 2) * lb.r + lb.dw, cy = (y - t.y + h / 2) * lb.r + lb.dh;
        const p = new Float32Array(C * anchors);
        p[0] = cx; p[anchors] = cy; p[2 * anchors] = w * lb.r; p[3 * anchors] = h * lb.r;
        p[(4 + 0) * anchors] = score;
        return p;
    };
    const res = (t, tile, preds) => ({
        id: 'm', task: 'detect', classes: { 0: 'nipples' }, dims: [1, C, anchors], preds, numMask: 0,
        letterbox: Object.assign(letterbox(t.w, t.h, 1280), { crop: { x: t.x, y: t.y, w: t.w, h: t.h } }),
        crop: t, tile,
    });

    // a) 只在一个块里：目标横跨窗口右边界（原图 1100..1400，窗口右边界 1280）→ 必须被钳到 1280
    const one = buildRegions([res(tA, 0, mkIn(tA, 1100, 1100, 300, 300, 0.95))], null, W, H,
        { conf: 0.3, merge: 'near', cap: 12, unit: 8, minSize: 8 });
    eq(one.regions[0].x + one.regions[0].w, 1280, 'T16 钳子：框不越出窗口右边界（正好停在 1280）');
    eq(one.stats.clamped, 1, 'T16 stats.clamped 记下"被钳过 1 处"');
    ok(one.regions[0].clipped, 'T16 该区域带 clipped 标记');

    // b) 同一处：A 块里被切（分数高 0.95）、B 块里完整（分数低 0.60）→ 代表换成 B 的框
    //    目标 (1100,900,300,300)：x 方向跨过 A 的右边界 1280，y 方向完整落在两块里
    const both = buildRegions([res(tA, 0, mkIn(tA, 1100, 900, 300, 300, 0.95)),
                               res(tB, 1, mkIn(tB, 1100, 900, 300, 300, 0.60))], null, W, H,
        { conf: 0.3, merge: 'near', cap: 12, unit: 8, minSize: 8 });
    eq(both.regions.length, 1, 'T16 两块的同一处 → 合并成 1 个框');
    eq(both.stats.repSwitched, 1, 'T16 代表从"被钳的高分框"换成了"完整的框"');
    ok(both.regions[0].w >= 296, 'T16 合并后的框是完整的那个（≈300 宽，而不是被切到 180）', `w=${both.regions[0].w}`);
    ok(!both.regions[0].clipped, 'T16 该处不再算"被钳过"（组里有完整框）');
    ok((both.regions[0].tiles || []).length === 2, 'T16 记录了这一处来自 2 块');

    // 对照：关掉钳子（tileClamp=false）时框会越出窗口 —— 证明钳子确实在起作用
    const noClamp = buildRegions([res(tA, 0, mkIn(tA, 1100, 1100, 300, 300, 0.95))], null, W, H,
        { conf: 0.3, merge: 'near', cap: 12, unit: 8, minSize: 8, tileClamp: false });
    ok(noClamp.regions[0].x + noClamp.regions[0].w > 1280, 'T16 tileClamp=false 时确实会越出窗口（对照）');
}

/* ═══ 结论 ═══ */
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n' + '═'.repeat(68));
if (fail === 0) {
    console.log(`✅ 全通：${pass} 项断言，耗时 ${dt}s`);
} else {
    console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项，耗时 ${dt}s`);
    for (const f of failures) console.log('   ✗ ' + f);
}
console.log('═'.repeat(68));
process.exit(fail === 0 ? 0 : 1);

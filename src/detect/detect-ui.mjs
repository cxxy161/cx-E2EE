/**
 * detect-ui.mjs — 「🧠 自动打框」面板（折叠式：左侧选模型、右侧调扩张）
 *
 * 解耦原则（**刻意不碰 src/image-crypto.js**）
 * ------------------------------------------
 * · 只通过 MOB 的公开方法工作：addRegion / norm / renderList / draw / undo。
 *   `MOB.addRegion(reg)` 内部会 `this.norm(reg)` 生成新对象，所以区域对象要等它 push 完
 *   再从 `MOB.regions[last]` 取引用，用 WeakMap 挂"标签/来源/分数"——**不动源码一行**。
 * · 标签只画在覆盖层上：包一层 MOB.draw（先调原函数，再画标签），不侵入它的绘制逻辑。
 * · 标签/来源/分数**不参与编码**（元数据只写 x/y/w/h，签名同理），所以显示怎么改都不会
 *   影响解密，也不会破坏与网页端/ComfyUI 移植件的互通 —— 这一点由 detect-core 的单测守着。
 * · 依赖用显式握手拿到（window.__CX_DETECT），避免"经典脚本的顶层 const 能不能被模块看见"
 *   这种依赖运行时细节的猜测。
 *
 * 失败一律降级：没有服务端（GitHub Pages / 单文件版）、没装 python、没有模型时，
 * 面板只显示原因，不影响加密/解密。
 */

import {
    letterbox, buildRegions, expandRegions, normalizeRegion, capRegions, encodeProjection,
    planTiles, tileCount, DEFAULT_OPTS,
} from './detect-core.mjs';
// detect-ort.mjs（连同 ORT 运行时）**故意不在这里静态 import**：
// 它只在这块功能真的被用到时才需要，静态 import 会让每个访客的首屏都多拉一份模块。
// 首屏只留 detect-core（纯数学，约 10KB）与 1KB 的 deps.js。
let _ort = null;
async function ort() {
    if (!_ort) _ort = await import('./detect-ort.mjs');
    return _ort;
}

const deps = () => (window.__CX_DETECT || {});
const $ = (id) => document.getElementById(id);
const toast = (m) => { const T = deps().T; if (typeof T === 'function') T(m); };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** WeakMap：区域对象 → 展示信息（对象被 splice/pop 掉后自动回收，不留垃圾） */
const LABELS = new WeakMap();

const LS = {
    open: 'cx-abox-open', models: 'cx-abox-models', params: 'cx-abox-params',
};
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ } };

const state = {
    payload: null,        // /api/detect/models 的返回
    ep: null,             // 'webgpu' | 'wasm'
    busy: false,
    chosen: new Set(readLS(LS.models, [])),
    base: null,           // 扩张前的基准（x/y/w/h + 标签）
    baseSig: null,
    sig: null,            // 上一步写入的区域签名，用于"还原扩张"的二次确认
    confirmUntil: 0,
    lastRun: null,
    lastUrl: null,
};

/* ───────────────────────── 参数（持久化） ───────────────────────── */

const params = Object.assign(
    // showClass 默认 false：实测同一处会被多个类各框一次（pussy/anus 会互相抢位置），
    // 类别名**不能**当功能依据，所以默认只显示「敏感部位」；想看原始类别名可以在面板上打开。
    { mode: 'scale', factor: 1.25, pad: 16, target: 'all', merge: 'near', conf: 0.30,
      capPolicy: 'score', showClass: false, tile: 'auto' },
    readLS(LS.params, {}),
);

/** 展示用标签：默认抹掉具体部位名，只在悬停时给原文（title） */
function displayLabel(info) {
    const raw = (info && info.label) || '';
    return params.showClass ? raw : '敏感部位';
}

/**
 * 当前的对齐单元：必须与 pV3 用的一致，否则"面板写的"与"实际打的"会差最多 8px。
 *   pV3 的 PNG 路径 unit=8；JPEG(qv3<100) 走 J2 拍屏码，unit=16。
 * 所以这里读一下"输出格式"滑杆，而不是写死。
 */
function currentUnit() {
    const q = $('qv3');
    return q && parseInt(q.value, 10) < 100 ? 16 : 8;
}

function opts() {
    return Object.assign({}, DEFAULT_OPTS, {
        conf: params.conf,
        merge: params.merge,
        cap: DEFAULT_OPTS.cap,          // 网页端硬上限，不给用户改
        unit: currentUnit(), minSize: 8,
        expandApply: true,
        expand: { mode: params.mode, factor: params.factor, pad: params.pad },
    });
}

/* ───────────────────────── 面板渲染 ───────────────────────── */

function setStatus(text, kind) {
    const el = $('abox-st');
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'bad' ? '#d9534f' : (kind === 'ok' ? '#3a9d5d' : '#7d9ac0');
}

/**
 * 一律用 textContent / DOM 节点拼装，**禁止 innerHTML**。
 * 这里曾是 `el.innerHTML = html`，而 html 里嵌着服务端返回的文件名、模型 id、类别名
 * （来自第三方 .pt 的 model.names）与模型报错文本 —— 那是可以在这页执行脚本的注入点，
 * 而这一页正好持有用户的明文与密码。
 */
function setMsg(...parts) {
    const box = $('abox-msg');
    if (!box) return;
    box.textContent = '';
    for (const p of parts) {
        if (p == null) continue;
        box.append(typeof p === 'string' ? document.createTextNode(p) : p);
    }
}

/** 建节点：文本走 textContent、属性走 setAttribute 语义（都不解析 HTML）。
 *  取名 mk 而不是 el，避免和本文件里多处局部的 `const el = $(...)` 撞名。 */
function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
}

/** 「重新扫描」按钮（原来是靠 innerHTML 拼出来再 getElementById 找回来） */
function rescanBtn() {
    const b = mk('button', 'abox-link', '重新扫描');
    b.addEventListener('click', (e) => { e.preventDefault(); rescan(); });
    return b;
}

function open(force) {
    const box = $('abox');
    const isOpen = typeof force === 'boolean' ? force : !box.classList.contains('open');
    box.classList.toggle('open', isOpen);
    $('abox-bd').style.display = isOpen ? 'block' : 'none';
    writeLS(LS.open, isOpen);
    if (isOpen) loadModels();
}

async function loadModels() {
    const D = deps();
    if (D.StaticHost && D.StaticHost.is) {
        setStatus('静态托管下不可用', 'bad');
        setMsg('本页部署在纯静态站点（无后端）：没有服务端转译与模型路由。要用自动打框请用自托管方式打开本站（',
            mk('code', null, 'npm start'), '）。');
        $('abox-models').textContent = '';
        $('abox-run').disabled = true;
        return;
    }
    try {
        const res = await fetch('/api/detect/models', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        state.payload = await res.json();
    } catch (e) {
        setStatus('后端不可用', 'bad');
        setMsg('取不到 ', mk('code', null, '/api/detect/models'), '（' + e.message +
            '）。自托管服务端才有这个接口；静态托管请忽略本面板。');
        $('abox-run').disabled = true;
        return;
    }
    // 先确定后端再渲染：列表里的体积是"当前后端会用到的那个变体"，
    // 而 state.ep 需要异步探测（WebGPU 有没有适配器），顺序反了会显示成另一种变体的体积
    const bi = await (await ort()).backendInfo();
    if (!state.ep) state.ep = bi.webgpu ? 'webgpu' : 'wasm';
    renderModels(bi);
}

function renderModels(backend) {
    const p = state.payload;
    const box = $('abox-models');
    if (!p) return;
    const ready = p.models.filter((m) => m.status === 'ready');
    const pending = p.models.filter((m) => m.status === 'converting' || m.status === 'pending');
    const failed = p.models.filter((m) => m.status === 'error');

    const bi = backend || { webgpu: false, adapter: null };
    const epTxt = state.ep === 'webgpu' ? 'WebGPU' : 'WASM';
    if (!p.available) setStatus('不可用（' + (p.python.missing || []).join(',') + '）', 'bad');
    else if (pending.length) setStatus(`转换中 ${pending.length} 个…`);
    else setStatus(ready.length ? `就绪 ${ready.length} 个 · ${epTxt}` : '没有模型', ready.length ? 'ok' : 'bad');
    if (ready.length) {
        const sel = ready.filter((m) => state.chosen.has(m.id));
        setMsg(`后端 ${epTxt}${bi.adapter ? '（' + bi.adapter + '）' : ''} · 已选 ${sel.length} 个模型` +
            (sel.length ? '' : '（勾选左侧模型后点「开始自动识别」）') + '。' +
            '识别在本机进行，图片不会上传。');
        // 有就绪模型、但 python 不可用：只影响「.pt 能不能现场转译」，已就绪的构建照常能跑。
        // 不说明的话，用户会以为整个功能坏了 —— 这正是随库附带资产后最容易踩的误解。
        if (p.python && !p.python.ok) {
            const note = document.createElement('div');
            note.style.marginTop = '4px';
            note.textContent = '注意：本机 python 缺 ' +
                ((p.python.missing || []).join(', ') || '依赖') +
                '，因此 .pt 不会现场转译；上面已就绪的 ONNX 构建不受影响，可以直接勾选。';
            const msgBox = $('abox-msg');
            if (msgBox) msgBox.appendChild(note);
        }
    }

    if (!p.models.length) {
        box.textContent = '';
        setMsg((p.hint || '还没有模型。'), mk('br'),
            '把权重放进 ', mk('code', null, 'models/detect/segm/'), '（分割）或 ',
            mk('code', null, 'models/detect/bbox/'), '（检测）后，', rescanBtn(), '。');
        return;
    }

    for (const m of p.models) {
        const v = state.ep === 'webgpu' ? ['fp32', 'int8'] : ['int8', 'fp32'];
        const pick = v.find((k) => m.files[k]);
        const mb = pick ? (m.files[pick].bytes / 1048576).toFixed(1) + 'MB' : '—';
        const cls = Object.keys(m.classes || {}).length;

        const label = mk('label', 'abox-mi');
        const cb = mk('input');
        cb.type = 'checkbox';
        cb.dataset.mid = m.id;
        cb.checked = state.chosen.has(m.id);
        if (m.status !== 'ready') cb.disabled = true;
        cb.onchange = () => {
            if (cb.checked) state.chosen.add(m.id); else state.chosen.delete(m.id);
            writeLS(LS.models, [...state.chosen]);
            renderScaleRow();                 // 尺度跟着选择变
        };
        label.appendChild(cb);
        label.appendChild(mk('span', 'abox-kind', m.kind === 'segm' ? '分割' : '检测'));
        label.appendChild(mk('span', 'abox-name', m.id));
        // 尺度徽标：一个 ONNX 只能服务一个输入边长，所以"选哪个尺度"= 勾哪个模型
        const px = mk('span', 'abox-px', (m.imgsz || 640) + 'px');
        px.title = '该构建的输入边长（导出时写死的静态形状）';
        label.appendChild(px);
        if (m.status !== 'ready') {
            label.appendChild(mk('span', 'abox-err', m.status === 'error' ? '转译失败' : '转换中'));
        }
        label.appendChild(mk('span', 'abox-size', (cls ? cls + ' 类 · ' : '') + mb));
        if (m.status === 'error') label.title = String(m.error || '').slice(0, 300);
        box.appendChild(label);
    }

    if (pending.length || failed.length) {
        const tip = mk('div', 'v3-tip');
        tip.style.marginTop = '6px';
        if (failed.length) tip.appendChild(mk('span', null, failed.length + ' 个转译失败（悬停看原因）· '));
        tip.appendChild(rescanBtn());
        box.appendChild(tip);
    }
    renderScaleRow();
}

/**
 * 「识别尺度」行的文案：**不是**一个能改模型的开关（ONNX 静态形状改不了），
 * 而是"这次会按什么尺度跑"的显式说明 + 怎么加一个更高尺度的构建。
 * 想换尺度就去 models/detect/build/ 里放一份 <id>@<imgsz> 的构建（一条命令，
 * 见 docs/detect-auto-box.md），然后勾它。
 */
function renderScaleRow() {
    const el = $('abox-scale');
    if (!el) return;
    const p = state.payload;
    if (!p) { el.textContent = '—'; return; }
    const sel = p.models.filter((m) => m.status === 'ready' && state.chosen.has(m.id));
    const sizes = [...new Set(sel.map((m) => m.imgsz || 640))].sort((a, b) => a - b);
    if (!sel.length) {
        const avail = [...new Set(p.models.filter((m) => m.status === 'ready').map((m) => m.imgsz || 640))].sort((a, b) => a - b);
        el.textContent = avail.length ? `未选模型（可选 ${avail.join(' / ')}px）` : '未选模型';
        el.title = '勾选左侧模型后，这里显示本次推理所用的输入边长';
        return;
    }
    const W0 = (deps().MOB && deps().MOB.natW) || 0, H0 = (deps().MOB && deps().MOB.natH) || 0;
    const plan = W0 ? (planSummary(W0, H0) || []) : [];
    const tinfo = plan.map((q) => q.tiled ? `${q.size}px→${q.count}块${q.tooMany ? '(超上限)' : ''}` : `${q.size}px整图`);
    el.textContent = sizes.map((s) => s + 'px').join(' + ') + (sizes.length > 1 ? '（各自尺度）' : '') +
        ' · ' + (sel.length > 1 ? sel.length + ' 个模型' : sel[0].id) +
        (tinfo.length ? ' · ' + tinfo.join(' / ') : '');
    el.title = 'ONNX 的输入形状是导出时写死的：一个构建只服务一个尺度。' +
        '尺度越高，大图里的小部位越不容易丢（实测 1664×2432 的图：640 下该部位 0.08、960 下 0.87）。' +
        '要加更高尺度：python tools/detect-export.py --src <权重.pt> --imgsz 960（会在 build/ 里生成 <id>@960），再点「重新扫描」。';
}

async function rescan() {
    setStatus('重新扫描中…');
    try {
        const res = await fetch('/api/detect/rescan', { method: 'POST' });
        state.payload = await res.json();
        renderModels(await (await ort()).backendInfo());
        toast('已重新扫描模型目录');
    } catch (e) { setStatus('扫描失败', 'bad'); toast('扫描失败：' + e.message); }
}

/* ───────────────────────── 覆盖层标签（包一层 MOB.draw） ───────────────────────── */

function patchDraw(D) {
    const MOB = D.MOB;
    if (!MOB || MOB.__cxLabelPatched) return;
    const orig = MOB.draw;
    MOB.draw = function patched() {
        const r = orig.apply(this, arguments);
        try { drawLabels.call(this); } catch (e) { /* 标签只是装饰，画不出来不影响使用 */ }
        return r;
    };
    MOB.__cxLabelPatched = true;
}

function drawLabels() {
    const MOB = deps().MOB;
    if (!MOB || !MOB.img || !MOB.natW) return;
    const ov = $('pv3-ov');
    if (!ov) return;
    const stage = $('v3-stage').getBoundingClientRect();
    if (!stage.width) return;
    const c = ov.getContext('2d');
    const sx = stage.width / MOB.natW, sy = stage.height / MOB.natH;
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    MOB.regions.forEach((reg, i) => {
        const info = LABELS.get(reg);
        if (!info) return;
        const x = reg.x * sx, y = reg.y * sy;
        // 文字**与用户当前的选择一致**（默认不写部位名，只标"自动"区分模型框与手绘框）
        const txt = params.showClass
            ? `${info.label}${info.score != null ? ' ' + info.score : ''}`
            : '自动';
        c.font = 'bold 11px system-ui,sans-serif';
        const w = c.measureText(txt).width + 8;
        c.fillStyle = 'rgba(255,64,64,.85)';
        c.fillRect(x, Math.max(0, y - 15), w, 14);
        c.fillStyle = '#fff';
        c.fillText(txt, x + 4, Math.max(11, y - 4));
    });
}

/* ───────────────────────── 区域写入 / 来源清单 ───────────────────────── */

const sigOf = (regions) => regions.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join('|');

function addRegionWithInfo(reg, info) {
    const MOB = deps().MOB;
    const before = MOB.regions.length;
    MOB.addRegion({ x: reg.x, y: reg.y, w: reg.w, h: reg.h });
    if (MOB.regions.length > before) {
        // addRegion 内部 norm() 会生成新对象，所以标签要挂在 push 进去的那个对象上
        LABELS.set(MOB.regions[MOB.regions.length - 1], info);
        return true;
    }
    return false;   // 撞上 12 个上限（MOB.addRegion 自己会 toast）
}

function renderSourceList() {
    const box = $('abox-src');
    if (!box) return;
    box.textContent = '';
    const MOB = deps().MOB;
    const rows = [];
    (MOB ? MOB.regions : []).forEach((reg, i) => {
        const info = LABELS.get(reg);
        if (!info) return;
        const from = (info.sources && info.sources.length > 1 ? info.sources.join('+') : info.src) || '';
        const cross = (info.tiles && info.tiles.length > 1) ? ' · 跨块 ×' + info.tiles.length : '';
        const clam = info.clipped ? ' · 可能不完整（大于窗口）'
            : (info.repSwitched ? ' · 已取完整框' : (info.clampedSeen ? ' · 曾钳回窗口' : ''));
        const raw = (info.label || '') + (info.score != null ? ' ' + info.score : '');

        const row = mk('div', 'abox-si');
        row.title = '模型原始类别：' + (raw || '（无）');   // 走属性，不解析标签
        row.appendChild(mk('b', null, '#' + (i + 1)));
        row.appendChild(mk('span', null,
            (info.kind === 'mask' ? '掩膜外接框' : '检测框') + ' · ' + displayLabel(info) +
            (params.showClass && info.score != null ? ' ' + info.score : '') + ' · ' + from + cross + clam));
        const geo = mk('span', null, reg.w + '×' + reg.h + ' @ (' + reg.x + ',' + reg.y + ')');
        geo.style.marginLeft = 'auto';
        row.appendChild(geo);
        rows.push(row);
    });
    if (!rows.length) return;
    box.appendChild(mk('div', 'v3-tip', '已添加区域（只读标注，具体部位名仅供参考）'));
    for (const r of rows) box.appendChild(r);
}

function renderRunSummary() {
    const r = state.lastRun;
    if (!r) return;
    const sc = (r.scales && r.scales.length) ? [...new Set(r.scales)].join('/') + 'px' : '—';
    const st2 = r.out.stats || {};
    const tiled = st2.tiled
        ? `分块 ${st2.tilesRun} 块（重叠 ${Math.round(DEFAULT_OPTS.tileOverlap * 100)}%` +
          `${st2.crossTile ? `，跨块合并 ${st2.crossTile} 处` : '，无跨块'}` +
          `${st2.clampedSeen ? `，钳回窗口 ${st2.clampedSeen} 处` : ''}` +
          `${st2.repSwitched ? `（其中 ${st2.repSwitched} 处改用完整框）` : ''}` +
          `${st2.clamped ? `，仍有 ${st2.clamped} 处大于窗口、只覆盖到部分` : ''})`
        : '整图（未分块）';
    const parts = ['识别 ' + r.ready + ' 个模型 → 候选 ' + r.out.stats.candidates +
        ' → 合并 ' + r.out.stats.grouped + ' 处 → 写入 ' + r.added + ' 个区域'];
    if (r.overflow > 0) parts.push('，', mk('b', null, r.overflow + ' 个因为 12 个上限被丢弃'));
    parts.push('。本机推理 ' + r.ms.toFixed(1) + ' s，图片未上传。', mk('br'),
        '尺度：' + sc + ' · ' + tiled + ' · 扩张：' +
        (params.mode === 'scale' ? params.factor.toFixed(2) + '×' : params.pad + 'px') +
        ' · 合并：' + ({ near: '邻近', union: '外接框', none: '不合并' })[params.merge] +
        ' · 标注：' + (params.showClass ? '显示类别名' : '只标敏感部位') +
        ' · 对齐：' + currentUnit() + 'px（' + (currentUnit() === 16 ? 'JPEG/J2' : 'PNG') + '）');
    setMsg(...parts);
}

/* ───────────────────────── 主流程：自动识别 ───────────────────────── */

async function run() {
    const D = deps();
    const MOB = D.MOB;
    if (state.busy) return;
    if (!MOB || !MOB.img) { toast('先载入原图'); return; }
    if (!state.payload || !state.payload.available) { toast('自动打框不可用（看面板提示）'); return; }
    const ready = state.payload.models.filter((m) => m.status === 'ready' && state.chosen.has(m.id));
    if (!ready.length) { toast('先勾选至少一个已就绪的模型'); return; }

    state.busy = true;
    $('abox-run').disabled = true;
    const t0 = now();
    const W = MOB.natW, H = MOB.natH;
    // 兜底 letterbox（只用于"结果没带 letterbox"的模型）；正常路径下每个结果自带
    // 自己那次推理用的 lb，所以混选 640/960 的模型也不会把框换算错。
    const lb = letterbox(W, H, (ready[0] && ready[0].imgsz) || 640);
    try {
        const outputs = [];
        const diagnostics = [];
        const plans = [];
        // 每个模型各自决定"整图跑"还是"切块跑"：大图分块 = 半步扫描（重叠 50%）
        for (const m of ready) {
            const size = m.imgsz || 640;
            const on = tileDecision(params.tile, W, H, size);
            const plan = on ? planTiles(W, H, { size, overlap: DEFAULT_OPTS.tileOverlap })
                            : { size, step: 0, overlap: 0, cols: 1, rows: 1, count: 1,
                                tiles: [{ x: 0, y: 0, w: W, h: H }] };
            if (plan.count > DEFAULT_OPTS.tileMax) {
                toast(`${m.id}：这张图要切 ${plan.count} 块，超过上限 ${DEFAULT_OPTS.tileMax}，已跳过（换成更大的尺度即可）`);
                plans.push({ id: m.id, size, tiled: on, count: plan.count, skipped: true });
                continue;
            }
            plans.push({ id: m.id, size, tiled: on, count: plan.count, cols: plan.cols, rows: plan.rows,
                         step: plan.step, overlap: plan.overlap });
            for (let t = 0; t < plan.tiles.length; t++) {
                const done = outputs.length;
                setStatus(plan.count > 1
                    ? `识别中（${m.id} · 第 ${t + 1}/${plan.count} 块）…`
                    : `识别中（${outputs.length + 1}/${ready.length}）…`);
                const r = await (await ort()).runModel(m, MOB.img, {
                    ep: state.ep, runtimeDir: undefined,
                    size,                        // 只是提示：真正以 ONNX 的静态输入形状为准
                    crop: plan.count > 1 ? plan.tiles[t] : null,
                    tile: plan.count > 1 ? t : null,
                    onProgress: (p) => setStatus(p.stage === 'fetch' ? `载入模型 ${m.id}…` : `建会话 ${m.id}…`),
                });
                outputs.push(r);
                diagnostics.push({ id: m.id, variant: r.variant, backend: r.backend,
                    bytes: r.bytes, compileMs: r.compileMs, ms: r.ms, tile: r.tile,
                    size: r.size, sizeSource: r.sizeSource, sizeHint: r.sizeHint, onnxDims: r.onnxDims });
                void done;
            }
        }
        if (!outputs.length) { toast('没有可跑的模型（都被块数上限挡下了）'); return; }
        const out = buildRegions(outputs, lb, W, H, opts());
        const slots = DEFAULT_OPTS.cap - MOB.regions.length;
        if (slots <= 0) { toast('已有 12 个区域，先删掉一些再识别'); return; }

        let added = 0;
        for (const r of out.regions.slice(0, slots)) {
            if (addRegionWithInfo(r, {
                label: r.label, score: r.score, src: r.src, kind: r.kind,
                merged: r.merged, sources: r.sources, tiles: r.tiles,
                clipped: r.clipped, clampedSeen: r.clampedSeen, repSwitched: r.repSwitched,
            })) added++;
        }
        const overflow = out.regions.length - added;
        state.sig = sigOf(MOB.regions);
        state.lastRun = { ready: ready.length, out, added, overflow, ms: (now() - t0) / 1000,
            scales: diagnostics.map((d) => d.size), plans };
        renderSourceList();
        const tileTxt = out.stats.tiled
            ? ` · 分块 ${out.stats.tilesRun}${out.stats.crossTile ? `（跨块合并 ${out.stats.crossTile} 处）` : ''}` +
              `${out.stats.clampedSeen ? `（钳回 ${out.stats.clampedSeen} 处）` : ''}`
            : '';
        setStatus(`已添加 ${added} 个区域（${ep0()} · ${[...new Set(diagnostics.map((d) => d.size))].join('/')}px${tileTxt}）`, 'ok');
        renderRunSummary();
        renderScaleRow();
        toast(`已添加 ${added} 个自动区域`);
        console.log('CXABOX ' + JSON.stringify({
            stage: 'detect', ep: state.ep, W, H, chosen: ready.map((m) => m.id),
            scales: [...new Set(diagnostics.map((d) => d.size))],
            plans, tiled: out.stats.tiled, tilesRun: out.stats.tilesRun, crossTile: out.stats.crossTile,
            clamped: out.stats.clamped, clampedSeen: out.stats.clampedSeen, repSwitched: out.stats.repSwitched,
            candidates: out.stats.candidates, grouped: out.stats.grouped, added, overflow,
            dropped: out.dropped.length,
            regions: out.regions.map((r) => Object.assign(encodeProjection(r),
                { label: r.label, score: r.score, src: r.src, kind: r.kind, sources: r.sources,
                  tiles: r.tiles, clipped: r.clipped, clampedSeen: r.clampedSeen, repSwitched: r.repSwitched })),
            perModel: out.stats.perModel, timings: diagnostics,
            totalMs: +(now() - t0).toFixed(0),
        }));
    } catch (e) {
        setStatus('识别失败', 'bad');
        setMsg('识别失败：' + (e && e.message ? e.message : e));
        console.error('[abox]', e);
        console.log('CXABOX ' + JSON.stringify({ stage: 'error', error: String(e && e.message || e) }));
    } finally {
        state.busy = false;
        $('abox-run').disabled = false;
    }
}

const ep0 = () => (state.ep === 'webgpu' ? 'WebGPU' : 'WASM');

/**
 * 这张图要不要切块跑？
 *   off  = 永远不切（整图 letterbox，与以前一致）
 *   on   = 总是切（哪怕图很小，也有 1 块 = 整图）
 *   auto = 图比模型输入尺度还大时才切 —— 这时模型本来就得把图缩小才吃得下，
 *          缩小就意味着小部位掉分（实测 1664×2432 的图：整图 640 下该部位 0.076，
 *          整图 960 下 0.873）。切块后每块都是**原分辨率**送进模型，等于"局部按原尺度识别"。
 */
function tileDecision(mode, W, H, size) {
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    return W > size || H > size;
}

/** 给面板看的"这张图会怎么跑"：每个已选模型一行（块数与尺度） */
function planSummary(W, H) {
    const p = state.payload;
    if (!p) return null;
    const sel = p.models.filter((m) => m.status === 'ready' && state.chosen.has(m.id));
    if (!sel.length) return null;
    return sel.map((m) => {
        const size = m.imgsz || 640;
        const on = tileDecision(params.tile, W, H, size);
        const n = on ? tileCount(W, H, { size, overlap: DEFAULT_OPTS.tileOverlap }) : 1;
        return { id: m.id, size, tiled: on, count: n, tooMany: n > DEFAULT_OPTS.tileMax };
    });
}

/* ───────────────────────── 扩张：应用到现有框 / 还原 ───────────────────────── */

function snapshotBase() {
    const MOB = deps().MOB;
    state.base = MOB.regions.map((r) => {
        const info = LABELS.get(r);
        return Object.assign({}, encodeProjection(r), info ? { info } : {});
    });
}

function applyExpand() {
    const MOB = deps().MOB;
    if (!MOB || !MOB.regions.length) { toast('还没有区域可扩张'); return; }
    if (!state.base) snapshotBase();
    const W = MOB.natW, H = MOB.natH;
    const onlyModel = params.target === 'model';
    const exp = { mode: params.mode, factor: params.factor, pad: params.pad };
    const mapped = state.base.map((r) => {
        const isModel = !!r.info;
        const touched = !onlyModel || isModel;
        const b = touched ? expandRegions([r], exp, W, H)[0] : r;
        const n = normalizeRegion({ x: b.x, y: b.y, w: b.w, h: b.h }, opts(), W, H);
        return n ? Object.assign({}, n, r.info ? { info: r.info } : {}) : null;
    }).filter(Boolean);

    const { kept, dropped } = capRegions(mapped, DEFAULT_OPTS.cap, params.capPolicy);
    MOB.regions = kept.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    MOB.regions.forEach((obj, i) => { if (kept[i].info) LABELS.set(obj, kept[i].info); });
    MOB.renderList();
    MOB.draw();
    state.sig = sigOf(MOB.regions);
    $('abox-revert').disabled = false;
    renderSourceList();
    setMsg(`已按当前扩张参数重算 ${kept.length} 个区域` +
        (onlyModel ? '（只扩张模型框）' : '（模型框与手动框一起扩张）') +
        (dropped.length ? `，${dropped.length} 个因上限被丢弃` : '') +
        `。点「↺ 还原扩张」回到扩张前。`);
    toast('已应用到现有框');
}

function revertExpand() {
    const MOB = deps().MOB;
    if (!state.base) { toast('没有可还原的基准'); return; }
    if (state.sig && sigOf(MOB.regions) !== state.sig && now() > state.confirmUntil) {
        state.confirmUntil = now() + 6000;
        toast('区域已被手动改动，再点一次确认还原（会丢弃这些手改）');
        return;
    }
    MOB.regions = state.base.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
    MOB.regions.forEach((obj, i) => { if (state.base[i].info) LABELS.set(obj, state.base[i].info); });
    MOB.renderList();
    MOB.draw();
    state.sig = sigOf(MOB.regions);
    state.base = null;
    $('abox-revert').disabled = true;
    renderSourceList();
    setMsg('已还原到扩张前的区域。');
    toast('已还原扩张');
}

/* ───────────────────────── 初始化与事件绑定 ───────────────────────── */

function bindRange(id, valId, fmt, onSet) {
    const el = $(id);
    if (!el) return;
    const upd = () => { $(valId).textContent = fmt(el.value); onSet(el.value); };
    el.addEventListener('input', upd);
    upd();
}

function init() {
    const D = deps();
    if (!D.MOB) { console.warn('[abox] 拿不到 MOB（依赖握手失败），面板不启用'); return; }
    patchDraw(D);

    $('abox-hd').addEventListener('click', () => open());
    if (readLS(LS.open, false)) open(true);

    // 恢复上次参数到控件
    $('abox-mode').value = params.mode;
    $('abox-target').value = params.target;
    $('abox-merge').value = params.merge;
    $('abox-factor').value = Math.round(params.factor * 100);
    $('abox-pad').value = params.pad;
    $('abox-conf').value = Math.round(params.conf * 100);
    $('abox-scale-row').style.display = params.mode === 'scale' ? 'flex' : 'none';
    $('abox-pad-row').style.display = params.mode === 'pad' ? 'flex' : 'none';
    bindRange('abox-factor', 'abox-factor-v', (v) => (v / 100).toFixed(2) + '×',
        (v) => { params.factor = +v / 100; writeLS(LS.params, params); });
    bindRange('abox-pad', 'abox-pad-v', (v) => v + 'px',
        (v) => { params.pad = +v; writeLS(LS.params, params); });
    bindRange('abox-conf', 'abox-conf-v', (v) => (v / 100).toFixed(2),
        (v) => { params.conf = +v / 100; writeLS(LS.params, params); });
    $('abox-mode').onchange = (e) => {
        params.mode = e.target.value; writeLS(LS.params, params);
        $('abox-scale-row').style.display = params.mode === 'scale' ? 'flex' : 'none';
        $('abox-pad-row').style.display = params.mode === 'pad' ? 'flex' : 'none';
    };
    $('abox-target').onchange = (e) => { params.target = e.target.value; writeLS(LS.params, params); };
    $('abox-merge').onchange = (e) => { params.merge = e.target.value; writeLS(LS.params, params); };
    $('abox-tile').value = params.tile || 'auto';
    $('abox-tile').onchange = (e) => {
        params.tile = e.target.value; writeLS(LS.params, params);
        renderScaleRow();
        toast({ auto: '分块：图比输入尺度大时自动切（重叠 50%）', on: '分块：总是切块扫描',
                off: '分块：关闭（整图 letterbox）' }[params.tile]);
    };
    $('abox-label').value = params.showClass ? 'cls' : 'generic';
    $('abox-label').onchange = (e) => {
        params.showClass = e.target.value === 'cls';
        writeLS(LS.params, params);
        renderSourceList();                       // 清单跟着改
        renderRunSummary();                       // 结论行里的"标注"也要跟着改
        if (D.MOB && D.MOB.img) D.MOB.draw();     // 覆盖层标签跟着改
        toast(params.showClass ? '已显示模型类别名（仅供参考）' : '已隐藏具体类别，只标「敏感部位」');
    };
    $('abox-run').onclick = (e) => { e.preventDefault(); run(); };
    $('abox-apply').onclick = (e) => { e.preventDefault(); applyExpand(); };
    $('abox-revert').onclick = (e) => { e.preventDefault(); revertExpand(); };
    setMsg('展开后可选择识别模型与扩张参数。识别在本机进行，图片不会上传。');

    // 换图时清掉上一张的标注与基准（MOB.loadFrom 会清空区域，这里跟着清）
    const tick = setInterval(() => {
        if (!D.MOB || !D.MOB.url) return;
        if (state.lastUrl !== D.MOB.url) {
            state.lastUrl = D.MOB.url;
            state.base = null; state.sig = null; state.lastRun = null;
            $('abox-revert').disabled = true;
            renderSourceList();
        }
    }, 800);
    window.addEventListener('beforeunload', () => clearInterval(tick));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

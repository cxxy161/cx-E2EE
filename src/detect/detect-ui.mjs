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
    DEFAULT_OPTS,
} from './detect-core.mjs';
import { backendInfo, runModel, pickVariant } from './detect-ort.mjs';

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
      capPolicy: 'score', showClass: false },
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

function setMsg(html) { const el = $('abox-msg'); if (el) el.innerHTML = html; }

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
        setMsg('本页部署在纯静态站点（无后端）：没有服务端转译与模型路由。' +
            '要用自动打框请用自托管方式打开本站（<code>npm start</code>）。');
        $('abox-models').innerHTML = '';
        $('abox-run').disabled = true;
        return;
    }
    try {
        const res = await fetch('/api/detect/models', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        state.payload = await res.json();
    } catch (e) {
        setStatus('后端不可用', 'bad');
        setMsg('取不到 <code>/api/detect/models</code>（' + e.message +
            '）。自托管服务端才有这个接口；静态托管请忽略本面板。');
        $('abox-run').disabled = true;
        return;
    }
    // 先确定后端再渲染：列表里的体积是"当前后端会用到的那个变体"，
    // 而 state.ep 需要异步探测（WebGPU 有没有适配器），顺序反了会显示成另一种变体的体积
    const bi = await backendInfo();
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
    }

    if (!p.models.length) {
        box.innerHTML = '';
        setMsg((p.hint || '还没有模型。') +
            '<br>把权重放进 <code>models/detect/segm/</code>（分割）或 <code>models/detect/bbox/</code>（检测）后，' +
            '<button class="abox-link" id="abox-rescan">重新扫描</button>。');
        const btn = $('abox-rescan');
        if (btn) btn.onclick = rescan;
        return;
    }

    box.innerHTML = p.models.map((m) => {
        const v = state.ep === 'webgpu' ? ['fp32', 'int8'] : ['int8', 'fp32'];
        const pick = v.find((k) => m.files[k]);
        const mb = pick ? (m.files[pick].bytes / 1048576).toFixed(1) + 'MB' : '—';
        const cls = Object.keys(m.classes || {}).length;
        const st = m.status === 'ready' ? '' :
            `<span class="abox-err">${m.status === 'error' ? '转译失败' : '转换中'}</span>`;
        const disabled = m.status !== 'ready' ? 'disabled' : '';
        return `<label class="abox-mi" title="${m.status === 'error' ? (m.error || '').slice(0, 300) : ''}">
            <input type="checkbox" data-mid="${m.id}" ${state.chosen.has(m.id) ? 'checked' : ''} ${disabled}>
            <span class="abox-kind">${m.kind === 'segm' ? '分割' : '检测'}</span>
            <span>${m.id}</span>${st}
            <span class="abox-size">${cls ? cls + ' 类 · ' : ''}${mb}</span>
        </label>`;
    }).join('') + (pending.length || failed.length
        ? `<div class="v3-tip" style="margin-top:6px">${failed.length ? `${failed.length} 个转译失败（悬停看原因）· ` : ''}
           <button class="abox-link" id="abox-rescan">重新扫描</button></div>` : '');

    box.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        cb.onchange = () => {
            if (cb.checked) state.chosen.add(cb.dataset.mid); else state.chosen.delete(cb.dataset.mid);
            writeLS(LS.models, [...state.chosen]);
        };
    });
    const rb = $('abox-rescan');
    if (rb) rb.onclick = rescan;
}

async function rescan() {
    setStatus('重新扫描中…');
    try {
        const res = await fetch('/api/detect/rescan', { method: 'POST' });
        state.payload = await res.json();
        renderModels(await backendInfo());
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

function renderSourceList(run) {
    const el = $('abox-src');
    if (!el) return;
    const MOB = deps().MOB;
    const rows = [];
    (MOB ? MOB.regions : []).forEach((reg, i) => {
        const info = LABELS.get(reg);
        if (!info) return;
        const from = (info.sources && info.sources.length > 1 ? info.sources.join('+') : info.src) || '';
        const raw = (info.label || '') + (info.score != null ? ' ' + info.score : '');
        rows.push(`<div class="abox-si" title="模型原始类别：${raw || '（无）'}"><b>#${i + 1}</b>` +
            `<span>${info.kind === 'mask' ? '掩膜外接框' : '检测框'} · ${displayLabel(info)}` +
            `${params.showClass && info.score != null ? ' ' + info.score : ''} · ${from}</span>` +
            `<span style="margin-left:auto">${reg.w}×${reg.h} @ (${reg.x},${reg.y})</span></div>`);
    });
    el.innerHTML = rows.length ? `<div class="v3-tip">已添加区域（只读标注，具体部位名仅供参考）</div>` + rows.join('') : '';
}

function renderRunSummary() {
    const r = state.lastRun;
    if (!r) return;
    setMsg(`识别 ${r.ready} 个模型 → 候选 ${r.out.stats.candidates} → 合并 ${r.out.stats.grouped} 处` +
        ` → 写入 ${r.added} 个区域` +
        (r.overflow > 0 ? `，<b>${r.overflow} 个因为 12 个上限被丢弃</b>` : '') +
        `。本机推理 ${r.ms.toFixed(1)} s，图片未上传。` +
        `<br>扩张：${params.mode === 'scale' ? params.factor.toFixed(2) + '×' : params.pad + 'px'}` +
        ` · 合并：${{ near: '邻近', union: '外接框', none: '不合并' }[params.merge]}` +
        ` · 标注：${params.showClass ? '显示类别名' : '只标敏感部位'}` +
        ` · 对齐：${currentUnit()}px（${currentUnit() === 16 ? 'JPEG/J2' : 'PNG'}）`);
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
    const lb = letterbox(W, H, 640);
    try {
        const outputs = [];
        const diagnostics = [];
        for (const m of ready) {
            setStatus(`识别中（${outputs.length + 1}/${ready.length}）…`);
            const r = await runModel(m, MOB.img, {
                ep: state.ep, runtimeDir: undefined,
                onProgress: (p) => setStatus(p.stage === 'fetch' ? `载入模型 ${m.id}…` : `建会话 ${m.id}…`),
            });
            outputs.push(r);
            diagnostics.push({ id: m.id, variant: r.variant, backend: r.backend,
                bytes: r.bytes, compileMs: r.compileMs, ms: r.ms });
        }
        const out = buildRegions(outputs, lb, W, H, opts());
        const slots = DEFAULT_OPTS.cap - MOB.regions.length;
        if (slots <= 0) { toast('已有 12 个区域，先删掉一些再识别'); return; }

        let added = 0;
        for (const r of out.regions.slice(0, slots)) {
            if (addRegionWithInfo(r, {
                label: r.label, score: r.score, src: r.src, kind: r.kind,
                merged: r.merged, sources: r.sources,
            })) added++;
        }
        const overflow = out.regions.length - added;
        state.sig = sigOf(MOB.regions);
        state.lastRun = { ready: ready.length, out, added, overflow, ms: (now() - t0) / 1000 };
        renderSourceList();
        setStatus(`已添加 ${added} 个区域（${ep0()}）`, 'ok');
        renderRunSummary();
        toast(`已添加 ${added} 个自动区域`);
        console.log('CXABOX ' + JSON.stringify({
            stage: 'detect', ep: state.ep, W, H, chosen: ready.map((m) => m.id),
            candidates: out.stats.candidates, grouped: out.stats.grouped, added, overflow,
            dropped: out.dropped.length,
            regions: out.regions.map((r) => Object.assign(encodeProjection(r),
                { label: r.label, score: r.score, src: r.src, kind: r.kind, sources: r.sources })),
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

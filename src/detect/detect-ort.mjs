/**
 * detect-ort.mjs — ONNX Runtime 的装载与"跑一次模型"（这一层只碰 DOM/canvas 与 ORT）
 *
 * 分工：detect-core.mjs 负责全部可判定的数学（纯逻辑、可单测），这里只负责
 *   · 按执行后端（WebGPU / WASM）装载对应的 ORT 构建
 *   · 把 <img> 变成 letterbox 后的 float32 NCHW 张量
 *   · 建会话（带缓存）、跑一次、把原始输出张量原样交回
 *
 * 几条实测踩出来的规矩（改动前请先读）
 * ------------------------------------
 * 1) `ort.env.wasm.wasmPaths` 必须是**绝对 URL**。给相对路径时 ORT 内部动态 import
 *    侧车 .mjs 会解析失败，报 "Failed to resolve module specifier …"，看起来像模型坏了。
 * 2) WebGPU 构建还会去取 `*-asyncify.{mjs,wasm}`，文件不齐同样报"动态 import 失败"。
 *    这两个文件由 tools/fetch-ort.mjs 一并拉齐。
 * 3) 后端与模型精度要配对：实测 fp32 + WebGPU = 42~51 ms/帧（1152×1920），
 *    int8 + WASM = 0.66~0.9 s/帧；而 int8 + WebGPU 因为有算子落回 CPU 反而更慢（0.94 s）。
 *    所以默认按后端挑变体：WebGPU→fp32，WASM→int8（缺哪个就退回另一个）。
 * 4) 会话建一次要 2~3 秒（含图优化/着色器编译），所以按 `${id}:${variant}:${ep}` 缓存，
 *    同一模型连续识别不会重复付这个成本。
 * 5) **输入尺寸唯一的权威是 ONNX 的静态形状**（见 staticSize）：`size` 参数只是提示。
 *    一个 ONNX 文件只能服务一个尺度，元数据里的 imgsz 可能是错的（例如"直接采用现成
 *    .onnx"那条路读不出形状，只能填默认值）。所以同一份权重可以并存 640 / 960 多个构建
 *    （id 带 `@960` 后缀），各跑各的尺度，混选也不会把框换算错。
 * 6) **大图分块**（`crop`）：一次只画一块局部图，块的宽高参与 letterbox 比例计算，
 *    块内坐标靠 `letterbox.crop` 换算回原图（detect-core.modelToCandidates 加偏移）。
 *    模型与张量都是 size×size，所以分块不改变模型侧的输入形状 —— 切块完全在前端。
 */

const RUNTIME_DIR = '/detect-runtime/';
const ORT_SCRIPT = { wasm: 'ort.min.js', webgpu: 'ort.webgpu.min.js' };

const sessions = new Map();       // key -> Promise<InferenceSession>
const loadedScripts = new Map();  // ep -> Promise<void>

/** 探测本机可用的后端（WebGPU 是否存在、适配器是谁、有没有跨源隔离） */
export async function backendInfo() {
    const info = {
        webgpu: typeof navigator !== 'undefined' && !!navigator.gpu,
        threads: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1,
        crossOriginIsolated: typeof self !== 'undefined' ? !!self.crossOriginIsolated : false,
        adapter: null,
    };
    if (info.webgpu) {
        try {
            const ad = await navigator.gpu.requestAdapter();
            info.adapter = ad && ad.info ? `${ad.info.vendor}/${ad.info.architecture}` : (ad ? 'unknown' : null);
            if (!ad) info.webgpu = false;      // 有 API 但没有适配器（例如远程桌面/无独显）
        } catch (e) {
            info.webgpu = false;
            info.adapter = 'error: ' + e.message;
        }
    }
    return info;
}

export function resolveRuntimeDir(dir) {
    // 允许调用方覆盖（本地验证台会把运行时放在别处），默认走服务端路由
    const base = dir || RUNTIME_DIR;
    return new URL(base, document.baseURI).href;   // 必须绝对 URL，见文件头第 1 条
}

/** 装载 ORT 构建（幂等；同一后端只插一次 script） */
export async function ensureRuntime(ep = 'wasm', runtimeDir) {
    if (loadedScripts.has(ep)) return loadedScripts.get(ep);
    const p = (async () => {
        if (typeof window.ort === 'undefined' || !window.ort.InferenceSession) {
            const file = ORT_SCRIPT[ep] || ORT_SCRIPT.wasm;
            await new Promise((ok, bad) => {
                const s = document.createElement('script');
                s.src = resolveRuntimeDir(runtimeDir) + file;
                s.onload = ok;
                s.onerror = () => bad(new Error(`ONNX Runtime 装载失败：${s.src}` +
                    '（先跑 node tools/fetch-ort.mjs，或确认 /detect-runtime/ 可访问）'));
                document.head.appendChild(s);
            });
        }
        const ort = window.ort;
        ort.env.wasm.wasmPaths = resolveRuntimeDir(runtimeDir);
        ort.env.wasm.proxy = false;
        ort.env.logLevel = 'error';
        return ort;
    })();
    loadedScripts.set(ep, p);
    return p;
}

/** 按后端与模型可用的文件挑精度变体（WebGPU 用 fp32、WASM 用 int8；缺就退另一个） */
export function pickVariant(model, ep) {
    const files = model.files || {};
    const prefer = ep === 'webgpu' ? ['fp32', 'int8'] : ['int8', 'fp32'];
    for (const v of prefer) if (files[v]) return v;
    return null;
}

/** 取会话（缓存） */
export async function getSession(model, { ep = 'wasm', variant, runtimeDir, onProgress } = {}) {
    const v = variant || pickVariant(model, ep);
    if (!v) throw new Error(`模型 ${model.id} 没有可用的 onnx 文件（先转译：POST /api/detect/rescan）`);
    const key = `${model.id}:${v}:${ep}`;
    if (sessions.has(key)) return sessions.get(key);
    const p = (async () => {
        const ort = await ensureRuntime(ep, runtimeDir);
        const url = model.urls[v];
        if (onProgress) onProgress({ stage: 'fetch', model: model.id, variant: v });
        const t0 = performance.now();
        const buf = await (await fetch(url)).arrayBuffer();
        if (onProgress) onProgress({ stage: 'compile', model: model.id, variant: v, bytes: buf.byteLength });
        const sess = await ort.InferenceSession.create(new Uint8Array(buf), {
            executionProviders: [ep], graphOptimizationLevel: 'all',
        });
        sess.__meta = {
            variant: v, ep, bytes: buf.byteLength,
            fetchMs: +(performance.now() - t0).toFixed(0),
            inputName: sess.inputNames[0], outputNames: sess.outputNames.slice(),
        };
        return sess;
    })();
    sessions.set(key, p);
    try { return await p; } catch (e) { sessions.delete(key); throw e; }
}

/** 释放某个模型的所有会话（换模型/换后端时用） */
export function dropSessions(modelId) {
    for (const k of [...sessions.keys()]) if (k.startsWith(modelId + ':')) sessions.delete(k);
}

/**
 * <img> → letterbox 后的 float32 NCHW 张量（填充 114 灰，RGB，/255）
 * 与 detect-core.letterbox() 的换算必须一致（那边的测试守着这条口径）。
 *
 * `crop` 给定时只取该矩形（大图分块：一块一块送，块内坐标靠 letterbox.crop 换算回原图）。
 * 注意 crop 的宽高参与比例计算 —— 一块局部图就是"这次的原图"，与整图路径走同一套数学。
 */
export function imageToTensor(img, W, H, size = 640, crop = null) {
    const cw = crop ? crop.w : W, ch = crop ? crop.h : H;
    const cx = crop ? crop.x : 0, cy = crop ? crop.y : 0;
    const r = Math.min(size / ch, size / cw);
    const nw = Math.round(cw * r), nh = Math.round(ch * r);
    const dw = Math.floor((size - nw) / 2), dh = Math.floor((size - nh) / 2);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = 'rgb(114,114,114)';
    g.fillRect(0, 0, size, size);
    g.drawImage(img, cx, cy, cw, ch, dw, dh, nw, nh);
    const d = g.getImageData(0, 0, size, size).data;
    const area = size * size;
    const f = new Float32Array(3 * area);
    for (let i = 0; i < area; i++) {
        f[i] = d[i * 4] / 255;
        f[area + i] = d[i * 4 + 1] / 255;
        f[2 * area + i] = d[i * 4 + 2] / 255;
    }
    return { tensor: f, r, dw, dh, nw, nh, size, crop: crop ? { x: cx, y: cy, w: cw, h: ch } : null };
}

/**
 * 取 metadata 值 → [1,3,n,n] 的数字形状（不是图像输入、或含动态维 -1 就返回 null）
 *
 * 字段名踩过一次坑：**ORT Web 1.30 的 metadata 条目用的是 `shape`**（实测
 * `sess.inputMetadata` 是数组 `[{name:'images', isTensor:true, type:'float32',
 * shape:[1,3,960,960]}]`），而 typings/其它构建里又叫 `dimensions`/`dims`，
 * 所以三个都认。
 */
function imageDims(val) {
    const d = (val && (val.dimensions || val.dims || val.shape)) || null;
    if (!d || d.length !== 4) return null;
    const n = d.map((x) => Number(x));
    if (n.some((x) => !Number.isFinite(x) || x <= 0)) return null;
    if (n[1] !== 3) return null;                  // 第二维必须是通道
    return n;
}

/** Map / 普通对象都取值列表 */
function metaValues(md) {
    const out = [];
    if (!md) return out;
    if (typeof md.forEach === 'function') { md.forEach((v) => out.push(v)); return out; }
    if (typeof md === 'object') { for (const k of Object.keys(md)) out.push(md[k]); }
    return out;
}

/**
 * 从会话里读 ONNX 的**静态输入边长**（导出时 dynamic=False 写死的那个值）。
 *
 * 为什么以它为准，而不是以模型元数据里的 imgsz 为准：
 *   · 形状是硬约束 —— 送错尺寸 ORT 直接抛错，元数据写错却不会有任何提示；
 *   · "直接采用现成 .onnx"那条路（服务端只拷文件、不跑模型代码）读不出 imgsz，
 *     元数据里只能填默认值，必然可能是错的。
 *
 * 取法分三级（不同 ORT 构建/版本里 inputMetadata 的形态与字段名都不一样，实测
 * WebGPU(jsep) 构建里按输入名取会落空，所以不能只试一种）：
 *   1) 按输入名从 inputMetadata 取 → 2) 扫 inputMetadata 里所有 1×3×n×n
 *   → 3) 再扫 outputMetadata（个别构建里两者是反的）。
 * 都取不到（动态形状 / 非方形 / 老版本没这个字段）返回 0，由调用方给的 size 兜底。
 */
export function staticSize(sess) {
    try {
        const name = (sess.__meta && sess.__meta.inputName) ||
            (sess.inputNames && sess.inputNames[0]) || null;
        const im = sess && sess.inputMetadata;
        let dims = null;
        // 1) 按名字直接取
        let named = null;
        if (im) {
            if (typeof im.get === 'function') named = im.get(name);
            if (!named && name && im[name]) named = im[name];
        }
        dims = imageDims(named);
        // 2) 扫 inputMetadata 的全部值
        if (!dims) {
            for (const v of metaValues(im)) { dims = imageDims(v); if (dims) break; }
        }
        // 3) 兜底扫 outputMetadata（有些构建把两者存反了）
        if (!dims) {
            for (const v of metaValues(sess && sess.outputMetadata)) { dims = imageDims(v); if (dims) break; }
        }
        if (sess.__meta) sess.__meta.onnxDims = dims;
        return (dims && dims[2] === dims[3]) ? dims[2] : 0;
    } catch (e) { return 0; }
}

/**
 * 跑一次模型：返回**原始输出张量**（解码交给 detect-core）
 *
 * `size` 只是**提示**（来自模型元数据的 imgsz）：真正用的是 ONNX 的静态输入边长，
 * 因为一个 ONNX 文件只能服务一个尺度 —— 同一份权重可以在 build/ 里并存 640 / 960
 * 多个构建（id 带 @960 后缀），前端按选中的模型各跑各自的尺度。
 * @returns {preds, dims, protos|null, protoDims|null, task, classes, id, ms, variant, backend, bytes,
 *           letterbox, size, sizeSource, sizeHint}
 */
export async function runModel(model, img, { ep = 'wasm', size = 640, crop = null, tile = null,
    runtimeDir, onProgress, warmup = false } = {}) {
    const ort = await ensureRuntime(ep, runtimeDir);
    const sess = await getSession(model, { ep, runtimeDir, onProgress });
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const real = staticSize(sess);
    const use = real || Number(size) || 640;      // ONNX 的静态形状优先，其次元数据提示，最后 640
    const lb = imageToTensor(img, W, H, use, crop);
    const feed = {};
    feed[sess.__meta.inputName] = new ort.Tensor('float32', lb.tensor, [1, 3, use, use]);
    const tn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (warmup) await sess.run(feed);
    const t0 = tn();
    let out;
    try {
        out = await sess.run(feed);
    } catch (e) {
        if (/shape|dimension|Expected|Got/i.test(String(e && e.message))) {
            throw new Error(`模型 ${model.id} 输入形状不匹配：本次按 ${use}×${use} 送数，` +
                `ONNX 期望 ${real || '（未读到）'}。模型与元数据的尺度不一致时请重新导出` +
                `（tools/detect-export.py --imgsz <尺度>）。原始错误：${e.message}`);
        }
        throw e;
    }
    const ms = +(tn() - t0).toFixed(1);
    const names = sess.__meta.outputNames;
    const preds = out[names[0]];
    const protos = names.length > 1 ? out[names[1]] : null;
    return {
        id: model.id, task: model.task, classes: model.classes || {},
        preds: preds.data, dims: preds.dims.slice(),
        protos: protos ? protos.data : null, protoDims: protos ? protos.dims.slice() : null,
        numMask: protos ? (protos.dims[1] || 32) : 0,
        ms, variant: sess.__meta.variant, backend: ep, bytes: sess.__meta.bytes,
        compileMs: sess.__meta.fetchMs, letterbox: lb,
        size: use, sizeSource: real ? 'onnx' : 'hint', onnxDims: sess.__meta.onnxDims || null,
        crop: lb.crop, tile,
        // 元数据与真实形状不一致时留个痕：面板会把它显示成"元数据写的是 N"
        sizeHint: (real && Number(size) && Number(size) !== real) ? Number(size) : null,
    };
}

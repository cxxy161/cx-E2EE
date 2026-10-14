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
 */
export function imageToTensor(img, W, H, size = 640) {
    const r = Math.min(size / H, size / W);
    const nw = Math.round(W * r), nh = Math.round(H * r);
    const dw = Math.floor((size - nw) / 2), dh = Math.floor((size - nh) / 2);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = 'rgb(114,114,114)';
    g.fillRect(0, 0, size, size);
    g.drawImage(img, 0, 0, W, H, dw, dh, nw, nh);
    const d = g.getImageData(0, 0, size, size).data;
    const area = size * size;
    const f = new Float32Array(3 * area);
    for (let i = 0; i < area; i++) {
        f[i] = d[i * 4] / 255;
        f[area + i] = d[i * 4 + 1] / 255;
        f[2 * area + i] = d[i * 4 + 2] / 255;
    }
    return { tensor: f, r, dw, dh, nw, nh, size };
}

/**
 * 跑一次模型：返回**原始输出张量**（解码交给 detect-core）
 * @returns {preds, dims, protos|null, protoDims|null, task, classes, id, ms, variant, backend, bytes}
 */
export async function runModel(model, img, { ep = 'wasm', size = 640, runtimeDir, onProgress, warmup = false } = {}) {
    const ort = await ensureRuntime(ep, runtimeDir);
    const sess = await getSession(model, { ep, runtimeDir, onProgress });
    const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
    const lb = imageToTensor(img, W, H, size);
    const feed = {};
    feed[sess.__meta.inputName] = new ort.Tensor('float32', lb.tensor, [1, 3, size, size]);
    const tn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (warmup) await sess.run(feed);
    const t0 = tn();
    const out = await sess.run(feed);
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
    };
}

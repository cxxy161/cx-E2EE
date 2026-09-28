/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写 · 推理引擎边界（模型生命周期 + 前向接口）
 * ═══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 本文件是**整条管线中唯一会被"真模型"替换的部件**。
 *    UI（stego-ui.js）与编解码驱动（stego.js）只依赖这里暴露的接口：
 *
 *      StegoEngine.manifest            —— 模型文件清单
 *      StegoEngine.check()             —— 查缓存 → 'ready' | 'missing'
 *      StegoEngine.fetchModel({...})   —— 下载 + 进度 + 落 IndexedDB
 *      StegoEngine.load()              —— 从 IndexedDB 装载权重/词表
 *      StegoEngine.reset()             —— 新序列，返回初始 KV 态
 *      StegoEngine.forward(lastId, st) —— 单步前向 → topK(256)
 *
 *    模型到货后：只需把 load()/forward() 接到 WASM，其余文件一行不动。
 *
 * 现阶段模型未交付，因此：
 *   - fetchModel() **真实发起 fetch**，404 就进 'missing' 态并如实报错，
 *     绝不伪造进度条（假进度会让人误判"已经能用"）；
 *   - forward() 抛 NOT_LOADED，由上层给出明确提示。
 */
(function (global) {
    'use strict';

    const DB_NAME = 'cx-stego';
    const DB_VER = 1;
    const STORE = 'files';

    /* ── 模型清单（真资产，已随仓库分发在 src/stego-model/） ── */
    const MANIFEST = {
        version: 'pcd-v3-6M-fixedpoint',
        base: 'stego-model/',
        files: [
            { name: 'format.json', desc: '资产清单', bytes: 12721, text: true },
            { name: 'vocab.bin', desc: '词表', bytes: 26554 },
            { name: 'norm.bin', desc: 'RMSNorm', bytes: 14976 },
            { name: 'tables.bin', desc: 'LUT + RoPE', bytes: 163840 },
            { name: 'weights.bin', desc: '权重', bytes: 6566656 },
        ],
    };

    /* ── IndexedDB 小工具（不可用时静默降级为"仅内存") ── */
    function openDB() {
        return new Promise((res, rej) => {
            if (!global.indexedDB) return rej(new Error('浏览器不支持 IndexedDB'));
            const rq = indexedDB.open(DB_NAME, DB_VER);
            rq.onupgradeneeded = () => {
                const db = rq.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error || new Error('IndexedDB 打开失败'));
        });
    }

    function idb(store, mode, fn) {
        return openDB().then(db => new Promise((res, rej) => {
            const tx = db.transaction(store, mode);
            const rq = fn(tx.objectStore(store));
            rq.onsuccess = () => res(rq.result);
            rq.onerror = () => rej(rq.error);
            tx.oncomplete = () => db.close();
        }));
    }

    const idbGet = (k) => idb(STORE, 'readonly', s => s.get(k));
    const idbPut = (k, v) => idb(STORE, 'readwrite', s => s.put(v, k));

    /* ── 引擎 ── */
    const Engine = {
        manifest: MANIFEST,
        state: 'unknown',        // unknown | checking | missing | downloading | ready | error
        detail: '',
        onState: null,           // (state, detail) => void

        _vocab: null,            // Uint8Array（token_id → UTF-8 串 的查表需按真格式解析）
        _weights: null,
        _abort: null,
        _loaded: false,

        _set(state, detail) {
            this.state = state;
            this.detail = detail || '';
            if (typeof this.onState === 'function') this.onState(state, this.detail);
        },

        /** 查缓存：全部文件就位 → ready，否则 missing */
        async check() {
            this._set('checking');
            try {
                // format.json 小且必需；先读它来判断是否整体就绪
                const fmtRec = await idbGet('format.json');
                const rest = [];
                for (const f of MANIFEST.files) {
                    if (f.name === 'format.json') continue;
                    const rec = await idbGet(f.name);
                    if (!rec || !rec.buf) { this._set('missing', '缺少 ' + f.name); return false; }
                    rest.push(rec);
                }
                if (!fmtRec || !fmtRec.buf) { this._set('missing', '缺少 format.json'); return false; }
                const ok = await this._mount(fmtRec, rest);
                this._set(ok ? 'ready' : 'error', ok ? '模型已就绪（' + this._mb() + ' MB）' : '资产装载失败');
                return ok;
            } catch (e) {
                this._set('missing', '无法访问本地缓存：' + (e && e.message ? e.message : e));
                return false;
            }
        },

        /** 把已下载的资产交给 Stego 内核装载 */
        async _mount(fmtRec, rest) {
            if (typeof Stego === 'undefined' || !Stego.load) { this._set('error', 'stego.js 未加载'); return false; }
            const byName = {};
            for (const r of rest) byName[r.name] = r.buf;
            try {
                Stego.load({
                    fmt: fmtRec.buf,
                    vocab: byName['vocab.bin'],
                    norm: byName['norm.bin'],
                    tables: byName['tables.bin'],
                    weights: byName['weights.bin'],
                });
                this._loaded = true;
                return true;
            } catch (e) {
                this._set('error', '资产装载失败：' + (e && e.message ? e.message : e));
                return false;
            }
        },

        _mb() {
            let n = 0;
            for (const f of MANIFEST.files) n += f.bytes || 0;
            return (n / 1048576).toFixed(1);
        },

        /** 已缓存总字节（用于 UI 显示） */
        _cachedBytes() {
            let n = 0;
            for (const f of MANIFEST.files) n += f.bytes || 0;
            return n;
        },

        /**
         * 下载模型 → IndexedDB。
         * onProgress({ file, fileIndex, filesTotal, got, total, overall, overallTotal, bps })
         */
        async fetchModel(opts = {}) {
            const { onProgress, signal } = opts;
            this._abort = new AbortController();
            const sig = signal || this._abort.signal;
            this._set('downloading');
            try {
                let fmtBuf = null;
                const parts = [];
                for (let i = 0; i < MANIFEST.files.length; i++) {
                    const f = MANIFEST.files[i];
                    const url = MANIFEST.base + f.name;
                    const resp = await fetch(url, { signal: sig, cache: 'no-store' });
                    if (!resp.ok) {
                        const e = new Error('模型文件缺失：' + url + '（HTTP ' + resp.status + '）');
                        e.code = 'MODEL_MISSING';
                        throw e;
                    }
                    const total = Number(resp.headers.get('content-length') || f.bytes || 0);
                    let buf;
                    if (resp.body && resp.body.getReader) {
                        const reader = resp.body.getReader();
                        const chunks = []; let got = 0; const t0 = Date.now();
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            chunks.push(value); got += value.length;
                            const el = Math.max(1, Date.now() - t0) / 1000;
                            if (onProgress) onProgress({
                                file: f.name, fileIndex: i, filesTotal: MANIFEST.files.length,
                                got, total, bps: got / el, overall: got, overallTotal: total,
                            });
                        }
                        buf = new Uint8Array(got);
                        let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
                    } else {
                        buf = new Uint8Array(await resp.arrayBuffer());
                    }
                    f.bytes = buf.length;
                    if (f.name === 'format.json') fmtBuf = { name: f.name, buf: buf.buffer };
                    else parts.push({ name: f.name, buf: buf.buffer });
                    await idbPut(f.name, { name: f.name, buf: buf.buffer, at: Date.now(), version: MANIFEST.version });
                }
                const ok = await this._mount(fmtBuf, parts);
                this._set(ok ? 'ready' : 'error', ok ? '模型已就绪（' + this._mb() + ' MB）' : '资产装载失败');
                return ok;
            } catch (e) {
                if (e && e.name === 'AbortError') { this._set('missing', '已取消下载'); return false; }
                this._set('error', (e && e.message) ? e.message : String(e));
                return false;
            } finally {
                this._abort = null;
            }
        },

        cancelDownload() { if (this._abort) this._abort.abort(); },

        /** 从 IndexedDB 装载（幂等） */
        async load() {
            if (this._loaded) return true;
            return this.check();
        },

        /* ── 前向接口（委派给 Stego 内核） ──
         * 契约（已与模型端锁定）：
         *   入参 lastTokenId：上一步产出的 token id（首步用 BOS=1）
         *        state      ：KV Cache 不透明状态对象
         *   出参 topK       ：Uint16Array，长度 256（>64，供 prefix-free 过滤后递补）
         *        logits     ：Float64Array(4096) 原始 int32 定点分数（区间编码需要）
         *        topScores  ：与 topK 对应的 int32 分数（便于直接建整数 CDF）
         *        nextState  ：推进后的 KV 态
         *
         * ⚠️ logits / topScores 是**区间编码的必需品**：CDF 必须由模型原始
         *    分数（int32 定点 2^-12）算出，不能用名次代替。旧 6bit 路径
         *    只读 topK，多出的字段对它无害。 */
        reset() {
            if (!this._loaded) return null;
            return Stego.createState(Stego._M);
        },

        async forward(lastTokenId, state) {
            if (!this._loaded) {
                const e = new Error('模型未加载：请先下载并装载模型');
                e.code = 'NOT_LOADED';
                throw e;
            }
            const st = state || this.reset();
            const r = Stego.stepForward(Stego._M, lastTokenId, st);
            const topK = Stego.topKFromLogits(r.logits, Stego.P.TOPK);
            const topScores = new Int32Array(topK.length);
            for (let i = 0; i < topK.length; i++) topScores[i] = r.logits[topK[i]] | 0;
            return { topK, logits: r.logits, topScores, nextState: st };
        },
    };

    global.StegoEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);

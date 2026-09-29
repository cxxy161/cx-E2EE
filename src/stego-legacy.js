/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写 · 历史 Codec 冻结件（ver=1 六位抽签 / ver=2 整块区间坍缩）
 * ═══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 本文件是**只读的历史解码器**，请勿改进、优化或「顺手统一风格」。
 *    它的唯一职责是让**已经发出去的**伪装文本仍能被解回来。
 *
 * ── 为什么必须冻结 ──
 *   新 Codec（ver=3，滑窗重归一化）彻底废弃了定长桶与 PRF 填充，
 *   编码器终止模型都换了 —— 旧文本用新代码**一定**解不开。
 *   要同时满足「新层零定长桶」与「旧文本可解」，唯一办法是把旧实现
 *   原样搬到独立文件里冻结，由新管线在识别到 ver=1/2 签名时按需调用。
 *
 * ── 与 src/stego.js 的关系 ──
 *   内核（定点推理 / 词表 / 整数 CDF / 区间细分原语）由 stego.js 注入，
 *   本文件**不重复实现**、也不持有模型。注入契约见 install()。
 *
 * ── 冻结承诺 ──
 *   本文件一旦有 ver=1/2 文本流出，其行为必须逐 bit 不变。
 *   任何改动都必须先确认「无历史文本依赖」，并同步 test/stego 的 golden。
 */
(function (global) {
    'use strict';

    /** 注入的内核依赖（由 src/stego.js 在装载后调用 install()） */
    let K = null;

    /**
     * 安装内核依赖。
     * @param {{
     *   P: object, C: object, PROFILES: Array, MAX_TOPK: number,
     *   frameGeometry: Function, profileFor: Function,
     *   makeSigChar: Function, readSigChar: Function, sigSupported: Function,
     *   createState: Function, stepForward: Function, topKFromLogits: Function,
     *   buildIntegerCDF: Function, stepScale: Function, bytesToBigInt: Function,
     *   bigIntToBytes: Function, bucketOf: Function, narrow: Function,
     *   resolveByteCandidates: Function, resolveRangePool: Function,
     *   adaptiveCapFreq: Function, yieldToUI: Function,
     *   fnv1a16: Function, nonceOf: Function, hashBytes: Function,
     *   segmentEnvelope: Function, mergeSegments: Function,
     *   RANGE_POOL: number, RANGE_BUDGET: number, RANGE_POOL_IDX: number,
     * }} kernel
     */
    function install(kernel) { K = kernel; return Legacy; }

    const _td = new TextDecoder('utf-8');
    const _te = new TextEncoder();

    /* ══════════════════ ① 位流（ver=1 六位路径） ══════════════════ */

    function unitsFromBytes(bytes, k) {
        k = k || K.P.BITS;
        const total = Math.floor((bytes.length * 8) / k);
        const out = new Array(total);
        let acc = 0, n = 0, i = 0;
        for (let u = 0; u < total; u++) {
            while (n < k) { acc = ((acc << 8) | (i < bytes.length ? bytes[i++] : 0)) >>> 0; n += 8; }
            n -= k;
            out[u] = (acc >>> n) & ((1 << k) - 1);
            acc = n ? (acc & ((1 << n) - 1)) : 0;
        }
        return out;
    }

    function bytesFromUnits(units, k) {
        k = k || K.P.BITS;
        const out = [];
        let acc = 0, n = 0;
        for (const v of units) {
            acc = ((acc << k) | (v & ((1 << k) - 1))) >>> 0; n += k;
            while (n >= 8) { n -= 8; out.push((acc >>> n) & 0xff); }
            acc = n ? (acc & ((1 << n) - 1)) : 0;
        }
        if (n > 0) out.push((acc << (8 - n)) & 0xff);
        return Uint8Array.from(out);
    }

    /* ══════════════════ ② 定长帧（ver=1/2，Magic⊕nonce + PRF 填充） ══════════════════
     *
     * ⚠️ 这套东西在新管线里已被**彻底删除**（见 src/stego.js 的删除说明）。
     *    此处保留仅为解析历史文本，不得被新编码路径引用。
     */

    function prfStream(seed, n) {
        const out = new Uint8Array(n);
        let x = (seed >>> 0) || 0x12345678;
        for (let i = 0; i < n; i++) {
            x ^= (x << 13); x >>>= 0;
            x ^= (x >>> 17);
            x ^= (x << 5); x >>>= 0;
            out[i] = x & 0xff;
        }
        return out;
    }

    function buildFrame(slice, seq, g) {
        g = K.frameGeometry(g);
        if (slice.length > g.payload) throw new Error('SLICE_TOO_LONG');
        const f = new Uint8Array(g.segBytes);
        const m = (K.P.MAGIC ^ K.nonceOf(slice)) & 0xffff;
        f[0] = m >>> 8; f[1] = m & 0xff;
        f[2] = slice.length >>> 8; f[3] = slice.length & 0xff;
        f.set(slice, K.P.FRAME_HDR);
        const padLen = g.payload - slice.length;
        if (padLen > 0) {
            const seed = ((m << 16) ^ Math.imul(slice.length + 1, 2654435761) ^ K.hashBytes(slice)) >>> 0;
            f.set(prfStream(seed, padLen), K.P.FRAME_HDR + slice.length);
        }
        return f;
    }

    function parseFrame(f, seq, g) {
        g = K.frameGeometry(g);
        if (f.length !== g.segBytes) throw new Error('FRAME_SIZE');
        const len = (f[2] << 8) | f[3];
        if (len > g.payload) throw new Error('BAD_LEN');
        const slice = f.slice(K.P.FRAME_HDR, K.P.FRAME_HDR + len);
        const m = (f[0] << 8) | f[1];
        if (((m ^ K.nonceOf(slice)) & 0xffff) !== K.P.MAGIC) throw new Error('MAGIC_MISMATCH');
        return slice;
    }

    function frameMagicOk(f, g) {
        g = K.frameGeometry(g);
        if (f.length !== g.segBytes) return false;
        const len = (f[2] << 8) | f[3];
        if (len > g.payload) return false;
        const m = (f[0] << 8) | f[1];
        return (((m ^ K.nonceOf(f.subarray(K.P.FRAME_HDR, K.P.FRAME_HDR + len))) & 0xffff) === K.P.MAGIC);
    }

    function splitPayload(bytes, g) {
        g = K.frameGeometry(g);
        const segs = [];
        for (let i = 0; i < bytes.length || segs.length === 0; i += g.payload) {
            segs.push(bytes.slice(i, i + g.payload));
        }
        return segs;
    }

    /* ══════════════════ ③ ver=1 链级编码（仅回归对照用） ══════════════════ */

    async function encodeChain(chainBytes, fwd, V, onStep, signal) {
        const units = unitsFromBytes(chainBytes, K.P.BITS);
        const state = K.createState(fwd.M);
        let last = K.P.BOS;
        const parts = [];
        let total = 0;
        const sig = K.makeSigChar(1, { topk: K.P.TOPK });
        if (sig) { parts.push(_te.encode(sig)); total += parts[0].length; }
        for (let i = 0; i < units.length; i++) {
            const r = fwd(last, state);
            const cand = K.resolveByteCandidates(r.topK, V, K.P.NEED);
            const u = units[i];
            parts.push(cand.bufs[u]);
            total += cand.bufs[u].length;
            last = cand.ids[u];
            if ((i & (K.YIELD_EVERY - 1)) === 0) {
                if (onStep) onStep(i + 1);
                await K.yieldToUI();
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
        }
        const bytes = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { bytes.set(p, o); o += p.length; }
        return _td.decode(bytes);
    }

    /* ══════════════════ ④ ver=2 整块区间坍缩（编码 + 解码） ══════════════════
     *
     * ⚠️ 与 ver=3 的**根本差别**：终止条件是 hi-lo == 1（整块当作一个大整数
     *    完全确定），因此解码端必须演完整块，无法"解够就刹车"。
     *    ver=3 改为滑窗重归一化，正是为了去掉这个限制。
     */

    async function encodeChainRange(chainBytes, segBytes, fwd, V, onStep, signal) {
        const run = (mode) => encodeChainRangeOnce(chainBytes, segBytes, fwd, V, onStep, signal, mode);
        try {
            return await run('lazy');
        } catch (e) {
            if (e && /RANGE_MAX_STEPS/.test(e.message || '')) {
                return await run('forced');
            }
            throw e;
        }
    }

    async function encodeChainRangeOnce(chainBytes, segBytes, fwd, V, onStep, signal, capMode) {
        const nFrames = Math.max(1, Math.ceil(chainBytes.length / segBytes));
        const state = K.createState(fwd.M);
        let last = K.P.BOS;
        const parts = [], perFrame = [];
        let total = 0, steps = 0;
        const totalBits = 8 * segBytes;

        const sig = K.makeSigChar(2, { forced: capMode === 'forced' });
        if (sig) { const b = _te.encode(sig); parts.push(b); total += b.length; }

        for (let f = 0; f < nFrames; f++) {
            const slice = chainBytes.subarray(f * segBytes, Math.min((f + 1) * segBytes, chainBytes.length));
            const frame = new Uint8Array(segBytes);
            frame.set(slice);                       // 末帧零填充（定长帧语义）
            const Vp = K.bytesToBigInt(frame);
            let lo = 0n, hi = 1n << BigInt(8 * segBytes);
            let fSteps = 0;

            while (hi - lo > 1n) {
                if (steps >= K.RANGE_BUDGET) {
                    throw new Error('RANGE_MAX_STEPS: ' + steps + '（超每链预算 ' + K.RANGE_BUDGET + '）');
                }
                const r = hi - lo;
                const Mv = K.stepScale(r);
                const Mb = BigInt(Mv);

                const fw = fwd(last, state);
                const pool = K.resolveRangePool(fw.topK, V, K.RANGE_POOL, Mv);
                const cdf = K.buildIntegerCDF(fw.logits, pool.ids, fwd.M.tables.exp_lut.arr, Mv,
                    K.adaptiveCapFreq(Mv, r, fSteps, totalBits, K.RANGE_BUDGET, capMode));

                const t = Number(((Vp - lo) * Mb) / r);
                const i = K.bucketOf(cdf.cum, cdf.L, Mv, t);
                const nx = K.narrow(lo, r, cdf.cum, i, Mv);
                lo = nx.lo; hi = nx.hi;

                parts.push(pool.bufs[i]);
                total += pool.bufs[i].length;
                last = pool.ids[i];
                steps++; fSteps++;

                if ((steps & (K.YIELD_EVERY - 1)) === 0) {
                    if (onStep) onStep(steps);
                    await K.yieldToUI();
                    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                }
            }
            if (lo !== Vp) throw new Error('RANGE_NOT_EXACT: 坍缩值 ≠ 原值');
            perFrame.push(fSteps);
        }
        if (onStep) onStep(steps);

        const bytes = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { bytes.set(p, o); o += p.length; }
        return { text: _td.decode(bytes), steps, perFrame, nFrames, capMode };
    }

    async function decodeChainRange(textBytes, cursor0, segBytes, fwd, V, opts) {
        opts = opts || {};
        const signal = opts.signal;
        const maxFrames = opts.maxFrames || 64;
        const state = K.createState(fwd.M);
        let last = K.P.BOS;
        let cursor = cursor0 || 0, steps = 0;
        const out = [];
        const totalBits = 8 * segBytes;

        let capMode = (opts.capMode) || 'lazy';
        if (opts.sig !== false) {
            const sg = K.readSigChar(textBytes, cursor);
            if (sg && sg.ver === 2) {
                cursor += sg.len;
                capMode = sg.forced ? 'forced' : 'lazy';
            }
        }

        while (cursor < textBytes.length && out.length < maxFrames) {
            let lo = 0n, hi = 1n << BigInt(8 * segBytes);
            let fSteps = 0;

            while (hi - lo > 1n) {
                if (steps >= K.RANGE_BUDGET) {
                    const e = new Error('RANGE_MAX_STEPS: ' + steps);
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                }
                if (cursor >= textBytes.length) {
                    const e = new Error('RANGE_TEXT_UNDERRUN@' + cursor);
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                }
                const r = hi - lo;
                const Mv = K.stepScale(r);

                const fw = fwd(last, state);
                const pool = K.resolveRangePool(fw.topK, V, K.RANGE_POOL, Mv);
                const cdf = K.buildIntegerCDF(fw.logits, pool.ids, fwd.M.tables.exp_lut.arr, Mv,
                    K.adaptiveCapFreq(Mv, r, fSteps, totalBits, K.RANGE_BUDGET, capMode));

                let hit = -1, hits = 0;
                for (let i = 0; i < pool.bufs.length; i++) {
                    if (V.matchesAt(textBytes, cursor, pool.bufs[i])) { if (hit < 0) hit = i; hits++; }
                }
                if (hits === 0) {
                    const e = new Error('RANGE_DESYNC@' + cursor + '（文本与候选集无法对齐）');
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                }
                if (hits > 1) throw new Error('RANGE_AMBIGUOUS@' + cursor);

                const nx = K.narrow(lo, r, cdf.cum, hit, Mv);
                lo = nx.lo; hi = nx.hi;

                last = pool.ids[hit];
                cursor += pool.bufs[hit].length;
                steps++; fSteps++;

                if ((steps & (K.YIELD_EVERY - 1)) === 0) {
                    if (opts.onStep) opts.onStep(steps);
                    if (opts.onChars) opts.onChars(cursor);
                    await K.yieldToUI();
                    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                }
            }
            out.push(K.bigIntToBytes(lo, segBytes));
        }
        if (opts.onChars) opts.onChars(cursor);

        let n = 0; for (const x of out) n += x.length;
        const bytes = new Uint8Array(n);
        let o = 0; for (const x of out) { bytes.set(x, o); o += x.length; }
        return { bytes, steps, consumed: cursor, frames: out.length };
    }

    /* ══════════════════ ⑤ ver=1 自动档位识别解码 ══════════════════ */

    async function decodeAuto(textBytes, fwd, V, opts) {
        opts = opts || {};
        const signal = opts.signal;
        const useSig = opts.sig !== false && K.sigSupported();
        let live = K.PROFILES.map(pf => ({ pf, ok: true, acc: 0, nbits: 0, bytes: [] }));
        let state = K.createState(fwd.M);
        let last = K.P.BOS;
        let cursor = 0, steps = 0;
        let sigProfile = 0, sigAccepted = false;

        const checkFrames = (L) => {
            if (L.bytes.length < L.pf.segBytes) return;
            const f = new Uint8Array(L.bytes.slice(0, L.pf.segBytes));
            if (!frameMagicOk(f, L.pf)) L.ok = false;
        };

        while (cursor < textBytes.length && live.some(L => L.ok)) {
            if (steps % K.P.CHAIN_TOKENS === 0) {
                if (steps > 0) {
                    state = K.createState(fwd.M);
                    last = K.P.BOS;
                }
                if (useSig) {
                    const sg = K.readSigChar(textBytes, cursor);
                    if (sg) {
                        cursor += sg.len;
                        sigAccepted = true;
                        if (sg.pf.topk !== sigProfile) {
                            sigProfile = sg.pf.topk;
                            for (const L of live) L.ok = (L.pf.topk === sigProfile);
                        }
                    }
                }
            }

            const r = fwd(last, state);
            let needMax = 0;
            for (const L of live) if (L.ok && L.pf.topk > needMax) needMax = L.pf.topk;
            if (needMax === 0) break;
            const cand = K.resolveByteCandidates(r.topK, V, needMax);

            let hit = -1, hits = 0;
            for (let i = 0; i < cand.bufs.length; i++) {
                if (V.matchesAt(textBytes, cursor, cand.bufs[i])) { if (hit < 0) hit = i; hits++; }
            }
            if (hits === 0) {
                if (opts.fastFail !== false && steps < 4) {
                    const e = new Error('这段内容不是隐写文本');
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps;
                    throw e;
                }
                const e = new Error('文本与候选集无法对齐（第 ' + cursor + ' 字节起，可能被改动）');
                e.code = 'NOT_STEGO'; e.stepsUsed = steps;
                throw e;
            }
            if (hits > 1) throw new Error('AMBIGUOUS@' + cursor);

            for (const L of live) {
                if (!L.ok) continue;
                if (hit >= L.pf.topk) { L.ok = false; continue; }
                L.acc = ((L.acc << L.pf.bits) | hit) >>> 0;
                L.nbits += L.pf.bits;
                while (L.nbits >= 8) {
                    L.nbits -= 8;
                    L.bytes.push((L.acc >>> L.nbits) & 0xff);
                }
                L.acc = L.nbits ? (L.acc & ((1 << L.nbits) - 1)) : 0;
                checkFrames(L);
            }

            last = cand.ids[hit];
            cursor += cand.bufs[hit].length;
            steps++;
            if ((steps & 7) === 0 && opts.onChars) opts.onChars(cursor);
            if ((steps & (K.YIELD_EVERY - 1)) === 0) {
                if (opts.onStep) opts.onStep(steps);
                if (opts.onChars) opts.onChars(cursor);
                await K.yieldToUI();
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
        }
        if (opts.onChars) opts.onChars(cursor);

        let winner = live.filter(L => L.ok);
        if (!winner.length) {
            const e = new Error('这段内容不是隐写文本');
            e.code = 'NOT_STEGO'; e.stepsUsed = steps;
            throw e;
        }
        winner.sort((a, b) => a.pf.bits - b.pf.bits);
        const W = winner[0];
        return {
            bytes: Uint8Array.from(W.bytes), profile: W.pf.topk,
            candidates: winner.length, steps, sig: sigAccepted,
        };
    }

    /* ══════════════════ ⑥ 对外 ══════════════════ */

    const Legacy = {
        install,
        get ready() { return !!K; },

        /* 定长帧（历史文本解析） */
        prfStream, buildFrame, parseFrame, frameMagicOk, splitPayload,
        unitsFromBytes, bytesFromUnits,

        /* ver=2 整块区间坍缩 */
        encodeChainRange, decodeChainRange,

        /* ver=1 六位抽签 */
        encodeChain, decodeAuto,

        /* 版本标识：供新管线分流 */
        VERSIONS: [1, 2],
    };

    global.StegoLegacy = Legacy;
})(typeof window !== 'undefined' ? window : globalThis);

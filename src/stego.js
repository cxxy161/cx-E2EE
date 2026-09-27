/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写适配层 · 算法核心（浏览器版）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 纯 script 加载，无 ESM / 无构建 / 无依赖 → window.Stego
 *
 * 本文件是 test/stego/*.mjs 那套已验证实现的**移植**，必须与之逐 bit 一致。
 * 移植后由 test/stego/browser-align.test.mjs 用 golden 的 45/45 层哈希回归验证。
 *
 * 组成：
 *   ① 整数原语（零浮点推理路径）
 *   ② 定点内核（int_ref.py 的忠实实现）+ KV Cache
 *   ③ 字节级词表（绝不对单 token 做 TextDecoder）
 *   ④ 6bit 位流
 *   ⑤ 192B 定长帧（Magic⊕nonce + PRF 填充）
 *   ⑥ 候选过滤（字符集 + 逐对 prefix-free）
 *   ⑦ 段级连续编解码
 *
 * ── README 三处错误的对应处理（详见 .pcd/model-asset.md） ──
 *   [1] rshiftRound 不用 >>（会 ToInt32 截断 2^45.7 的中间量），改用 2 的幂除法
 *   [2] 不手工拆 int64；实测最坏 acc*M ≈2^36 < 2^53，直接乘精确
 *   [3] 456 个 token 是字面 U+FFFD（合法 UTF-8），非"半个汉字"；
 *       按字节结构判定汉字即可全部排除，且其中 416 个 id 字节重复，必须逐对去重
 */
(function (global) {
    'use strict';

    /* ══════════════════ ① 整数原语 ══════════════════ */

    /** 算术右移 + 半值远离零。唯一舍入方式。
     *  ⚠️ 不用 `>>`：本模型中间量最大 ≈2^45.7，`>>` 会先 ToInt32 截断。
     *     用 2 的幂除法，在 IEEE754 下只是指数减 s，精确无舍入。 */
    function rshiftRound(x, s) {
        if (s === 0) return x;
        if (s < 0) return x * Math.pow(2, -s);
        const b = Math.pow(2, s - 1), d = Math.pow(2, s);
        return x >= 0 ? Math.floor((x + b) / d) : -Math.floor((-x + b) / d);
    }

    /** 非负整数地板除（对浮点误差做一次校正） */
    function idivFloor(a, b) {
        let q = Math.floor(a / b);
        if (q * b > a) q--;
        else if ((q + 1) * b <= a) q++;
        return q;
    }

    function bitlen(x) { let r = 0; while (x > 0) { r++; x = Math.floor(x / 2); } return r; }

    /** 整数平方根（逐位恢复法） */
    function isqrt(n) {
        if (n <= 0) return 0;
        let res = 0, bit = 1;
        while (bit * 4 <= n) bit *= 4;
        while (bit > 0) {
            if (n >= res + bit) { n -= res + bit; res = Math.floor(res / 2) + bit; }
            else { res = Math.floor(res / 2); }
            bit = Math.floor(bit / 4);
        }
        return res;
    }

    /* ══════════════════ ② 常量 ══════════════════ */
    const C = {
        RES_FRAC: 12, W_SHIFT: 20, NORM_FRAC: 12, INV_FRAC: 30,
        LUT_FRAC: 15, ROPE_FRAC: 14, SCORE_INV_FRAC: 16,
        EXP_LUT_N: 8192, EXP_LUT_MAX: 16, SIG_LUT_N: 8192, SIG_LUT_MAX: 16, Q_MAX: 127,
    };

    /* 协议常量（与 test/stego/frame.mjs 必须一致） */
    const P = {
        SEG_BYTES: 192, FRAME_HDR: 4, MAGIC: 0x5354,
        TOKENS_PER_FRAME: 256, BITS: 6, TOPK: 256, NEED: 64,
        FRAMES_PER_SEG: 3, BOS: 1,
    };
    P.SEG_PAYLOAD = P.SEG_BYTES - P.FRAME_HDR;   // 188

    /* ══════════════════ ③ 模型装载（ArrayBuffer 版） ══════════════════ */

    /**
     * @param {{fmt:ArrayBuffer, weights:ArrayBuffer, norm:ArrayBuffer, tables:ArrayBuffer}} buf
     */
    function loadModel(buf) {
        const fmt = JSON.parse(new TextDecoder().decode(buf.fmt));
        const W = new Uint8Array(buf.weights);
        const NB = new Uint8Array(buf.norm);
        const TB = new Uint8Array(buf.tables);
        const dvW = new DataView(buf.weights), dvN = new DataView(buf.norm), dvT = new DataView(buf.tables);

        const tensors = {};
        for (const t of fmt.tensors) {
            const out = t.shape[0], inn = t.shape[1];
            const q = new Int8Array(buf.weights, W.byteOffset + t.q_offset, t.q_bytes);
            const m = new Int32Array(t.m_count);
            for (let i = 0; i < t.m_count; i++) m[i] = dvW.getInt32(t.m_offset + i * 4, true);
            tensors[t.name] = { q, m, out, inn };
        }
        const norms = {};
        for (const e of fmt.norms.entries) {
            const g = new Int32Array(e.count);
            for (let i = 0; i < e.count; i++) g[i] = dvN.getInt32(e.offset + i * 4, true);
            norms[e.name] = g;
        }
        const tables = {};
        for (const t of fmt.tables) {
            const n = t.shape.reduce((a, b) => a * b, 1);
            const arr = new Int32Array(n);
            for (let i = 0; i < n; i++) arr[i] = dvT.getInt32(t.offset + i * 4, true);
            tables[t.name] = { arr, shape: t.shape };
        }
        return { fmt, tensors, norms, tables, cfg: fmt.arch };
    }

    /* ══════════════════ ④ 算子 ══════════════════ */

    function quantAct(x, T, d) {
        const q = new Int8Array(T * d), s = new Int32Array(T);
        for (let t = 0; t < T; t++) {
            let a = 0;
            for (let k = 0; k < d; k++) { const v = Math.abs(x[t * d + k]); if (v > a) a = v; }
            let sh = Math.max(bitlen(Math.max(a, 1)) - 7, 0);
            while (idivFloor(a, Math.pow(2, sh)) > C.Q_MAX) sh++;
            s[t] = sh;
            for (let k = 0; k < d; k++) {
                let v = rshiftRound(x[t * d + k], sh);
                if (v > C.Q_MAX) v = C.Q_MAX; else if (v < -C.Q_MAX) v = -C.Q_MAX;
                q[t * d + k] = v;
            }
        }
        return { q, s };
    }

    function linearFromQ(qx, sx, T, Wt, outFrac) {
        if (outFrac === undefined) outFrac = C.RES_FRAC;
        const qw = Wt.q, mw = Wt.m, out = Wt.out, inn = Wt.inn;
        const y = new Float64Array(T * out);
        for (let t = 0; t < T; t++) {
            const shift = (C.W_SHIFT - sx[t]) + (C.RES_FRAC - outFrac);
            const xb = t * inn;
            for (let j = 0; j < out; j++) {
                let acc = 0;
                const wb = j * inn;
                for (let k = 0; k < inn; k++) acc += qx[xb + k] * qw[wb + k];
                y[t * out + j] = rshiftRound(acc * mw[j], shift);
            }
        }
        return y;
    }

    function linear(x, T, dIn, Wt, outFrac) {
        const r = quantAct(x, T, dIn);
        return linearFromQ(r.q, r.s, T, Wt, outFrac);
    }

    /** RMSNorm。坑 [C]：必须先开方再整除 */
    function rmsnorm(x, g, T, d) {
        const out = new Float64Array(T * d), invF = C.INV_FRAC;
        const shift = invF + C.NORM_FRAC - C.RES_FRAC;
        for (let t = 0; t < T; t++) {
            let ss = 0;
            for (let k = 0; k < d; k++) { const v = x[t * d + k]; ss += v * v; }
            const msq = Math.max(idivFloor(ss, d), 1);
            const s = Math.max(isqrt(msq), 1);
            const inv = idivFloor(Math.pow(2, invF), s);
            for (let k = 0; k < d; k++) out[t * d + k] = rshiftRound(x[t * d + k] * inv * g[k], shift);
        }
        return out;
    }

    function siluLut(x, sigLut) {
        const out = new Float64Array(x.length);
        const span = C.SIG_LUT_MAX * Math.pow(2, C.RES_FRAC);
        for (let i = 0; i < x.length; i++) {
            const v = x[i];
            let idx = idivFloor((v + span) * (C.SIG_LUT_N - 1), 2 * span);
            if (idx < 0) idx = 0; else if (idx > C.SIG_LUT_N - 1) idx = C.SIG_LUT_N - 1;
            out[i] = rshiftRound(v * sigLut[idx], C.LUT_FRAC);
        }
        return out;
    }

    function softmaxLut(scores, expLut, outFrac) {
        if (outFrac === undefined) outFrac = C.RES_FRAC;
        const S = scores.length;
        let m = -Infinity;
        for (let i = 0; i < S; i++) if (scores[i] > m) m = scores[i];
        const span = C.EXP_LUT_MAX * Math.pow(2, C.RES_FRAC);
        const e = new Float64Array(S);
        let sum = 0;
        for (let i = 0; i < S; i++) {
            const d = scores[i] - m;
            let idx = idivFloor((-d) * (C.EXP_LUT_N - 1), span);
            if (idx < 0) idx = 0; else if (idx > C.EXP_LUT_N - 1) idx = C.EXP_LUT_N - 1;
            e[i] = expLut[idx]; sum += e[i];
        }
        if (sum < 1) sum = 1;
        const mul = Math.pow(2, outFrac), p = new Float64Array(S);
        for (let i = 0; i < S; i++) p[i] = idivFloor(e[i] * mul, sum);
        return p;
    }

    /** 整数 RoPE（chunk-half）。pos0 = 起始位置（KV Cache 增量时传当前位置） */
    function ropeApply(x, T, H, hd, cos, sin, pos0) {
        if (pos0 === undefined) pos0 = 0;
        const half = hd >> 1, out = new Float64Array(T * H * hd);
        for (let t = 0; t < T; t++) {
            const rb = (pos0 + t) * half;
            for (let h = 0; h < H; h++) {
                const base = (t * H + h) * hd;
                for (let i = 0; i < half; i++) {
                    const x1 = x[base + i], x2 = x[base + half + i];
                    const c = cos[rb + i], s = sin[rb + i];
                    out[base + i] = rshiftRound(x1 * c - x2 * s, C.ROPE_FRAC);
                    out[base + half + i] = rshiftRound(x2 * c + x1 * s, C.ROPE_FRAC);
                }
            }
        }
        return out;
    }

    /* ══════════════════ ⑤ KV Cache 增量前向 ══════════════════ */

    function createState(M) {
        const n = M.cfg.n_layer;
        return { pos: 0, k: new Array(n), v: new Array(n), cap: 0, _n: n };
    }

    function ensureCap(st, need, M) {
        if (st.cap >= need) return;
        let cap = st.cap || 64;
        while (cap < need) cap *= 2;
        const per = cap * M.cfg.n_head * M.cfg.head_dim;
        for (let i = 0; i < st._n; i++) {
            const k = new Float64Array(per); if (st.k[i]) k.set(st.k[i]); st.k[i] = k;
            const v = new Float64Array(per); if (st.v[i]) v.set(st.v[i]); st.v[i] = v;
        }
        st.cap = cap;
    }

    /**
     * 单 token 增量前向。返回 { logits: Float64Array(vocab) }。
     * 逐步喂入 ids 时，第 t 步输出与全序列 forward 的第 t 位置逐 bit 相同。
     */
    function stepForward(M, id, st, capture) {
        const cfg = M.cfg;
        const h = cfg.n_head, kvh = cfg.n_kv_head, hd = cfg.head_dim, d = cfg.d_model;
        const EXP = M.tables.exp_lut.arr, SIG = M.tables.sig_lut.arr;
        const COS = M.tables.rope_cos.arr, SIN = M.tables.rope_sin.arr;
        const pos = st.pos;
        ensureCap(st, pos + 1, M);

        const te = M.tensors.tok_emb;
        const embShift = C.W_SHIFT - C.RES_FRAC;
        const x = new Float64Array(d);
        {
            const m = te.m[id], base = id * d;
            for (let k = 0; k < d; k++) x[k] = rshiftRound(te.q[base + k] * m, embShift);
        }
        if (capture) capture.emb = x.slice();

        const scoreNum = Math.round((1 / Math.sqrt(hd)) * Math.pow(2, C.SCORE_INV_FRAC));
        const rep = h / kvh, S = pos + 1;

        for (let i = 0; i < cfg.n_layer; i++) {
            const p = 'blocks.' + i + '.';
            const n1 = rmsnorm(x, M.norms[p + 'norm1'], 1, d);
            const qq = linear(n1, 1, d, M.tensors[p + 'q']);
            const kk = linear(n1, 1, d, M.tensors[p + 'k']);
            const vv = linear(n1, 1, d, M.tensors[p + 'v']);

            const q3 = ropeApply(qq, 1, h, hd, COS, SIN, pos);
            const k3r = ropeApply(kk, 1, kvh, hd, COS, SIN, pos);

            const kc = st.k[i], vc = st.v[i];
            for (let hh = 0; hh < h; hh++) {
                const src = hh / rep | 0, dst = (pos * h + hh) * hd;
                for (let dd = 0; dd < hd; dd++) {
                    kc[dst + dd] = k3r[src * hd + dd];
                    vc[dst + dd] = vv[src * hd + dd];
                }
            }

            const attn = new Float64Array(h * hd);
            for (let hh = 0; hh < h; hh++) {
                const sc = new Float64Array(S);
                for (let s = 0; s < S; s++) {
                    let acc = 0;
                    const kb = (s * h + hh) * hd;
                    for (let dd = 0; dd < hd; dd++) acc += q3[hh * hd + dd] * kc[kb + dd];
                    sc[s] = rshiftRound(acc * scoreNum, C.RES_FRAC + C.SCORE_INV_FRAC);
                }
                const pr = softmaxLut(sc, EXP);
                for (let dd = 0; dd < hd; dd++) {
                    let acc = 0;
                    for (let s = 0; s < S; s++) acc += pr[s] * vc[(s * h + hh) * hd + dd];
                    attn[hh * hd + dd] = rshiftRound(acc, C.RES_FRAC);
                }
            }

            const r = quantAct(attn, 1, d);
            const o = linearFromQ(r.q, r.s, 1, M.tensors[p + 'o']);
            for (let z = 0; z < d; z++) x[z] += o[z];
            if (capture) capture['blk' + i + '.attn_out'] = x.slice();

            const n2 = rmsnorm(x, M.norms[p + 'norm2'], 1, d);
            const g_ = linear(n2, 1, d, M.tensors[p + 'gate']);
            const u_ = linear(n2, 1, d, M.tensors[p + 'up']);
            const sil = siluLut(g_, SIG);
            const hid = new Float64Array(M.tensors[p + 'gate'].out);
            for (let z = 0; z < hid.length; z++) hid[z] = rshiftRound(sil[z] * u_[z], C.RES_FRAC);

            const dn = linear(hid, 1, M.tensors[p + 'down'].inn, M.tensors[p + 'down']);
            for (let z = 0; z < d; z++) x[z] += dn[z];
            if (capture) capture['blk' + i + '.out'] = x.slice();
        }

        const xf = rmsnorm(x, M.norms.final_norm, 1, d);
        if (capture) capture.final_norm = xf.slice();
        const logits = linear(xf, 1, d, M.tensors.tok_emb);

        st.pos = pos + 1;
        return { logits };
    }

    /** logits → top-K（int32 偏序：分数降序，同分 token_id 升序） */
    function topKFromLogits(logits, k) {
        const n = logits.length;
        const idx = new Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        idx.sort((a, b) => {
            const d = (logits[b] | 0) - (logits[a] | 0);
            return d !== 0 ? d : (a - b);
        });
        return Uint16Array.from(idx.slice(0, k));
    }

    /* ══════════════════ ⑥ 字节级词表 ══════════════════ */

    /* ── 候选准入：精确黑名单（非白名单） ──
     *
     * 设计原则（唯一准则）：
     *   编码端**绝不产出解码端会剥离的字符**。
     *   解码端（mergeSegments）剥的是 /[\s\u200b-\u200d\ufeff]/g，
     *   因此黑名单必须精确覆盖该集合的字节编码，一个都不能漏 ——
     *   漏一个就是「编码成功、解码必然 DESYNC」的静默数据损坏。
     *
     * 为什么不用白名单：白名单边界永远太窄。任何"只放行汉字"之类的规则
     *   都会误杀模型学到的词组与合法标点，逼 Top 候选从深层递补生僻字，
     *   实测表现为「零标点 + 语义崩塌」。
     *
     * 黑名单只堵三类真正有害的东西：
     *   ① 空白/控制/零宽 —— 会被解码端剥掉，导致字节长度不一致
     *   ② U+FFFD(EF BF BD) —— 词表里的 456 个语义垃圾
     *   ③ 特殊控制 token（含 `<|`）—— <|endoftext|> / <|pad|>
     */
    function isBlacklistedBytes(t) {
        const len = t.length;
        for (let i = 0; i < len; i++) {
            const b = t[i];

            // ①-a C0 控制符（含 \n=0x0A、\r=0x0D、\t=0x09）
            if (b < 0x20) return true;
            // ①-b 半角空格（⚠️ b<0x20 不覆盖 0x20，漏掉即静默损坏）
            if (b === 0x20) return true;
            // ①-c DEL 与 C1 控制符
            if (b === 0x7F) return true;   // DEL（0x80-0x9F 是 UTF-8 续接字节，中文里到处都是）

            // ② U+FFFD REPLACEMENT CHARACTER
            if (b === 0xEF && i + 2 < len && t[i + 1] === 0xBF && t[i + 2] === 0xBD) return true;

            // ①-d 零宽字符 U+200B..U+200D / U+FEFF
            if (b === 0xE2 && i + 2 < len && t[i + 1] === 0x80 && t[i + 2] >= 0x8B && t[i + 2] <= 0x8D) return true;
            if (b === 0xEF && i + 2 < len && t[i + 1] === 0xBB && t[i + 2] === 0xBF) return true;

            // ①-e 其余会被 \s 匹配的 Unicode 空白
            //     NBSP U+00A0
            if (b === 0xC2 && i + 1 < len && t[i + 1] === 0xA0) return true;
            //     U+1680
            if (b === 0xE1 && i + 2 < len && t[i + 1] === 0x9A && t[i + 2] === 0x80) return true;
            //     U+2000..U+200A、U+2028、U+2029、U+202F、U+205F
            if (b === 0xE2 && i + 2 < len && t[i + 1] === 0x80 &&
                ((t[i + 2] >= 0x80 && t[i + 2] <= 0x8A) || t[i + 2] === 0xA8 ||
                 t[i + 2] === 0xA9 || t[i + 2] === 0xAF)) return true;
            if (b === 0xE2 && i + 2 < len && t[i + 1] === 0x81 && t[i + 2] === 0x9F) return true;
            //     U+3000 全角空格
            if (b === 0xE3 && i + 2 < len && t[i + 1] === 0x80 && t[i + 2] === 0x80) return true;

            // ③ 特殊控制 token：`<|`（<|endoftext|> / <|pad|>）
            if (b === 0x3C && i + 1 < len && t[i + 1] === 0x7C) return true;
        }
        return false;
    }

    function loadVocab(vocabBuf, fmtVocab) {
        const n = fmtVocab.vocab_size, IB = fmtVocab.index_bytes, SB = fmtVocab.stream_bytes;
        const raw = new Uint8Array(vocabBuf);
        if (raw.length !== IB + SB) throw new Error('vocab.bin 大小不符');
        const dv = new DataView(vocabBuf);
        const toks = new Array(n);
        const offs = new Uint16Array(n);
        for (let i = 0; i < n; i++) offs[i] = dv.getUint16(i * 2, true);
        const stream = raw.subarray(IB);
        for (let i = 0; i < n; i++) {
            const a = offs[i], b = (i + 1 < n) ? offs[i + 1] : SB;
            toks[i] = stream.subarray(a, b);
        }

        // 准入标志**装载时算一次**（避免每步 ×64 次重复扫描）
        const allowed = new Uint8Array(n);
        let pass = 0;
        for (let i = 0; i < n; i++) {
            if (!isBlacklistedBytes(toks[i])) { allowed[i] = 1; pass++; }
        }

        function isPrefix(a, b) {
            if (a.length > b.length) return false;
            for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
            return true;
        }
        function matchesAt(text, pos, a) {
            if (pos + a.length > text.length) return false;
            for (let i = 0; i < a.length; i++) if (text[pos + i] !== a[i]) return false;
            return true;
        }

        return {
            size: n,
            raw: (id) => toks[id],
            isPrefix, matchesAt,
            isAllowed: (id) => allowed[id] === 1,
            allowedCount: pass,
            rejectedCount: n - pass,
        };
    }

    /* ══════════════════ ⑦ 6bit 位流 ══════════════════ */

    function unitsFromBytes(bytes, k) {
        k = k || P.BITS;
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
        k = k || P.BITS;
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

    /* ══════════════════ ⑧ 192B 定长帧 ══════════════════ */

    function fnv1a16(s) {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
        return ((h >>> 16) ^ h) & 0xffff;
    }
    function hashBytes(u8) {
        let h = 0x811c9dc5;
        for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = (h * 0x01000193) >>> 0; }
        return h >>> 0;
    }
    const nonce16 = (msgid, seq) => fnv1a16(String(msgid) + '/' + String(seq));
    const expected12 = (msgid, seq) => (((P.MAGIC ^ nonce16(msgid, seq)) & 0xffff) >>> 4) & 0xfff;

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

    function buildFrame(slice, msgid, seq) {
        if (slice.length > P.SEG_PAYLOAD) throw new Error('SLICE_TOO_LONG');
        const f = new Uint8Array(P.SEG_BYTES);
        const nn = nonce16(msgid, seq);
        const m = (P.MAGIC ^ nn) & 0xffff;
        f[0] = m >>> 8; f[1] = m & 0xff;
        f[2] = slice.length >>> 8; f[3] = slice.length & 0xff;
        f.set(slice, P.FRAME_HDR);
        const padLen = P.SEG_PAYLOAD - slice.length;
        if (padLen > 0) {
            const seed = ((m << 16) ^ Math.imul(slice.length + 1, 2654435761) ^ hashBytes(slice)) >>> 0;
            f.set(prfStream(seed, padLen), P.FRAME_HDR + slice.length);
        }
        return f;
    }

    function parseFrame(f, msgid, seq) {
        if (f.length !== P.SEG_BYTES) throw new Error('FRAME_SIZE');
        const nn = nonce16(msgid, seq);
        const m = (f[0] << 8) | f[1];
        if (((m ^ nn) & 0xffff) !== P.MAGIC) throw new Error('MAGIC_MISMATCH');
        const len = (f[2] << 8) | f[3];
        if (len > P.SEG_PAYLOAD) throw new Error('BAD_LEN');
        return f.slice(P.FRAME_HDR, P.FRAME_HDR + len);
    }

    function splitPayload(bytes) {
        const segs = [];
        for (let i = 0; i < bytes.length || segs.length === 0; i += P.SEG_PAYLOAD) {
            segs.push(bytes.slice(i, i + P.SEG_PAYLOAD));
        }
        return segs;
    }

    const segmentEnvelope = (seq, total, msgid, body) =>
        'CX2|' + seq + '/' + total + '|' + msgid + '|' + total + ':' + seq + '|' + body;

    const ENV_RE = /CX2\|(\d+)\/(\d+)\|([A-Za-z0-9]+)\|(\d+):(\d+)\|/g;

    function mergeSegments(text) {
        const s = String(text || '');
        const found = [];
        let m; ENV_RE.lastIndex = 0;
        while ((m = ENV_RE.exec(s)) !== null) {
            found.push({ at: m.index, end: ENV_RE.lastIndex, total: +m[2], mid: m[3], i: +m[5] });
        }
        if (!found.length) return { bodies: null, total: 1, got: 0, missing: [1], incomplete: true };
        const groups = new Map();
        for (const f of found) {
            if (!groups.has(f.mid)) groups.set(f.mid, []);
            groups.get(f.mid).push(f);
        }
        let best = null;
        for (const [mid, list] of groups) if (!best || list.length > best.list.length) best = { mid, list };
        const list = best.list;
        const total = Math.max.apply(null, list.map(x => x.total));
        const have = new Map(list.map(x => [x.i, x]));
        const missing = [];
        for (let i = 1; i <= total; i++) if (!have.has(i)) missing.push(i);
        const out = [];
        for (let i = 1; i <= total; i++) {
            const f = have.get(i);
            if (!f) continue;
            const next = list.find(x => x.at > f.at);
            const bodyEnd = next ? next.at : s.length;
            // 剥离一切空白与零宽字符（token 内已保证不含空白，故安全）
            out.push({ seq: i, body: s.slice(f.end, bodyEnd).replace(/[\s\u200b-\u200d\ufeff]/g, '') });
        }
        return { bodies: out, msgid: best.mid, total, got: list.length, missing, incomplete: missing.length > 0 };
    }

    /* ══════════════════ ⑨ 候选过滤 ══════════════════ */

    /**
     * 单趟贪心 prefix-free 递补。
     * 过滤顺序固定（两端必须一致）：
     *   ① 黑名单准入（空白/控制/零宽/U+FFFD/特殊 token）
     *   ② 与已接受集逐对 prefix-free
     *
     * 为什么单趟就够：沿原始 rank 从头扫，凡与已接受集兼容即收，
     * 收满 64 即止。天然闭合（集合内任意两元素必无前缀关系）且必然终止。
     * 原规范"删一个补一个"的说法不成立 —— 第 65 名自己可能又冲突，需迭代到不动点。
     */
    function resolveByteCandidates(rawIds, V, need) {
        need = need || P.NEED;
        const ids = new Array(need), bufs = new Array(need);
        let n = 0;
        const stats = { scanned: 0, rejBlack: 0, rejPrefix: 0, deepestRank: 0 };
        for (let i = 0; i < rawIds.length && n < need; i++) {
            const id = rawIds[i];
            stats.scanned++;
            if (!V.isAllowed(id)) { stats.rejBlack++; continue; }
            const s = V.raw(id);
            let bad = false;
            for (let j = 0; j < n; j++) {
                if (V.isPrefix(bufs[j], s) || V.isPrefix(s, bufs[j])) { bad = true; break; }
            }
            if (bad) { stats.rejPrefix++; continue; }
            ids[n] = id; bufs[n] = s; n++;
            stats.deepestRank = i + 1;
        }
        if (n < need) throw new Error('CANDIDATE_STARVED: ' + n + '/' + need);
        return { ids, bufs, stats };
    }

    /* ══════════════════ ⑩ 段级连续编解码 ══════════════════ */

    /* ── 让出主线程 ──
     * 前向是纯同步整数运算，256 步 ≈1.8s。若不主动让出，主线程被焊死，
     * 浏览器无法重绘 → 进度条不动、取消按钮点不动、页面假死。
     * 用 MessageChannel（macrotask，无 setTimeout 的 4ms 下限）成本最低。 */
    const _mc = (typeof MessageChannel !== 'undefined') ? new MessageChannel() : null;
    let _yieldQueue = [];
    if (_mc) {
        _mc.port1.onmessage = () => { const r = _yieldQueue.shift(); if (r) r(); };
    }
    function yieldToUI() {
        if (_mc) return new Promise(res => { _yieldQueue.push(res); _mc.port2.postMessage(0); });
        if (typeof setTimeout === 'function') return new Promise(r => setTimeout(r, 0));
        // 无 MessageChannel / setTimeout 的宿主（如测试 vm）：退化为微任务让出。
        // 仍能解除同步阻塞，只是不如宏任务彻底。
        return Promise.resolve();
    }

    const YIELD_EVERY = 16;   // 每 16 步让出一次（≈110ms 一个时间片）

    /** 段内 K 帧 = 一条连续 token 流（段字节 = K×192，token = K×256，天然整除） */
    function makeForwarder(M, V) {
        const fwd = function forward(lastTokenId, state) {
            const r = stepForward(M, lastTokenId, state);
            return { topK: topKFromLogits(r.logits, P.TOPK), nextState: state };
        };
        fwd.M = M;      // encodeSegmentReal 需要它来建初态
        fwd.V = V;
        return fwd;
    }

    async function encodeSegmentReal(segBytes, fwd, V, onStep, signal) {
        const units = unitsFromBytes(segBytes, P.BITS);
        const state = createState(fwd.M);
        let last = P.BOS;
        const parts = [];
        let total = 0;
        for (let i = 0; i < units.length; i++) {
            const r = fwd(last, state);
            const cand = resolveByteCandidates(r.topK, V);
            const u = units[i];
            parts.push(cand.bufs[u]);
            total += cand.bufs[u].length;
            last = cand.ids[u];
            if ((i & (YIELD_EVERY - 1)) === 0) {
                if (onStep) onStep(i + 1);
                await yieldToUI();                      // ← 关键：让出主线程
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
        }
        const bytes = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { bytes.set(p, o); o += p.length; }
        return new TextDecoder('utf-8').decode(bytes);
    }

    async function decodeFrameReal(textBytes, fwd, V, opts) {
        const msgid = opts.msgid, seq = opts.seq;
        const fastFail = opts.fastFail !== false;
        const signal = opts.signal;
        const state = createState(fwd.M);
        let last = P.BOS;
        const units = [];
        let cursor = 0, steps = 0;

        const bail = (msg) => { const e = new Error(msg); e.code = 'NOT_STEGO'; e.stepsUsed = steps; return e; };

        while (cursor < textBytes.length) {
            const r = fwd(last, state);
            const cand = resolveByteCandidates(r.topK, V);
            let hit = -1, hits = 0;
            for (let i = 0; i < cand.bufs.length; i++) {
                if (V.matchesAt(textBytes, cursor, cand.bufs[i])) { if (hit < 0) hit = i; hits++; }
            }
            if (hits === 0) {
                if (fastFail && steps < 4) throw bail('识别失败：文本与候选集无法对齐');
                throw new Error('DESYNC@' + cursor + '（文本可能被改动）');
            }
            if (hits > 1) throw new Error('AMBIGUOUS@' + cursor);
            units.push(hit);
            last = cand.ids[hit];
            cursor += cand.bufs[hit].length;
            steps++;
            if ((steps & (YIELD_EVERY - 1)) === 0) {
                if (opts.onStep) opts.onStep(steps);
                await yieldToUI();
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
            if (fastFail && steps === 2) {
                const got12 = ((units[0] << 6) | units[1]) & 0xfff;
                if (got12 !== expected12(msgid, seq)) throw bail('识别失败：头部校验不匹配');
            }
        }
        return bytesFromUnits(units, P.BITS);
    }

    /* ══════════════════ 对外 API ══════════════════ */

    const Stego = {
        P, C,
        loadModel, loadVocab, createState, stepForward, topKFromLogits,
        makeForwarder,
        buildFrame, parseFrame, splitPayload, segmentEnvelope, mergeSegments,
        unitsFromBytes, bytesFromUnits, resolveByteCandidates,
        fnv1a16, nonce16, expected12,
        rshiftRound, isqrt, idivFloor,

        _M: null, _V: null, ready: false,

        /** 装载资产（ArrayBuffer）。幂等。 */
        load(assets) {
            this._M = loadModel(assets);
            this._V = loadVocab(assets.vocab, this._M.fmt.vocab);
            this.ready = true;
            return this;
        },

        /**
         * 密文字节 → 分段伪装文本。
         * @returns {{segments:Array, frames:number, chars:number, ms:number}}
         */
        async encodeAll(cipherBytes, opt) {
            opt = opt || {};
            if (!this.ready) throw new Error('模型未装载');
            const M = this._M, V = this._V;
            const fwd = makeForwarder(M, V);
            const slices = splitPayload(cipherBytes);
            const framesTotal = slices.length;
            const segsTotal = Math.ceil(framesTotal / P.FRAMES_PER_SEG);
            const t0 = Date.now();
            let done = 0, doneBase = 0;
            const totalSteps = framesTotal * P.TOKENS_PER_FRAME;
            const segments = [];

            for (let s = 0; s < segsTotal; s++) {
                const first = s * P.FRAMES_PER_SEG;
                const lastF = Math.min(first + P.FRAMES_PER_SEG, framesTotal);
                const K = lastF - first;
                const segBytes = new Uint8Array(K * P.SEG_BYTES);
                for (let k = 0; k < K; k++) {
                    segBytes.set(buildFrame(slices[first + k], opt.msgid, first + k + 1), k * P.SEG_BYTES);
                }
                const body = await encodeSegmentReal(segBytes, fwd, V, (stepInSeg) => {
                    done = doneBase + stepInSeg;
                    const el = Math.max(1, Date.now() - t0) / 1000;
                    if (opt.onProgress) opt.onProgress({
                        frame: Math.min(framesTotal, Math.floor(done / P.TOKENS_PER_FRAME) + 1), framesTotal,
                        segment: s + 1, segmentsTotal: segsTotal,
                        step: done, stepsTotal: totalSteps,
                        bps: done / el,
                        etaMs: ((totalSteps - done) / Math.max(done / el, 1e-6)) * 1000,
                    });
                }, opt.signal);
                doneBase += K * P.TOKENS_PER_FRAME;
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                segments.push({ seq: s + 1, total: segsTotal, msgid: opt.msgid, body });
            }
            const chars = segments.reduce((a, x) => a + x.body.length, 0);
            return { segments, frames: framesTotal, chars, ms: Date.now() - t0 };
        },

        /** 伪装文本（可含多段信封）→ 密文字节 */
        async decodeAll(text, opt) {
            opt = opt || {};
            if (!this.ready) throw new Error('模型未装载');
            const M = this._M, V = this._V;
            const mg = mergeSegments(text);
            if (!mg.bodies) { const e = new Error('未识别为隐写文本'); e.code = 'NOT_STEGO'; throw e; }
            if (mg.incomplete) {
                const e = new Error('收到第 ' + mg.got + '/' + mg.total + ' 段，还缺第 ' + mg.missing.join('、') + ' 段');
                e.code = 'INCOMPLETE'; throw e;
            }
            const fwd = makeForwarder(M, V);
            const enc = new TextEncoder();
            const out = [];
            const t0 = Date.now();
            let done = 0;
            const framesTotal = mg.total * P.FRAMES_PER_SEG;

            for (const b of mg.bodies) {
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                const firstFrame = (b.seq - 1) * P.FRAMES_PER_SEG + 1;
                const expected = Math.min(P.FRAMES_PER_SEG, framesTotal - (b.seq - 1) * P.FRAMES_PER_SEG);
                const frameBytes = await decodeFrameReal(enc.encode(b.body), fwd, V, {
                    msgid: mg.msgid, seq: firstFrame, fastFail: true, signal: opt.signal,
                    onStep: () => {
                        done++;
                        if (opt.onProgress && done % 16 === 0) opt.onProgress({ step: done, stepsTotal: framesTotal * P.TOKENS_PER_FRAME });
                    },
                });
                const nFrames = Math.floor(frameBytes.length / P.SEG_BYTES);
                for (let i = 0; i < Math.min(nFrames, expected); i++) {
                    const frameNo = firstFrame + i;
                    out.push(parseFrame(frameBytes.subarray(i * P.SEG_BYTES, (i + 1) * P.SEG_BYTES), mg.msgid, frameNo));
                }
            }
            const total = out.reduce((a, x) => a + x.length, 0);
            const joined = new Uint8Array(total);
            let o = 0;
            for (const x of out) { joined.set(x, o); o += x.length; }
            return { bytes: joined, ms: Date.now() - t0 };
        },

        /**
         * 快速预筛：该文本是否**可能**由词表里的 token 拼成。
         * O(n) 逐字符查表，不跑模型 —— 用于在进模型前廉价否决
         * 英文/代码等明显不可能的输入。
         *
         * 注意：这是**粗筛**，宁可放过不可错杀（普通中文文章也会高分通过，
         * 真正的判定交给 Fast-Fail）。返回首字符命中率。
         */
        prefilter(text) {
            if (!this._V) return 0;
            const chars = Array.from(String(text || ''));
            if (!chars.length) return 0;
            let hit = 0;
            for (const ch of chars) {
                const cp = ch.codePointAt(0);
                // 词表覆盖：CJK 汉字、中文标点、ASCII 可见字符
                if ((cp >= 0x4E00 && cp <= 0x9FFF) ||
                    (cp >= 0x3000 && cp <= 0x303F) ||
                    (cp >= 0xFF00 && cp <= 0xFFEF) ||
                    (cp >= 0x2000 && cp <= 0x206F) ||
                    (cp >= 0x20 && cp <= 0x7E)) hit++;
            }
            return hit / chars.length;
        },
    };

    global.Stego = Stego;
})(typeof window !== 'undefined' ? window : globalThis);

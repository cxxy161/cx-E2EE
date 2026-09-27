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

    /* ══════════════════ 协议常量 ══════════════════
     *
     * ── 档位（topk）设计 ──
     * 每 token 承载 bits = log2(topk) 位。**帧长随档位走**，锚定「每帧恒定 256 token」：
     *     SEG_BYTES = 32 × bits        （因为 256×bits = 8×SEG_BYTES）
     *
     *    topk  bits  帧长   载荷   token/帧
     *      4    2    64B    60B     256
     *      8    3    96B    92B     256
     *     16    4   128B   124B     256
     *     32    5   160B   156B     256
     *     64    6   192B   188B     256   ← 默认
     *    128    7   224B   220B     256
     *    256    8   256B   252B     256
     *
     * 为什么不让帧长固定 192B：那样 5bit / 7bit 会留残位
     * （192×8=1536，1536%5=1、%7=3），档位不可用。
     * 锚定 token 数后 7 档全部整除，且帧边界恒由 token 数决定，与档位无关。
     */
    const PROFILES = [4, 8, 16, 32, 64, 128, 256].map(k => {
        const bits = Math.round(Math.log2(k));
        const segBytes = 32 * bits;
        return { topk: k, bits, segBytes, payload: segBytes - 4, tokensPerFrame: 256 };
    });
    const DEFAULT_PROFILE = 64;
    /** 候选池深度：恒取足够深，供「最大档位 + 黑名单剔除 + prefix-free 递补」消耗。
     *  实测 top256 档位最深要挖到第 443 名才能凑满 256 个
     *  （黑名单剔除 + 前缀冲突去重），故池深必须 ≥512，给 256 会饥饿。 */
    const MAX_TOPK = 512;

    /** 取档位（未知值退回默认；输入是"每 token 位数"或"topk"都接受） */
    function profileFor(v) {
        if (v == null) return PROFILES.find(p => p.topk === DEFAULT_PROFILE);
        return PROFILES.find(p => p.topk === v) || PROFILES.find(p => p.bits === v) ||
            PROFILES.find(p => p.topk === DEFAULT_PROFILE);
    }

    /* 运行期协议参数（随档位切换）。默认 = top64。 */
    const P = {
        FRAME_HDR: 4, MAGIC: 0x5354,
        /* 链长 = 一条**连续 token 流**含几帧。2 帧 = 512 token，正好用满
         * RoPE 表的 512 个可用位置。原值 3 帧 = 768 token 已经越界：
         * 实测 pos 512 与 513 输出的 logits **完全相同**（查表得 undefined，
         * 退化成一个定值）—— 编解码自洽所以往返不报错，但第 512 个 token
         * 之后的文本质量是坏的。
         *
         * 链与「显示分段」是两件事，必须解耦：
         *   链 = 编解码的**连续性**单位（状态重置点，决定互操作性）
         *   段 = 复制/发送的**排版**单位（决定要不要加段头） */
        CHAIN_FRAMES: 2,
        CHAIN_TOKENS: 512,          // = CHAIN_FRAMES × 256
        SEG_CHAR_LIMIT: 2000,       // 排版上限（QQ 单条）
        BOS: 1,
        // 以下由 applyProfile 填充
        TOPK: 64, BITS: 6, NEED: 64, SEG_BYTES: 192, SEG_PAYLOAD: 188, TOKENS_PER_FRAME: 256,
    };

    function applyProfile(v) {
        const pf = profileFor(v);
        P.TOPK = pf.topk; P.BITS = pf.bits; P.NEED = pf.topk;
        P.SEG_BYTES = pf.segBytes; P.SEG_PAYLOAD = pf.payload;
        P.TOKENS_PER_FRAME = pf.tokensPerFrame;
        P.PROFILE = pf.topk;
        return pf;
    }
    applyProfile(DEFAULT_PROFILE);

    /** 当前档位在「压缩 ↔ 通顺」轴上的定位（供 UI 文案） */
    function profileInfo(v) {
        const pf = profileFor(v);
        const idx = PROFILES.indexOf(pf);
        return {
            topk: pf.topk, bits: pf.bits, segBytes: pf.segBytes, payload: pf.payload,
            // 实测经验：bits 越大，候选挖得越深，文本越生硬但压缩越好
            compression: idx,          // 0=最通顺, 6=最压缩
            sample: pf.topk === 4 ? '几乎全是模型首选词，最像人话'
                : pf.topk === 8 ? '文本很自然'
                    : pf.topk === 16 ? '文本自然'
                        : pf.topk === 32 ? '文本较自然'
                            : pf.topk === 64 ? '均衡（默认）'
                                : pf.topk === 128 ? '文本偏生硬'
                                    : '压缩最好，文本最生硬',
        };
    }

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

    /* ── 帧 nonce：由**载荷自身**导出（自描述帧） ──
     *
     * 原实现 nonce = FNV(msgid + '/' + seq)，msgid 取自段信封，于是
     * **没有段头就绝对解不开** —— 但段头只是排版标识（把多段归到同一条
     * 消息、支持乱序拼接），不该是解密的必需品。
     *
     * 改为由载荷字节导出后，帧头自校验、自包含：
     *   有段头能解，只有正文、甚至只有裸正文也能解。
     *
     * 端点仍高度离散：载荷是密文（近似随机），故各消息首 12bit 依旧
     * 无固定指纹（docs/hanzi-prefix.md 记录的问题不会复发）。
     * 保密性无关 —— 帧头只是位流对齐校验，安全性由 CX2 的 AES-GCM 承担。 */
    function nonceOf(slice) {
        let h = 0x811c9dc5;
        for (let i = 0; i < slice.length; i++) { h ^= slice[i]; h = Math.imul(h, 0x01000193) >>> 0; }
        return ((h >>> 16) ^ h) & 0xffff;
    }

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

    function buildFrame(slice, seq) {
        if (slice.length > P.SEG_PAYLOAD) throw new Error('SLICE_TOO_LONG');
        const f = new Uint8Array(P.SEG_BYTES);
        const m = (P.MAGIC ^ nonceOf(slice)) & 0xffff;     // 自描述：由载荷导出
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

    /** 解析并**自校验**（nonce 由载荷导出，故可独立验证，不依赖信封） */
    function parseFrame(f, seq) {
        if (f.length !== P.SEG_BYTES) throw new Error('FRAME_SIZE');
        const len = (f[2] << 8) | f[3];
        if (len > P.SEG_PAYLOAD) throw new Error('BAD_LEN');
        const slice = f.slice(P.FRAME_HDR, P.FRAME_HDR + len);
        const m = (f[0] << 8) | f[1];
        if (((m ^ nonceOf(slice)) & 0xffff) !== P.MAGIC) throw new Error('MAGIC_MISMATCH');
        return slice;
    }

    /** 只做帧头自校验（用于判定「这一档位解出的字节流是不是合法的帧流」） */
    function frameMagicOk(f) {
        if (f.length !== P.SEG_BYTES) return false;
        const len = (f[2] << 8) | f[3];
        if (len > P.SEG_PAYLOAD) return false;
        const m = (f[0] << 8) | f[1];
        return (((m ^ nonceOf(f.subarray(P.FRAME_HDR, P.FRAME_HDR + len))) & 0xffff) === P.MAGIC);
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
        const strip = (x) => x.replace(/[\s\u200b-\u200d\ufeff]/g, '');
        const found = [];
        let m; ENV_RE.lastIndex = 0;
        while ((m = ENV_RE.exec(s)) !== null) {
            found.push({ at: m.index, end: ENV_RE.lastIndex, total: +m[2], mid: m[3], i: +m[5] });
        }
        /* 无段头 → **整段就是正文**。
         * 段头只是排版标识（分组 + 乱序重排），不是解密的必需品：
         * 帧 nonce 由载荷自身导出，故裸正文可独立解码。
         * 这让「复制全文（最干净）」和「只有一段」都天然可用。 */
        if (!found.length) {
            const body = strip(s);
            if (!body) return { bodies: null, total: 0, got: 0, missing: [], incomplete: true };
            return { bodies: [{ seq: 1, body }], total: 1, got: 1, missing: [], incomplete: false, bare: true };
        }
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
            out.push({ seq: i, body: strip(s.slice(f.end, bodyEnd)) });
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

    /** 一条链 = CHAIN_FRAMES 帧 = 一条连续 token 流（状态从 BOS 起步） */
    function makeForwarder(M, V) {
        const fwd = function forward(lastTokenId, state) {
            const r = stepForward(M, lastTokenId, state);
            // ⚠️ 候选池深度恒为 MAX_TOPK，**与当前档位解耦**：
            //    档位只决定"取池中前 N 名"，池子浅了会让小档位饥饿
            //    （实测 top4 时若池深=4 会 CANDIDATE_STARVED）。
            return { topK: topKFromLogits(r.logits, MAX_TOPK), nextState: state };
        };
        fwd.M = M;      // encodeChain 需要它来建初态
        fwd.V = V;
        return fwd;
    }

    /**
     * 编码**一条链**：chainBytes → 伪装文本。
     *
     * 链是编解码的连续性单位 —— 状态从 BOS 起步、连续推进。
     * 链长必须 ≤ RoPE 表的可用位置数（512），否则位置编码查表越界、
     * 退化成常量（实测 pos512 与 pos513 的 logits 完全相同）。
     */
    async function encodeChain(chainBytes, fwd, V, onStep, signal) {
        const units = unitsFromBytes(chainBytes, P.BITS);
        const state = createState(fwd.M);
        let last = P.BOS;
        const parts = [];
        let total = 0;
        for (let i = 0; i < units.length; i++) {
            const r = fwd(last, state);
            const cand = resolveByteCandidates(r.topK, V, P.NEED);
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

    /* ── 档位自动识别（全流式，链边界隐式） ──
     *
     * 接收端不知道发送端用了哪一档（2~8 bit/token），必须自己试出来。
     *
     * 关键洞察：**前向链与档位无关**。
     *   文本里第 i 个 token 是什么，是由密文决定的既定事实；
     *   档位只决定「该 token 在候选表中排第几」。
     *   所以 lastTokenId 序列对 7 个档位完全相同 → 前向只需跑一遍。
     *
     * 链边界**不需要传输**：编解码双方都按「每 CHAIN_TOKENS 个 token
     * 重置一次状态」这条确定性规则执行，边界天然对齐。
     * 于是段头（乃至分段本身）都不是解密的必需品。
     *
     * 档位淘汰靠**自描述帧头**：某档位凑满一个帧长后，用它自己的 nonce
     * 校验 Magic。16 bit 校验足以把其余档位迅速清掉。
     */
    async function decodeAuto(textBytes, fwd, V, opts) {
        opts = opts || {};
        const signal = opts.signal;
        const live = PROFILES.map(pf => ({ pf, ok: true, acc: 0, nbits: 0, bytes: [] }));
        let state = createState(fwd.M);
        let last = P.BOS;
        let cursor = 0, steps = 0;

        while (cursor < textBytes.length && live.some(L => L.ok)) {
            // 确定性链边界：与编码端同规则重置
            if (steps > 0 && steps % P.CHAIN_TOKENS === 0) {
                state = createState(fwd.M);
                last = P.BOS;
            }
            const r = fwd(last, state);
            let needMax = 0;
            for (const L of live) if (L.ok && L.pf.topk > needMax) needMax = L.pf.topk;
            if (needMax === 0) break;
            const cand = resolveByteCandidates(r.topK, V, needMax);

            // 文本在当前候选表中的位置（与档位无关）
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

            // 各档位按自己的位宽累计
            for (const L of live) {
                if (!L.ok) continue;
                if (hit >= L.pf.topk) { L.ok = false; continue; }   // 名次超出该档位范围
                L.acc = ((L.acc << L.pf.bits) | hit) >>> 0;
                L.nbits += L.pf.bits;
                while (L.nbits >= 8) {
                    L.nbits -= 8;
                    L.bytes.push((L.acc >>> L.nbits) & 0xff);
                }
                L.acc = L.nbits ? (L.acc & ((1 << L.nbits) - 1)) : 0;
                // 凑满一个帧长即用**自描述帧头**校验（16bit，极强的淘汰判据）
                const fb = L.pf.segBytes;
                if (L.bytes.length >= fb) {
                    const f = new Uint8Array(L.bytes.slice(0, fb));
                    if (!frameMagicOk(f)) L.ok = false;
                }
            }

            last = cand.ids[hit];
            cursor += cand.bufs[hit].length;
            steps++;
            if ((steps & 7) === 0 && opts.onChars) opts.onChars(cursor);
            if ((steps & (YIELD_EVERY - 1)) === 0) {
                if (opts.onStep) opts.onStep(steps);
                if (opts.onChars) opts.onChars(cursor);
                await yieldToUI();
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
        }
        if (opts.onChars) opts.onChars(cursor);

        const winner = live.filter(L => L.ok);
        if (!winner.length) {
            const e = new Error('这段内容不是隐写文本');
            e.code = 'NOT_STEGO'; e.stepsUsed = steps;
            throw e;
        }
        // 多档位同时存活说明文本太短（尚未凑满任何一档的帧长），取位宽最小者（最保守）
        winner.sort((a, b) => a.pf.bits - b.pf.bits);
        const W = winner[0];
        return { bytes: Uint8Array.from(W.bytes), profile: W.pf.topk, candidates: winner.length, steps };
    }

    /* ══════════════════ 对外 API ══════════════════ */

    const Stego = {
        P, C,
        loadModel, loadVocab, createState, stepForward, topKFromLogits,
        makeForwarder,
        buildFrame, parseFrame, frameMagicOk, splitPayload, segmentEnvelope, mergeSegments,
        unitsFromBytes, bytesFromUnits, resolveByteCandidates,
        fnv1a16, nonceOf, nonce16,
        rshiftRound, isqrt, idivFloor,

        /* ── 档位（高级设置） ── */
        PROFILES, profileFor, profileInfo, applyProfile, MAX_TOPK,
        get profile() { return P.PROFILE; },

        _M: null, _V: null, ready: false,

        /** 装载资产（ArrayBuffer）。幂等。 */
        load(assets) {
            this._M = loadModel(assets);
            this._V = loadVocab(assets.vocab, this._M.fmt.vocab);
            this.ready = true;
            return this;
        },

        /**
         * 密文字节 → 伪装文本。
         *
         * 两层结构，**必须分清**（原来混为一谈，是「1800 字莫名分段」的根因）：
         *   链 chain  = 编解码的**连续性**单位（状态重置点，≤ RoPE 表 512 位置）
         *   段 segment= 复制/发送的**排版**单位（只影响要不要加段头）
         *
         * 段永远由**整数条链**组成，保证段的 token 数是 CHAIN_TOKENS 的整数倍，
         * 接收端按同一条「每 CHAIN_TOKENS 重置」规则即可逐段对齐，
         * 无需任何传输字段说明段里装了几条链。
         *
         * @returns {{segments:Array, frames:number, chains:number, chars:number, ms:number}}
         */
        async encodeAll(cipherBytes, opt) {
            opt = opt || {};
            if (!this.ready) throw new Error('模型未装载');
            const M = this._M, V = this._V;
            const fwd = makeForwarder(M, V);
            const slices = splitPayload(cipherBytes);
            const framesTotal = slices.length;
            const chainsTotal = Math.ceil(framesTotal / P.CHAIN_FRAMES);
            const t0 = Date.now();
            let done = 0;
            const totalSteps = framesTotal * P.TOKENS_PER_FRAME;
            const msgid = opt.msgid || Math.random().toString(36).slice(2, 6);

            /* 先逐条链编码，再贪心打包成段（段的字数只有编完才知道，
             * 故不能预先按固定链数分段）。 */
            const chainTexts = [];
            for (let c = 0; c < chainsTotal; c++) {
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                const first = c * P.CHAIN_FRAMES;
                const K = Math.min(P.CHAIN_FRAMES, framesTotal - first);
                const chainBytes = new Uint8Array(K * P.SEG_BYTES);
                for (let k = 0; k < K; k++) {
                    chainBytes.set(buildFrame(slices[first + k], first + k + 1), k * P.SEG_BYTES);
                }
                const doneBase = done;
                const body = await encodeChain(chainBytes, fwd, V, (stepInChain) => {
                    done = doneBase + stepInChain;
                    const el = Math.max(1, Date.now() - t0) / 1000;
                    if (opt.onProgress) opt.onProgress({
                        frame: Math.min(framesTotal, Math.floor(done / P.TOKENS_PER_FRAME) + 1), framesTotal,
                        chain: c + 1, chainsTotal,
                        step: done, stepsTotal: totalSteps,
                        bps: done / el,
                        etaMs: ((totalSteps - done) / Math.max(done / el, 1e-6)) * 1000,
                    });
                }, opt.signal);
                chainTexts.push({ frames: K, body });
                done = doneBase + K * P.TOKENS_PER_FRAME;
            }

            // 贪心打包：整条链为单位装进段，段字数 ≤ SEG_CHAR_LIMIT
            const groups = [];
            let cur = null;
            for (const ct of chainTexts) {
                const wouldBe = (cur ? cur.chars : 0) + ct.body.length;
                if (cur && wouldBe > P.SEG_CHAR_LIMIT) { groups.push(cur); cur = null; }
                if (!cur) cur = { chains: [], chars: 0, frames: 0 };
                cur.chains.push(ct.body); cur.chars += ct.body.length; cur.frames += ct.frames;
            }
            if (cur) groups.push(cur);

            const segsTotal = groups.length;
            const segments = groups.map((g, i) => ({
                seq: i + 1, total: segsTotal, msgid,
                frames: g.frames, chains: g.chains.length,
                body: g.chains.join(''),
            }));
            const chars = segments.reduce((a, x) => a + x.body.length, 0);
            return { segments, frames: framesTotal, chains: chainsTotal, chars, ms: Date.now() - t0 };
        },

        /**
         * 伪装文本 → 密文字节。
         *
         * 三种输入都能解（段头**只是排版标识**，不是解密的必需品）：
         *   ① 带段头（按段复制/乱序粘贴）→ 按 seq 归位后逐段解
         *   ② 无段头全文（「复制全文」）→ 整段当一条连续流解
         *   ③ 单段裸正文 → 同 ②
         */
        async decodeAll(text, opt) {
            opt = opt || {};
            if (!this.ready) throw new Error('模型未装载');
            const M = this._M, V = this._V;
            const mg = mergeSegments(text);
            if (!mg.bodies || !mg.bodies.length) {
                const e = new Error('这段内容不是隐写文本'); e.code = 'NOT_STEGO'; throw e;
            }
            if (mg.incomplete) {
                const e = new Error('收到第 ' + mg.got + '/' + mg.total + ' 段，还缺第 ' +
                    mg.missing.join('、') + ' 段');
                e.code = 'INCOMPLETE'; throw e;
            }
            const fwd = makeForwarder(M, V);
            const enc = new TextEncoder();
            const out = [];
            const t0 = Date.now();
            /* 进度以**字符**为单位（用户看到的是字数）。
             * decodeAuto 内部按 UTF-8 **字节**推进 cursor，故必须先把每段
             * 的「字节 offset → 字符数」映射算好，否则 1 个汉字算 3 个字节，
             * 分子会以约 3 倍速度冲过字符分母（实测 12071/4096 并显示 100%）。 */
            const totalChars = mg.bodies.reduce((a, b) => a + b.body.length, 0);
            // 预编码每段，并建 offset→char 表（只在 token 边界查询，粒度足够）
            const encBodies = mg.bodies.map(b => enc.encode(b.body));
            const charAtByte = encBodies.map((u8, bi) => {
                // byteOff → 该字节属于第几个 JS 字符。只在 token 边界查询，粒度足够。
                const s = mg.bodies[bi].body;
                const map = new Uint32Array(u8.length + 1);
                let byteOff = 0, charIdx = 0;
                for (const ch of s) {                       // 按码点迭代（正确处理代理对）
                    const cp = ch.codePointAt(0);
                    const need = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
                    for (let k = 0; k < need && byteOff + k <= u8.length; k++) map[byteOff + k] = charIdx;
                    byteOff += need;
                    charIdx += ch.length;                   // 代理对占 2 个 JS 字符
                }
                for (let k = byteOff; k <= u8.length; k++) map[k] = charIdx;
                return map;
            });
            let charsDone = 0;
            let detected = 0;

            for (let bi = 0; bi < mg.bodies.length; bi++) {
                const b = mg.bodies[bi];
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                const base = charsDone;
                // ① 自动识别档位并解出字节流（档位由文本自身决定，无需用户指定）
                const auto = await decodeAuto(encBodies[bi], fwd, V, {
                    signal: opt.signal,
                    onStep: () => {},
                    onChars: (byteOff) => {
                        const map = charAtByte[bi];
                        const done = base + map[Math.min(byteOff, map.length - 1)];
                        if (done < charsDone) return;         // 单调保护
                        charsDone = done;
                        if (opt.onProgress) opt.onProgress({
                            chars: charsDone, charsTotal: totalChars,
                            segment: b.seq, segmentsTotal: mg.total,
                        });
                    },
                });
                charsDone = base + b.body.length;
                if (opt.onProgress) opt.onProgress({
                    chars: charsDone, charsTotal: totalChars,
                    segment: b.seq, segmentsTotal: mg.total,
                });
                detected = auto.profile;
                // 用识别出的档位切帧
                const segBytes = 32 * Math.round(Math.log2(auto.profile));
                const frameBytes = auto.bytes;
                const nFrames = Math.floor(frameBytes.length / segBytes);
                for (let i = 0; i < nFrames; i++) {
                    try {
                        out.push(parseFrame(frameBytes.subarray(i * segBytes, (i + 1) * segBytes), i + 1));
                    } catch (e) { break; }   // 尾部残帧：链末对齐不足，丢弃
                }
            }
            const total = out.reduce((a, x) => a + x.length, 0);
            const joined = new Uint8Array(total);
            let o = 0;
            for (const x of out) { joined.set(x, o); o += x.length; }
            return { bytes: joined, ms: Date.now() - t0, profile: detected, segments: mg.total, bare: !!mg.bare };
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

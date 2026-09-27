/* ═══════════════════════════════════════════════════════════════════
 * pcd-v3-6M 全整数定点内核（JS）—— int_ref.py 的忠实移植
 * ═══════════════════════════════════════════════════════════════════
 *
 * 零浮点：推理路径上只有整数加减乘、2 的幂除法、查表、整数开方。
 * 逐 bit 可复现：与 int_ref.py 的移位/舍入语义完全一致。
 *
 * ── 与 README 的三处偏差（本实现有意纠正，均有实测反例） ──
 *
 * [1] README §3 的 JS rshiftRound 是错的
 *       return x >= 0 ? (x + b) >> s : ...
 *     JS 的 `>>` 先做 ToInt32，而本模型中间量最大 ≈2^45.7（实测
 *     rmsnorm 的 num = 5.56e13），一进 `>>` 就被截断。
 *     实测 rshiftRound(55574230881045, 28)：
 *       README 版 = 6        正确版 = 207030
 *     正确做法用 2 的幂做除法：本模型所有中间量 ≤ 2^45.7 < 2^53，
 *     而除以 2^s 在 IEEE754 下只是指数减 s，**精确无舍入**。
 *
 * [2] README §2 的 (hi<<16)+lo int64 拆分同样因 `<<` 而错
 *     实测 acc=12387072, M=5431 时该式得 -1445288704，真值 67274188032。
 *     但**根本不需要拆分**：实测最坏 acc*M = 6.7e10 ≈ 2^36，
 *     远在 2^53 之内，直接 acc*M 在 double 下精确。
 *
 * [3] README §6 称"456 个 token 是非法的局部 UTF-8 字节（半个汉字）"
 *     —— 术语误述。实测这 456 个 token 的字节是字面 `EF BF BD`
 *     （U+FFFD 替换字符，**本身是合法 UTF-8**）。
 *     真正的"非法不完整序列"token 数 = **0**。
 *     危害不是"解码转出 \ufffd 导致字节损坏"，而是：
 *       (a) 它们是语义垃圾，不能进伪装文本；
 *       (b) 其中 416 个 id **字节完全相同**（efbfbd），若不做去重/前缀判定
 *           会让 64 名候选里出现大量重复项，解码端命中不唯一。
 *     故候选管线必须以**字节**判定并按"含 U+FFFD 即拒 + 逐对去重"处理。
 */

import { readFileSync } from 'node:fs';

/* ══════════════════ 整数原语 ══════════════════ */

/** 算术右移 + 半值远离零。唯一舍入方式。零浮点（2 的幂除法）。 */
export function rshiftRound(x, s) {
    if (s === 0) return x;
    if (s < 0) return x * Math.pow(2, -s);
    const b = Math.pow(2, s - 1);
    const d = Math.pow(2, s);
    return x >= 0 ? Math.floor((x + b) / d) : -Math.floor((-x + b) / d);
}

/** 非负整数地板除（对浮点误差做一次校正） */
function idivFloor(a, b) {
    let q = Math.floor(a / b);
    if (q * b > a) q--;
    else if ((q + 1) * b <= a) q++;
    return q;
}

/** floor(log2(x)) + 1，x > 0 */
export function bitlen(x) {
    let r = 0;
    while (x > 0) { r++; x = Math.floor(x / 2); }
    return r;
}

/** 整数平方根（逐位恢复法，纯整数） */
export function isqrt(n) {
    if (n <= 0) return 0;
    let res = 0;
    let bit = 1;
    while (bit * 4 <= n) bit *= 4;          // bit 最大 ≤ n < 2^53
    while (bit > 0) {
        if (n >= res + bit) { n -= res + bit; res = Math.floor(res / 2) + bit; }
        else { res = Math.floor(res / 2); }
        bit = Math.floor(bit / 4);
    }
    return res;
}

/* ══════════════════ 常量 ══════════════════ */
export const C = {
    RES_FRAC: 12, W_SHIFT: 20, NORM_FRAC: 12, INV_FRAC: 30,
    LUT_FRAC: 15, ROPE_FRAC: 14, SCORE_INV_FRAC: 16,
    EXP_LUT_N: 8192, EXP_LUT_MAX: 16, SIG_LUT_N: 8192, SIG_LUT_MAX: 16, Q_MAX: 127,
};

/* ══════════════════ 资产加载 ══════════════════ */
export function loadModel(modelDir) {
    const fmt = JSON.parse(readFileSync(modelDir + '/format.json', 'utf8'));
    const W = readFileSync(modelDir + '/weights.bin');
    const NB = readFileSync(modelDir + '/norm.bin');
    const TB = readFileSync(modelDir + '/tables.bin');

    const tensors = {};
    for (const t of fmt.tensors) {
        const [out, inn] = t.shape;
        const q = new Int8Array(W.buffer, W.byteOffset + t.q_offset, t.q_bytes);
        const m = new Int32Array(t.m_count);
        for (let i = 0; i < t.m_count; i++) m[i] = W.readInt32LE(t.m_offset + i * 4);
        tensors[t.name] = { q, m, out, inn };
    }
    const norms = {};
    for (const e of fmt.norms.entries) {
        const g = new Int32Array(e.count);
        for (let i = 0; i < e.count; i++) g[i] = NB.readInt32LE(e.offset + i * 4);
        norms[e.name] = g;
    }
    const tables = {};
    for (const t of fmt.tables) {
        const n = t.shape.reduce((a, b) => a * b, 1);
        const arr = new Int32Array(n);
        for (let i = 0; i < n; i++) arr[i] = TB.readInt32LE(t.offset + i * 4);
        tables[t.name] = { arr, shape: t.shape };
    }
    return { fmt, tensors, norms, tables, cfg: fmt.arch };
}

/* ══════════════════ 算子 ══════════════════ */

/** 激活量化：int32 定点 → (int8 行, 每行 shift) */
export function quantAct(x, T, d) {
    const q = new Int8Array(T * d);
    const s = new Int32Array(T);
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

/** 整数线性层（已量化激活）：y = qx @ qw^T，含逐行 M 反量化 */
export function linearFromQ(qx, sx, T, Wt, outFrac = C.RES_FRAC) {
    const { q: qw, m: mw, out, inn } = Wt;
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

/** 便于对齐：内部自行量化 */
export function linear(x, T, dIn, Wt, outFrac = C.RES_FRAC) {
    const { q, s } = quantAct(x, T, dIn);
    return linearFromQ(q, s, T, Wt, outFrac);
}

/** 整数 RMSNorm。坑 [C]：必须先开方再整除 */
export function rmsnorm(x, g, T, d) {
    const out = new Float64Array(T * d);
    const invF = C.INV_FRAC;
    for (let t = 0; t < T; t++) {
        let ss = 0;
        for (let k = 0; k < d; k++) { const v = x[t * d + k]; ss += v * v; }
        const msq = Math.max(idivFloor(ss, d), 1);
        const s = Math.max(isqrt(msq), 1);
        const inv = idivFloor(Math.pow(2, invF), s);
        const shift = invF + C.NORM_FRAC - C.RES_FRAC;
        for (let k = 0; k < d; k++) {
            out[t * d + k] = rshiftRound(x[t * d + k] * inv * g[k], shift);
        }
    }
    return out;
}

/** 整数 SiLU：查 SIG_LUT */
export function siluLut(x, sigLut) {
    const out = new Float64Array(x.length);
    const span = C.SIG_LUT_MAX * Math.pow(2, C.RES_FRAC);   // 65536
    for (let i = 0; i < x.length; i++) {
        const v = x[i];
        let idx = idivFloor((v + span) * (C.SIG_LUT_N - 1), 2 * span);
        if (idx < 0) idx = 0; else if (idx > C.SIG_LUT_N - 1) idx = C.SIG_LUT_N - 1;
        out[i] = rshiftRound(v * sigLut[idx], C.LUT_FRAC);
    }
    return out;
}

/** 整数 softmax：max 减除 → EXP_LUT → 非负整除 */
export function softmaxLut(scores, expLut, outFrac = C.RES_FRAC) {
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
        e[i] = expLut[idx];
        sum += e[i];
    }
    if (sum < 1) sum = 1;
    const mul = Math.pow(2, outFrac);
    const p = new Float64Array(S);
    for (let i = 0; i < S; i++) p[i] = idivFloor(e[i] * mul, sum);
    return p;
}

/**
 * 整数 RoPE（chunk-half）。
 * @param pos0 起始位置。全序列前向 pos0=0；KV Cache 增量步传当前位置 p。
 */
export function ropeApply(x, T, H, hd, cos, sin, pos0 = 0) {
    const half = hd >> 1;
    const out = new Float64Array(T * H * hd);
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

/* ══════════════════ 前向（全序列，无 KV Cache） ══════════════════ */
export function forward(M, ids, capture = null) {
    const cfg = M.cfg;
    const T = ids.length, h = cfg.n_head, kvh = cfg.n_kv_head, hd = cfg.head_dim, d = cfg.d_model;
    const EXP = M.tables.exp_lut.arr, SIG = M.tables.sig_lut.arr;
    const COS = M.tables.rope_cos.arr, SIN = M.tables.rope_sin.arr;

    const te = M.tensors.tok_emb;
    let x = new Float64Array(T * d);
    const embShift = C.W_SHIFT - C.RES_FRAC;
    for (let t = 0; t < T; t++) {
        const id = ids[t], m = te.m[id], base = id * d;
        for (let k = 0; k < d; k++) x[t * d + k] = rshiftRound(te.q[base + k] * m, embShift);
    }
    if (capture) capture.emb = x.slice();

    const scoreNum = Math.round((1 / Math.sqrt(hd)) * Math.pow(2, C.SCORE_INV_FRAC));

    for (let i = 0; i < cfg.n_layer; i++) {
        const p = 'blocks.' + i + '.';
        const n1 = rmsnorm(x, M.norms[p + 'norm1'], T, d);
        const qq = linear(n1, T, d, M.tensors[p + 'q']);
        const kk = linear(n1, T, d, M.tensors[p + 'k']);
        const vv = linear(n1, T, d, M.tensors[p + 'v']);

        const q3 = ropeApply(qq, T, h, hd, COS, SIN, 0);
        const k3r = ropeApply(kk, T, kvh, hd, COS, SIN, 0);

        const rep = h / kvh;
        const k3 = new Float64Array(T * h * hd);
        const v3 = new Float64Array(T * h * hd);
        for (let t = 0; t < T; t++) {
            for (let hh = 0; hh < h; hh++) {
                const src = hh / rep | 0;
                for (let dd = 0; dd < hd; dd++) {
                    k3[(t * h + hh) * hd + dd] = k3r[(t * kvh + src) * hd + dd];
                    v3[(t * h + hh) * hd + dd] = vv[(t * hd * kvh) + (src * hd) + dd];
                }
            }
        }

        const attn = new Float64Array(T * h * hd);
        for (let hh = 0; hh < h; hh++) {
            for (let t = 0; t < T; t++) {
                const sc = new Float64Array(t + 1);
                for (let s = 0; s <= t; s++) {
                    let acc = 0;
                    for (let dd = 0; dd < hd; dd++) {
                        acc += q3[(t * h + hh) * hd + dd] * k3[(s * h + hh) * hd + dd];
                    }
                    sc[s] = rshiftRound(acc * scoreNum, C.RES_FRAC + C.SCORE_INV_FRAC);
                }
                const pr = softmaxLut(sc, EXP);
                for (let dd = 0; dd < hd; dd++) {
                    let acc = 0;
                    for (let s = 0; s <= t; s++) acc += pr[s] * v3[(s * h + hh) * hd + dd];
                    attn[(t * h + hh) * hd + dd] = rshiftRound(acc, C.RES_FRAC);
                }
            }
        }

        const r = quantAct(attn, T, d);
        const o = linearFromQ(r.q, r.s, T, M.tensors[p + 'o']);
        for (let z = 0; z < T * d; z++) x[z] += o[z];
        if (capture) capture['blk' + i + '.attn_out'] = x.slice();

        const n2 = rmsnorm(x, M.norms[p + 'norm2'], T, d);
        const g_ = linear(n2, T, d, M.tensors[p + 'gate']);
        const u_ = linear(n2, T, d, M.tensors[p + 'up']);
        const sil = siluLut(g_, SIG);
        const hid = new Float64Array(T * M.tensors[p + 'gate'].out);
        for (let z = 0; z < hid.length; z++) hid[z] = rshiftRound(sil[z] * u_[z], C.RES_FRAC);

        const dn = linear(hid, T, M.tensors[p + 'down'].inn, M.tensors[p + 'down']);
        for (let z = 0; z < T * d; z++) x[z] += dn[z];
        if (capture) capture['blk' + i + '.out'] = x.slice();
    }

    const xf = rmsnorm(x, M.norms.final_norm, T, d);
    if (capture) capture.final_norm = xf.slice();
    const logits = linear(xf, T, d, M.tensors.tok_emb);
    return { logits, T, vocab: te.out };
}

/* ══════════════════ KV Cache ══════════════════
 *
 * 契约：
 *   const st = createState(M);            // 空缓存，pos=0
 *   logits   = stepForward(M, id, st);    // 前向 1 个 token，返回该位置 logits
 *
 * 等价性：stepForward 逐步喂入 ids 序列，其第 t 步输出必须与
 *         forward(M, ids.slice(0,t+1)) 的最后一个位置**逐 bit 相同**。
 *         K/V 缓存只是等价变换，不改变任何中间量。
 */

export function createState(M) {
    const cfg = M.cfg;
    const nLayer = cfg.n_layer;
    return {
        M,
        pos: 0,
        // 每层缓存：K/V 为 [maxPos, n_head, head_dim]，与全序列路径同一布局
        k: Array.from({ length: nLayer }, () => new Float64Array(0)),
        v: Array.from({ length: nLayer }, () => new Float64Array(0)),
        cap: 0,
        _capture: null,
    };
}

function ensureCap(st, need) {
    const M = st.M, cfg = M.cfg;
    if (st.cap >= need) return;
    let cap = st.cap || 64;
    while (cap < need) cap *= 2;
    const per = cap * cfg.n_head * cfg.head_dim;
    for (let i = 0; i < cfg.n_layer; i++) {
        const k = new Float64Array(per); k.set(st.k[i]); st.k[i] = k;
        const v = new Float64Array(per); v.set(st.v[i]); st.v[i] = v;
    }
    st.cap = cap;
}

/**
 * 单 token 增量前向。返回 { logits: Float64Array(vocab) }。
 * @param st  由 createState 创建并跨步复用
 * @param id  当前 token id
 */
export function stepForward(M, id, st, capture = null) {
    const cfg = M.cfg;
    const h = cfg.n_head, kvh = cfg.n_kv_head, hd = cfg.head_dim, d = cfg.d_model;
    const EXP = M.tables.exp_lut.arr, SIG = M.tables.sig_lut.arr;
    const COS = M.tables.rope_cos.arr, SIN = M.tables.rope_sin.arr;
    const pos = st.pos;
    ensureCap(st, pos + 1);

    const te = M.tensors.tok_emb;
    const embShift = C.W_SHIFT - C.RES_FRAC;
    let x = new Float64Array(d);
    {
        const m = te.m[id], base = id * d;
        for (let k = 0; k < d; k++) x[k] = rshiftRound(te.q[base + k] * m, embShift);
    }
    if (capture) capture.emb = x.slice();

    const scoreNum = Math.round((1 / Math.sqrt(hd)) * Math.pow(2, C.SCORE_INV_FRAC));
    const rep = h / kvh;
    const S = pos + 1;

    for (let i = 0; i < cfg.n_layer; i++) {
        const p = 'blocks.' + i + '.';
        const n1 = rmsnorm(x, M.norms[p + 'norm1'], 1, d);
        const qq = linear(n1, 1, d, M.tensors[p + 'q']);   // [1, h*hd]
        const kk = linear(n1, 1, d, M.tensors[p + 'k']);   // [1, kvh*hd]
        const vv = linear(n1, 1, d, M.tensors[p + 'v']);

        const q3 = ropeApply(qq, 1, h, hd, COS, SIN, pos);      // 位置 pos
        const k3r = ropeApply(kk, 1, kvh, hd, COS, SIN, pos);

        // 写入本层缓存：K/V 复制到 n_head（GQA）
        const kc = st.k[i], vc = st.v[i];
        for (let hh = 0; hh < h; hh++) {
            const src = hh / rep | 0;
            const dst = (pos * h + hh) * hd;
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
    return { logits, T: 1, vocab: te.out };
}

/* ══════════════════ FNV-1a 64 ══════════════════ */
export function fnv1a64I32(arr) {
    const buf = new Uint8Array(arr.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < arr.length; i++) dv.setInt32(i * 4, arr[i] | 0, true);
    let h = 0xcbf29ce484222325n;
    const p = 0x100000001b3n, m = (1n << 64n) - 1n;
    for (let i = 0; i < buf.length; i++) { h ^= BigInt(buf[i]); h = (h * p) & m; }
    return h;
}

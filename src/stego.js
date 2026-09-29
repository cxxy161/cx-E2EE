/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写适配层 · 算法核心（浏览器版）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 纯 script 加载，无 ESM / 无构建 / 无依赖 → window.Stego
 *
 * ══ 分层边界（严格） ══
 *   加密系统 CX2（机密性 + 鉴权）
 *        │  纯二进制 Payload
 *        ▼
 *   本文件 = **语言隐写 Codec**：二进制 ↔ 伪装文本的流式无损转换器。
 *   它不认识密钥、公钥、加密开销，也不提供任何机密性。
 *        │  伪装文本
 *        ▼
 *   传输层（段信封 / 排版分段）—— 见 src/stego-transport.js 与 stego-ui.js
 *
 * ══ ver=3（本版）：滑窗重归一化 + 长度头自定界 ══
 *   [uint16 BE actual_len][payload] → 区间编码 → token 流（链首 1 汉字签名）
 *   解码端解够 2+actual_len 字节**立即刹车**，尾部比特丢弃。
 *
 *   ✗ 定长桶 / PRF 填充 / Magic 帧头 / 整块坍缩 —— 全部废除。
 *   ver=1/2 的历史实现冻结在 src/stego-legacy.js，仅用于解旧文本。
 *
 * 组成：
 *   ① 整数原语（零浮点推理路径）
 *   ② 协议常量（ver=3 滑窗 / 历史档位）
 *   ③ 定点内核（int_ref.py 的忠实实现）+ KV Cache
 *   ④ 字节级词表（绝不对单 token 做 TextDecoder）
 *   ⑤ 候选池（字符集 + 逐对 prefix-free）
 *   ⑥ ver=3 滑窗区间编解码（encodeChunk3 / decodeChunk3）
 *   ⑦ 整数 CDF + cap 调度
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

    /* ══════════════════ 协议常量（ver=3） ══════════════════
     *
     * ── 与加密系统的边界 ──
     *   本层是**纯二进制 ↔ 伪装文本的流式无损转换器**：
     *   入参出参只有 Uint8Array / string，不认识任何密钥、公钥、加密开销。
     *   机密性与鉴权 100% 由 CX2（AES-GCM）承担，本层不提供任何机密性。
     *
     * ── 已彻底废弃（不得以任何形式复活） ──
     *   ✗ 定长桶 / 定长帧：SEG_BYTES=288、SEG_PAYLOAD=284、192B/188B 档位表
     *   ✗ 向上取整的 PRF 填充（有多少字节就编多少字节）
     *   ✗ Magic 固定帧头、Len 字段、nonce⊕Magic 自校验
     *   ✗ 整块区间坍缩（hi-lo==1）—— 它逼着解码端必须预知块长且必须演完整块
     *   历史 ver=1/2 的实现已冻结进 src/stego-legacy.js，仅用于解旧文本。
     *
     * ── ver=3 的流式自定界（本改造的核心） ──
     *   编码端在送给区间编解码器的字节流**最前端**固定加 2 字节长度头：
     *
     *       [uint16 BE: actual_len] + [payload: actual_len 字节]
     *
     *   解码端优先解出前 2 字节得 actual_len，每还原 1 个有效字节计数 +1，
     *   累计到 2+actual_len 时**立即强制终止**前向推演与状态回环，
     *   尾部因 token 生成引入的多余比特一律丢弃。
     */

    /* ── 链（chunk）：编解码的连续性单位 ──
     * 链 = 一条连续 token 流，状态从 BOS 起步。CHAIN_TOKENS 是 RoPE 位置表
     * 长度，故**每条链的 token 数硬上限**就是它。 */
    const CHAIN_TOKENS = 512;

    /* ── 每链明文上限（变长分块的分块尺寸） ──
     * 与定长桶的区别：最后一链**想多短就多短**，不再向上补齐到桶长。
     * 由预算反推：链路吞吐 ≈5 bit/token，512 token ≈ 320B，取 256B 留余量。 */
    const CHUNK_MAX = 256;

    /* ── 滑窗位宽 ──
     * W=40 → 5 字节预取；顶部 8 bit 一旦确定就吐字节并左移，r ≤ 2^40。
     * 吐字节条件 floor(lo/2^32)==floor((lo+r-1)/2^32) ⇒ r ≤ 2^32，
     * 故左移 8 位后 r ≤ 2^40、lo < 2^40，加法永不进位到已吐出的字节 ——
     * 不需要 LZMA 那套 cache/carry 机制。 */
    const W_BITS = 40n;
    const W_SHIFT = 32n;             // = W_BITS - 8
    const W_INIT_BYTES = 5;          // = W_BITS / 8
    const W_TOP = 1n << W_SHIFT;

    /* ── cap 调度的预算基准必须**两端同值，且与 actual_len 无关** ──
     * 解码端在解出前 2 字节时还不知道 actual_len；若 cap 依赖真实长度，
     * 两端判断必然分叉 ⇒ DESYNC。故一律用这条协议常量。 */
    const TOTAL_BITS = 8 * (CHUNK_MAX + 2);

    /* ── 候选池（区间编码唯一路径，常数池深） ──
     * 档位（"压缩↔通顺"权衡）已随 ver=2 一并移除：区间编码下池深是常数。 */
    const RANGE_POOL = 256;
    const RANGE_BUDGET = CHAIN_TOKENS;   // 每链 token 预算 = RoPE 硬上限

    /* ── 历史档位表（**仅 ver=1 解码用**，新路径不得引用） ──
     * bits→帧长 = 32×bits，是 192B 定长桶时代的产物，保留只为读懂旧文本。 */
    const PROFILES = [4, 8, 16, 32, 64, 128, 256].map(k => {
        const bits = Math.round(Math.log2(k));
        const segBytes = 32 * bits;
        return { topk: k, bits, segBytes, payload: segBytes - 4, tokensPerFrame: 256 };
    });
    const DEFAULT_PROFILE = 64;
    const MAX_TOPK = 512;
    const RANGE_POOL_IDX = 1;        // 历史 ver=2 签名里的池档位（恒 1）

    /** 运行期协议参数。
     *  ver：3 = 滑窗重归一化（默认）；1/2 = 历史 Codec，仅解码（stego-legacy.js）。 */
    const P = {
        /* 历史字段：仅供 legacy 冻结件经 frameGeometry() 读取，新路径不碰。
         * SEG_BYTES/SEG_PAYLOAD 在此**只对 ver=1/2 有意义** —— 新编码路径不存在
         * 定长桶，任何新代码都不得读它们来决定行为。 */
        FRAME_HDR: 4, MAGIC: 0x5354,
        CHAIN_FRAMES: 1,
        CHAIN_TOKENS: CHAIN_TOKENS,
        SEG_CHAR_LIMIT: 2000,     // 排版上限（QQ 单条），**不是**解码必需字段
        BOS: 1,

        VER: 3,
        CHUNK_MAX: CHUNK_MAX,
        W_BITS: W_BITS, W_SHIFT: W_SHIFT, W_INIT_BYTES: W_INIT_BYTES,
        TOTAL_BITS: TOTAL_BITS,
        RANGE_POOL: RANGE_POOL,

        /* 仅当 ver 切到 1/2 时才有值 */
        TOPK: 0, BITS: 0, NEED: 0, SEG_BYTES: 0, SEG_PAYLOAD: 0, TOKENS_PER_FRAME: 0,
    };

    function profileFor(v) {
        if (v == null) return PROFILES.find(p => p.topk === DEFAULT_PROFILE);
        if (v && v.segBytes) return v;
        if (v && (v.topk != null || v.TOPK != null)) return v;
        return PROFILES.find(p => p.topk === v) || PROFILES.find(p => p.bits === v) ||
            PROFILES.find(p => p.topk === DEFAULT_PROFILE);
    }

    /** 历史几何（**只给 legacy 冻结件用**）。新路径没有"帧"这个概念。 */
    function frameGeometry(pf) {
        if (pf == null) pf = P;
        const g = profileFor(pf);
        return {
            topk: g.topk != null ? g.topk : g.TOPK,
            bits: g.bits != null ? g.bits : g.BITS,
            segBytes: g.segBytes != null ? g.segBytes : g.SEG_BYTES,
            payload: g.payload != null ? g.payload : g.SEG_PAYLOAD,
        };
    }

    /** 切到 ver=3（默认）。新路径没有定长几何可切，故只需复位 ver。 */
    function applyRangeGeometry() {
        P.VER = 3;
        P.CHAIN_FRAMES = 1;
        P.TOPK = 0; P.BITS = 0; P.NEED = 0;
        P.SEG_BYTES = 0; P.SEG_PAYLOAD = 0; P.TOKENS_PER_FRAME = 0;
        return { ver: 3, chunkMax: CHUNK_MAX };
    }

    /** 切到历史 ver=1 六位几何（**仅解码旧文本 / 回归对照**） */
    function applyLegacyProfile(v) {
        const pf = profileFor(v);
        P.VER = 1;
        P.TOPK = pf.topk; P.BITS = pf.bits; P.NEED = pf.topk;
        P.SEG_BYTES = pf.segBytes; P.SEG_PAYLOAD = pf.payload;
        P.TOKENS_PER_FRAME = pf.tokensPerFrame;
        P.PROFILE = pf.topk;
        P.CHAIN_FRAMES = 2;
        return pf;
    }

    /** 切到历史 ver=2 整块区间几何（**仅解码旧文本**）。
     *  ⚠️ 288/284 是历史定长帧的尺寸，只在此处出现，且只服务于旧文本解析。 */
    function applyLegacyRangeGeometry() {
        P.VER = 2;
        P.TOPK = 0; P.BITS = 0; P.NEED = 0;
        P.SEG_BYTES = 288; P.SEG_PAYLOAD = 284;
        P.TOKENS_PER_FRAME = 0;
        P.CHAIN_FRAMES = 1;
        return { ver: 2, segBytes: 288, payload: 284 };
    }

    const LEGACY_RANGE_GEOM = { topk: 0, bits: 0, segBytes: 288, payload: 284, tokensPerFrame: 0, ver: 2 };

    /* ── 签名（链首 1 个汉字，11 bit 字库索引） ──
     *
     *     idx(11) = [ver:1][sub:1][mode:1][pi:1][rnd:6]
     *                1024  512   256   128   0
     *
     *  bit10  = ver 位：0 ⇒ 此处无新式签名（旧文本 / 字库缺失）
     *  bit9   = sub：0 ⇒ ver=1（历史六位）；1 ⇒ 区间编码族（ver=2/3）
     *  bit8   = mode：0 = lazy，1 = forced（ver=2/3 共用语义）
     *  bit7   = pi：历史 ver=2 的池档位，**恒 1**；ver=3 借用为版本判别位并取 0
     *  bit6..0= rnd(6)：首字在 64 个字间散布，压掉"固定开头"指纹
     *
     * 判别表（互斥，绝不靠猜）：
     *    [1024,1535]  ver=1 六位抽签          （bit10=1, bit9=0）
     *    [1536,1599]  ver=3 lazy   (pi=0, mode=0)
     *    [1600,1663]  ver=2 lazy   (pi=1, mode=0)  ← 历史文本原样
     *    [1664,1727]  ver=3 forced (pi=0, mode=1)
     *    [1728,1791]  ver=2 forced (pi=1, mode=1)  ← 历史文本原样
     *
     * ⚠️ 为何**不动** mode/pi 的位序：ver=2 的文本已经发出去了，它的签名索引是
     *    1536|mode<<7|64|rnd。若把版本判别位插到 bit7 之前，这些历史索引会整体
     *    错位，旧文本再也读不出 cap 模式 ⇒ 解不开。此处只把「历史上恒为 1 的 pi
     *    位」重新定义为版本判别位：ver=2 的全部合法索引原封不动，ver=3 取 pi=0
     *    错开 —— 零成本、零迁移。
     *
     * ⚠️ 区间必须落在**常用汉字区 [0,1791]**，绝不进符号区 [1792,2047]：
     *   ① 首字必须是汉字，否则不像自然语言；
     *   ② StegoUI.prefilter 对非汉字/非 ASCII 不计命中，落符号区会拉低首字
     *      命中率，短消息甚至被预筛误拒。
     *   核上界：ver=1 区 1024|7·64|63 = 1535；区间族 1536|128|64|63 = 1791，
     *   两者均 < 1792 ✓ */
    const SIG_TABLE = () => (typeof global.HANZI_TABLE_V2 !== 'undefined' && global.HANZI_TABLE_V2)
        ? global.HANZI_TABLE_V2 : null;
    let _sigMapCache = null;
    function sigMap() {
        const T = SIG_TABLE();
        if (!T) return null;
        if (!_sigMapCache) {
            _sigMapCache = new Map();
            for (let i = 0; i < T.ALPHABET.length; i++) _sigMapCache.set(T.ALPHABET[i], i);
        }
        return _sigMapCache;
    }
    const sigSupported = () => !!SIG_TABLE();
    const _td = new TextDecoder('utf-8');
    const _te = new TextEncoder();

    /** 生成链首签名字（1 个汉字）。字库缺失返回 ''（= 不签名）。
     *  @param ver  3（滑窗，默认）| 2（历史整块区间）| 1（历史六位）
     *  @param opts {mode?:'lazy'|'forced', forced?:boolean, topk?:number} */
    function makeSigChar(ver, opts) {
        const T = SIG_TABLE();
        if (!T) return '';
        opts = opts || {};
        const rnd = Math.floor(Math.random() * 64);
        if (ver === 3 || ver === 2) {
            const modeBit = ((ver === 3 ? opts.mode === 'forced' : !!opts.forced)) ? 1 : 0;
            const pi = (ver === 2) ? 1 : 0;      // 历史 ver=2 恒 1；ver=3 取 0
            return T.ALPHABET[1536 | (modeBit << 7) | (pi << 6) | rnd] || '';
        }
        const i = PROFILES.findIndex(p => p.topk === (opts.topk || DEFAULT_PROFILE));
        if (i < 0) return '';
        return T.ALPHABET[1024 | (i << 6) | rnd] || '';
    }

    /** 从 textBytes[cursor] 读 1 个签名字。
     *  @returns {{ver, mode?, forced?, poolIdx?, pf?, len}|null} null = 此处无合法签名 */
    function readSigChar(textBytes, cursor) {
        const M = sigMap();
        if (!M) return null;
        if (cursor >= textBytes.length) return null;
        const b0 = textBytes[cursor];
        const n = b0 < 0x80 ? 1 : (b0 & 0xe0) === 0xc0 ? 2
            : (b0 & 0xf0) === 0xe0 ? 3 : (b0 & 0xf8) === 0xf0 ? 4 : 0;
        if (!n || cursor + n > textBytes.length) return null;
        const ch = _td.decode(textBytes.subarray(cursor, cursor + n));
        const idx = M.get(ch);
        if (idx === undefined) return null;

        if ((idx & 1536) === 1536) {
            const modeBit = (idx >>> 7) & 1;
            const pi = (idx >>> 6) & 1;
            if (pi === 0) return { ver: 3, mode: modeBit ? 'forced' : 'lazy', len: n };
            return { ver: 2, forced: !!modeBit, poolIdx: 1, len: n };
        }
        if ((idx & 1536) === 1024) {
            const pi = (idx >>> 6) & 7;
            if (pi >= PROFILES.length) return null;
            return { ver: 1, pf: PROFILES[pi], len: n };
        }
        return null;
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

    /* ══════════════════ ⑦ ver=3 滑窗重归一化区间编解码 ══════════════════
     *
     * ── 角色是**反的**（最容易搞混的一点） ──
     *   隐写编码器 = 区间**解码器**角色：吃明文字节，吐 token
     *   隐写解码器 = 区间**编码器**角色：吃 token，吐明文字节
     *   因为被压缩的符号是「token」，而字节才是码流。
     *
     * ── 与 ver=2 的根本差别 ──
     *   ver=2 把整块当一个大整数、细分到 hi-lo==1，故**必须预知块长**
     *   （初始区间 [0,2^(8N))），并且必须演完整块才能收敛 —— 这正是
     *   "288B 定长桶 + PRF 补齐"的由来，也是"无法即时刹车"的根源。
     *
     *   ver=3 改为**滑窗**：窗口恒为 W_BITS，顶部整字节一旦确定就吐出并
     *   左移补进下一个输入字节。于是：
     *     · 块长无需预知（长度头就写在数据最前端）
     *     · 解码端解够 2+actual_len 字节即**立即停止**，尾部比特全部丢弃
     *     · 没有"凑满段落"这回事 —— 有多少字节编多少字节
     *
     * ── 为什么无进位（不需要 LZMA 的 cache/carry） ──
     *   吐字节条件是 floor(lo/2^(W-8)) == floor((lo+r-1)/2^(W-8))，
     *   它蕴含 r ≤ 2^(W-8)。于是左移 8 位后 r·2^8 ≤ 2^W、lo·2^8 < 2^W，
     *   后续加法永远进不到尚未吐出的高位，更不会回改已吐出的字节。
     *
     * ── 两个实测踩出来的硬约束（见 test/stego/range3.mjs） ──
     *   ① 重归一化守卫**不能**写成 `r > 1n && topDet(...)`：r 缩到 1 时
     *      topDet 恒真，而那正是唯一的解脱出口 ⇒ 永久卡死。
     *      反过来，「r==1 ⇒ topDet」必然成立，故循环退出后恒有 r ≥ 2，
     *      stepScale(r) ≥ 2、候选池下限 2 个符号始终有效。
     *   ② 候选池深**必须 ≤ M**（= stepScale(r)）：重归一化后 r 仍可能只剩
     *      2~3，此时 M 可能只有 2，池深必须随之收紧，否则 CDF 无法归一化。
     *      这不是优化而是正确性前提；两端由同一个 M 推出同一池深，无需传输。
     */

    /** 每步定点尺度：≤ min(2^16, r) 的最大 2 的幂。
     *  这是**终止性保证**：池内每候选 freq ≥ 1 ⇒ freq_top ≤ M-1
     *  ⇒ 新区间宽 ≤ ceil(r(M-1)/M) ≤ r-1 < r，严格收缩（且 M ≤ r 保证 t 不越界）。 */
    function stepScale(r) {
        const CAP = 1n << 16n;
        const m = r < CAP ? r : CAP;
        let p = 1n;
        while (p * 2n <= m) p *= 2n;
        return Number(p);
    }

    /** 顶部整字节是否已确定（决定能否吐字节并左移） */
    function topDet(lo, r) {
        return (lo >> W_SHIFT) === ((lo + r - 1n) >> W_SHIFT);
    }

    const ceilDivB = (x, y) => (x + y - 1n) / y;

    /* ── 区间细分（与 ver=2 同一套，BigInt 精确） ──
     * ⚠️ 必须取 **ceil** 而非 floor：目标不变量是 V ∈ [lo, lo+r)。
     *    设 a=cum[i]、b=cum[i+1]，取 floor 时上界不成立 ⇒ 区间永不坍缩。
     *    ceil 同时让相邻区间首尾相接（hi'(i)==lo'(i+1)），不重不漏。 */
    function narrow(lo, r, cum, i, Mv) {
        const Mb = BigInt(Mv);
        const a = ceilDivB(r * BigInt(cum[i]), Mb);
        const b = ceilDivB(r * BigInt(cum[i + 1]), Mb);
        return { lo: lo + a, hi: lo + b };
    }

    /** 在 cum 中二分：找 i 使 cum[i] ≤ t < cum[i+1] */
    function bucketOf(cum, L, Mv, t) {
        if (t < 0) t = 0; else if (t >= Mv) t = Mv - 1;
        let lo = 0, hi = L - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (cum[mid] <= t) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    function bytesToBigInt(u8) {
        let v = 0n;
        for (let i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]);
        return v;
    }

    function bigIntToBytes(v, len) {
        const out = new Uint8Array(len);
        for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
        return out;
    }

    /**
     * 隐写**编码器**（区间解码器角色）：明文 → token 字串。
     *
     * @param data      Uint8Array，**已含 2 字节长度头**
     * @param fwd       makeForwarder 产物
     * @param V         词表
     * @param onStep    每步回调（进度）
     * @param signal    AbortSignal
     * @param capMode   'lazy' | 'forced'
     * @returns {Promise<{text, steps, capMode}>}
     */
    async function encodeChunk3(data, fwd, V, onStep, signal, capMode) {
        const parts = [];
        let total = 0, steps = 0;
        const state = createState(fwd.M);
        let last = P.BOS;

        /* 链首签名：1 个汉字，**不计入 step**（解码端读它也不占 step）。
         * cap 模式写进签名，解码端据此走同一策略，否则 CDF 分叉 ⇒ DESYNC。 */
        const sig = makeSigChar(3, { mode: capMode });
        if (sig) { const b = _te.encode(sig); parts.push(b); total += b.length; }

        /* 滑窗初始化：预取 W_INIT_BYTES 字节（不足则补 0，两端规则一致） */
        let ptr = 0;
        const readAt = (k) => (k < data.length ? data[k] : 0);
        let lo = 0n, r = 1n << W_BITS;
        let rel = 0n;
        for (let i = 0; i < W_INIT_BYTES; i++) rel = (rel << 8n) | BigInt(readAt(ptr++));

        const limit = data.length;    // 已消费字节数达到它即完成
        while (ptr < limit) {
            if (steps >= RANGE_BUDGET) throw new Error('RANGE_MAX_STEPS: ' + steps);
            const Mv = stepScale(r);
            const fw = fwd(last, state);
            const pool = resolveRangePool(fw.topK, V, RANGE_POOL, Mv);
            const cdf = buildIntegerCDF(fw.logits, pool.ids, fwd.M.tables.exp_lut.arr, Mv,
                adaptiveCapFreq(Mv, r, steps, TOTAL_BITS, RANGE_BUDGET, capMode));

            const t = Number((rel * BigInt(Mv)) / r);
            const i = bucketOf(cdf.cum, cdf.L, Mv, t);
            const nx = narrow(lo, r, cdf.cum, i, Mv);
            rel -= (nx.lo - lo); lo = nx.lo; r = nx.hi - nx.lo;

            parts.push(pool.bufs[i]);
            total += pool.bufs[i].length;
            last = pool.ids[i];
            steps++;

            while (topDet(lo, r)) {
                const nb = BigInt(readAt(ptr++));
                lo = (lo - ((lo >> W_SHIFT) << W_SHIFT)) << 8n;
                r <<= 8n;
                rel = (rel << 8n) | nb;
            }
            if ((steps & (YIELD_EVERY - 1)) === 0) {
                if (onStep) onStep(steps);
                await yieldToUI();
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
        }
        if (onStep) onStep(steps);

        const bytes = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { bytes.set(p, o); o += p.length; }
        return { text: _td.decode(bytes), steps, capMode };
    }

    /**
     * 隐写**解码器**（区间编码器角色）：token 字串 → 明文。
     *
     * ── 即时刹车 ──
     *   解出前 2 字节即知 actual_len；此后每吐 1 个有效字节计数 +1；
     *   累计到 2+actual_len 立即 return —— **不再 forward、不再回环**，
     *   尾部多余比特直接丢弃。
     *
     * @param textBytes 全文 UTF-8 字节
     * @param cursor    起始游标（链首）
     * @param fwd,V
     * @param opts      {signal, onStep, onChars, sig, capMode}
     * @returns {Promise<{bytes, actualLen, payload, steps, consumed, capMode}>}
     */
    async function decodeChunk3(textBytes, cursor, fwd, V, opts) {
        opts = opts || {};
        const signal = opts.signal;
        const state = createState(fwd.M);
        let last = P.BOS;
        let ptr = 0, steps = 0;

        /* 链首签名：读掉它并取出 cap 模式（不占 step，两端同规则） */
        let capMode = opts.capMode || 'lazy';
        if (opts.sig !== false) {
            const sg = readSigChar(textBytes, cursor);
            if (sg && sg.ver === 3) {
                cursor += sg.len;
                capMode = sg.mode || 'lazy';
            }
        }

        /* 字节计数终止：head 未定时先攒够 2 字节长度头 */
        const out = [];
        let need = 2;              // 先只要 2 字节长度头
        let actualLen = -1;

        let lo = 0n, r = 1n << W_BITS;
        let rel = 0n, pre = 0;

        while (out.length < need) {
            if (steps >= RANGE_BUDGET) {
                const e = new Error('RANGE_MAX_STEPS: ' + steps);
                e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
            }
            if (cursor + pre >= textBytes.length) {
                const e = new Error('RANGE_TEXT_UNDERRUN@' + (cursor + pre));
                e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
            }
            const Mv = stepScale(r);
            const fw = fwd(last, state);
            const pool = resolveRangePool(fw.topK, V, RANGE_POOL, Mv);
            const cdf = buildIntegerCDF(fw.logits, pool.ids, fwd.M.tables.exp_lut.arr, Mv,
                adaptiveCapFreq(Mv, r, steps, TOTAL_BITS, RANGE_BUDGET, capMode));

            /* 唯一命中：prefix-free 保证至多一个候选是此处前缀 */
            let hit = -1, hits = 0;
            for (let i = 0; i < pool.bufs.length; i++) {
                if (V.matchesAt(textBytes, cursor + pre, pool.bufs[i])) { if (hit < 0) hit = i; hits++; }
            }
            if (hits === 0) {
                const e = new Error('RANGE_DESYNC@' + (cursor + pre) + '（文本与候选集无法对齐）');
                e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
            }
            if (hits > 1) throw new Error('RANGE_AMBIGUOUS@' + (cursor + pre));

            const nx = narrow(lo, r, cdf.cum, hit, Mv);
            lo = nx.lo; r = nx.hi - nx.lo;
            last = pool.ids[hit];
            pre += pool.bufs[hit].length;
            steps++;

            /* 重归一化：每吐 1 字节即计数；首字节头一旦凑齐 2 字节就解出 actual_len */
            while (topDet(lo, r)) {
                const b = Number((lo >> W_SHIFT) & 0xffn);
                out.push(b);
                lo = (lo - ((lo >> W_SHIFT) << W_SHIFT)) << 8n;
                r <<= 8n;
                if (out.length === 2 && actualLen < 0) {
                    actualLen = (out[0] << 8) | out[1];
                    if (actualLen > CHUNK_MAX) {
                        const e = new Error('RANGE_LEN_TOO_BIG: ' + actualLen + ' > ' + CHUNK_MAX);
                        e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                    }
                    need = 2 + actualLen;
                    /* ── 即时刹车的第一现场：actual_len==0 时长度头就是全部 ── */
                    if (out.length >= need) break;
                }
                if (out.length >= need) break;
            }
            if ((steps & (YIELD_EVERY - 1)) === 0) {
                if (opts.onStep) opts.onStep(steps);
                if (opts.onChars) opts.onChars(cursor + pre);
                await yieldToUI();
                if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            }
        }
        if (opts.onChars) opts.onChars(cursor + pre);

        const bytes = Uint8Array.from(out);
        return {
            bytes,
            actualLen,
            payload: bytes.subarray(2, 2 + Math.max(0, actualLen)),
            steps, consumed: cursor + pre, capMode,
        };
    }
    /* ══════════════════ ⑧ 共享基础设施（编解码驱动 + 主线程让出） ══════════════════
     *
     * ── 让出主线程 ──
     * 前向是纯同步整数运算，几百步 ≈1.8s。若不主动让出，主线程被焊死，
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

    /** 一条链 = 一条连续 token 流（状态从 BOS 起步），链长 ≤ CHAIN_TOKENS */
    function makeForwarder(M, V) {
        const fwd = function forward(lastTokenId, state) {
            const r = stepForward(M, lastTokenId, state);
            /* ⚠️ 候选池深度恒为 MAX_TOPK，与"档位"解耦：档位体系已随 ver=2
             *    移除，池深在这里是常数。
             * ⚠️ logits 必须一并返回：整数 CDF 依赖**原始定点分数**，
             *    只给名次无法还原模型真实分布。 */
            return {
                topK: topKFromLogits(r.logits, MAX_TOPK),
                logits: r.logits,
                nextState: state,
            };
        };
        fwd.M = M;      // encodeChunk3 需要它来建初态
        fwd.V = V;
        return fwd;
    }

    /* ── 历史帧头哈希 / nonce（**仅** legacy 冻结件与段信封用） ──
     * 新路径没有帧，故这里只作为共享工具保留，供 install() 注入给冻结件。 */
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
    function nonceOf(slice) {
        let h = 0x811c9dc5;
        for (let i = 0; i < slice.length; i++) { h ^= slice[i]; h = Math.imul(h, 0x01000193) >>> 0; }
        return ((h >>> 16) ^ h) & 0xffff;
    }

    /* ── 段信封（**传输层格式**，不是 Codec 的一部分） ──
     * ⚠️ 编码/解码路径都不依赖它：它是"把多段归到同一条消息 + 支持乱序粘贴"
     *    的排版标识。真正需要它的只有 UI 的"复制本段"与完整版解码入口。 */
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
        /* 无段头 → **整段就是正文**。段头只是排版标识，不是解密的必需品。 */
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

    /* ══════════════════ ⑩ 定点整数 CDF（分布保真） ══════════════════
     *
     * 取代「从密文读 6 bit 当 Top-64 下标」的均匀抽签：每步按模型原始
     * int32 定点分数建整数 CDF、细分区间，**分布保真**。
     *
     * ── 为什么不是 rANS ──
     * 教科书 rANS 要求 freq > 2^(s-8)，取 s=16 就得 freq ≥ 256，而候选池
     * 有 64~256 个符号、绝大多数 freq 远小于此 ⇒ 简单形式直接失效
     * （形式本身的限制，非实现问题）。故用**精确区间细分**。
     *
     * ── 实测 ──
     * NLL 5.86 → 3.68（-37%）；吞吐 5.2~5.5 bit/token（模型真实熵）。
     * 旧 6.00 bit/token 路径高于模型熵，信息论上不可达，多出的部分只能靠
     * 扭曲分布硬挤 —— 那正是文本崩坏的根因。该路径已随定长桶一并移除。
     */

    function bitlenBig(x) { let n = 0; while (x > 0n) { n++; x >>= 1n; } return n; }

    /**
     * 定点整数 CDF。权重直接来自 tables.bin 的 exp_lut —— 与模型自身
     * softmax（softmaxLut）是同一条整数映射，不引入任何浮点概率。
     *
     *   d   = z_max - z_i                  （int32 差分，定点 2^-RES_FRAC / nat）
     *   idx = floor(d · (NL-1) / span)      span = EXP_LUT_MAX · 2^RES_FRAC
     *   w_i = exp_lut[idx]，下限 1
     *
     * 归一化：f_i = max(1, floor(w_i·M/Σw))，再确定性补/退残差使 Σf = M。
     * 两端从同一组 logits 得出逐字节相同的 CDF ⇒ **概率表无需传输**。
     *
     * @param maxFreq 最高频上限（0 = 不限）。见 adaptiveCapFreq。
     */
    function buildIntegerCDF(logits, ids, expLut, Mv, maxFreq) {
        const L = ids.length;
        if (L < 2) throw new Error('CDF_POOL_TOO_SMALL: ' + L);
        if (L > Mv) throw new Error('CDF_POOL_GT_SCALE: ' + L + ' > ' + Mv);
        const NL = expLut.length, span = C.EXP_LUT_MAX * Math.pow(2, C.RES_FRAC);

        const w = new Int32Array(L);
        let maxS = -Infinity;
        for (let i = 0; i < L; i++) { const s = logits[ids[i]] | 0; if (s > maxS) maxS = s; }
        let sum = 0;
        for (let i = 0; i < L; i++) {
            const d = maxS - (logits[ids[i]] | 0);
            let x = (d >= span) ? expLut[NL - 1] : expLut[idivFloor(d * (NL - 1), span)];
            if (!(x >= 1)) x = 1;
            w[i] = x; sum += x;
        }

        const cap = (maxFreq && maxFreq > 1) ? Math.min(maxFreq, Mv >> 1) : 0;
        const f = new Int32Array(L);
        let used = 0;
        for (let i = 0; i < L; i++) {
            let v = idivFloor(w[i] * Mv, sum);
            if (v < 1) v = 1;
            if (cap && v > cap) v = cap;
            f[i] = v; used += v;
        }

        /* 残差修正（确定性，一次收敛）。
         * ⚠️ 两个坑，都实测踩过：
         *  ① 用"有界循环反复 ±1"在小尺度（M 小至 4）配大池时**收敛不了**
         *     —— 实测 M=1024、池 256 抛 1101 != 1024。改为一次性分配差额。
         *  ② 补残差必须补到**权重最低**的条目，不能补最高的 —— 后者会把
         *     刚被 cap 压下去的最高频重新抬起，cap 失效、最坏码长又无上界。 */
        const order = Array.from({ length: L }, (_, i) => i).sort((a, b) => (w[b] - w[a]) || (a - b));
        let diff = Mv - used;
        if (diff > 0) {
            const fill = cap ? order.slice().reverse() : order;
            for (let k = 0; k < diff; k++) f[fill[k % L]]++;
        } else if (diff < 0) {
            for (let k = L - 1; k >= 0 && diff < 0; k--) {
                const i = order[k]; const take = Math.min(f[i] - 1, -diff);
                if (take > 0) { f[i] -= take; diff += take; }
            }
            for (let k = 0; k < L && diff < 0; k++) {
                const i = order[k]; const take = Math.min(f[i] - 1, -diff);
                if (take > 0) { f[i] -= take; diff += take; }
            }
        }
        used = 0; for (let i = 0; i < L; i++) used += f[i];
        if (used !== Mv) throw new Error('CDF_NORMALIZE_FAIL: ' + used + ' != ' + Mv + ' (L=' + L + ')');

        const cum = new Int32Array(L + 1);
        for (let i = 0; i < L; i++) cum[i + 1] = cum[i] + f[i];
        if (cum[L] !== Mv) throw new Error('CDF_CUM_FAIL');
        return { M: Mv, cum, freqs: f, L };
    }


    function adaptiveCapFreq(Mv, r, stepsUsed, totalBits, budget, mode, floorRate) {
        const stepsLeft = budget - stepsUsed;
        if (stepsLeft <= 0) return 0;
        const bitsLeft = bitlenBig(r);
        if (bitsLeft <= 0) return 0;
        const need = bitsLeft / stepsLeft;

        if (mode === 'forced') {
            const k = Math.ceil(need);
            if (k <= 0) return 0;
            return Math.max(2, Mv >> k);
        }
        // lazy：观测速率已够快就不干预
        const consumed = totalBits - bitsLeft;
        const rate = stepsUsed > 0 ? consumed / stepsUsed : 0;
        const slack = Math.max(rate, floorRate == null ? 2.0 : floorRate);
        if (need <= slack) return 0;
        const k = Math.ceil(need);
        if (k <= 0) return 0;
        return Math.max(2, Mv >> k);
    }

    /**
     * 区间编码候选池：黑名单准入 + 单趟贪心 prefix-free。
     * 与 resolveByteCandidates 同规则，但可指定上限与池深上限。
     *
     * ⚠️ prefix-free 仍然必需：算术编码只省掉"均匀"，没省掉"可辨识" ——
     *    解码端仍要靠「文本在游标处以哪个候选开头」唯一认出符号。
     * ⚠️ 池大小必须 ≤ 当前步 M_step，否则无法做到每候选 freq≥1。
     *    M_step 由 r 唯一决定（两端都算得出），故限制规则两端一致。 */
    function resolveRangePool(rawIds, V, poolMax, limit) {
        const cap = Math.max(2, Math.min(poolMax, limit == null ? poolMax : limit));
        const ids = [], bufs = [];
        for (let i = 0; i < rawIds.length && ids.length < cap; i++) {
            const id = rawIds[i];
            if (!V.isAllowed(id)) continue;
            const s = V.raw(id);
            let bad = false;
            for (let j = 0; j < bufs.length; j++) {
                if (V.isPrefix(bufs[j], s) || V.isPrefix(s, bufs[j])) { bad = true; break; }
            }
            if (bad) continue;
            ids.push(id); bufs.push(s);
        }
        if (ids.length < 2) throw new Error('RANGE_POOL_TOO_SMALL: ' + ids.length);
        return { ids, bufs };
    }

    /* ══════════════════ 对外 API ══════════════════ */

    const Stego = {
        P, C,

        /* ── 内核 ── */
        loadModel, loadVocab, createState, stepForward, topKFromLogits, makeForwarder,

        /* ── ver=3 滑窗区间编解码（默认路径） ── */
        encodeChunk3, decodeChunk3,
        buildIntegerCDF, stepScale, adaptiveCapFreq, resolveRangePool,
        narrow, bucketOf, bytesToBigInt, bigIntToBytes, topDet,
        CHUNK_MAX, CHAIN_TOKENS, RANGE_POOL, RANGE_BUDGET, TOTAL_BITS,
        W_BITS, W_SHIFT, W_INIT_BYTES,
        applyRangeGeometry,
        /** 当前 Codec 版本：3 = 滑窗（默认）；1/2 = 历史，仅解码 */
        get ver() { return P.VER; },

        /* ── 签名 ── */
        makeSigChar, readSigChar, sigSupported, sigTable: SIG_TABLE,

        /* ── 历史几何（**仅** stego-legacy.js 与解码分流用） ── */
        PROFILES, profileFor, frameGeometry, MAX_TOPK,
        applyLegacyProfile, applyLegacyRangeGeometry, LEGACY_RANGE_GEOM,
        get profile() { return P.PROFILE; },

        /* ── 共享工具（legacy 冻结件经 install 注入复用，不重复实现） ── */
        rshiftRound, isqrt, idivFloor,
        resolveByteCandidates,

        _M: null, _V: null, ready: false,

        /** 装载资产（ArrayBuffer）。幂等。 */
        load(assets) {
            this._M = loadModel(assets);
            this._V = loadVocab(assets.vocab, this._M.fmt.vocab);
            this.ready = true;
            /* 把内核能力注入历史冻结件 —— 它只做历史解码，不持有模型。
             * 未加载 stego-legacy.js 时静默跳过（此时旧文本不可解，但新路径不受影响）。 */
            if (global.StegoLegacy && global.StegoLegacy.install) {
                global.StegoLegacy.install({
                    P, C, PROFILES, MAX_TOPK, frameGeometry, profileFor,
                    makeSigChar, readSigChar, sigSupported,
                    createState, stepForward, topKFromLogits,
                    buildIntegerCDF, stepScale, bytesToBigInt, bigIntToBytes,
                    bucketOf, narrow, resolveByteCandidates, resolveRangePool,
                    adaptiveCapFreq, yieldToUI, YIELD_EVERY,
                    fnv1a16, nonceOf, hashBytes,
                    segmentEnvelope, mergeSegments,
                    RANGE_POOL, RANGE_BUDGET, RANGE_POOL_IDX,
                });
            }
            return this;
        },

        /**
         * **纯二进制 → 伪装文本**（Codec 层唯一入口，不含任何加密概念）。
         *
         * 分块：每块明文 ≤ CHUNK_MAX 字节，块前固定 2 字节 uint16 BE 长度头：
         *     [uint16 BE actual_len][payload]
         * 最后一块**想多短就多短** —— 不再向上补齐到任何桶长（定长桶已废除）。
         * 每条链独立从 BOS 起步；块边界由长度头自定界，无需传输任何帧数。
         *
         * @returns {{text, chunks, steps, chars, ms, ver, sizes}}
         */
        async encodeBytes(cipherBytes, opt) {
            opt = opt || {};
            if (!this.ready) throw new Error('模型未装载');
            const M = this._M, V = this._V;
            const fwd = makeForwarder(M, V);
            const t0 = Date.now();
            const src = cipherBytes instanceof Uint8Array ? cipherBytes : new Uint8Array(cipherBytes);
            const L = src.length;

            /* 空载荷也产出一个"仅长度头"的块，保证 0 字节可往返。
             * （密文不会是空的，但协议不该在这里留一个静默失败的洞。） */
            const bodies = [];
            let off = 0, steps = 0;
            const sizes = [];
            do {
                let size = Math.min(CHUNK_MAX, L - off);
                let done = null;
                let forced = false;
                for (;;) {
                    const data = new Uint8Array(2 + size);
                    data[0] = (size >>> 8) & 0xff; data[1] = size & 0xff;
                    data.set(src.subarray(off, off + size), 2);
                    try {
                        done = await encodeChunk3(data, fwd, V,
                            (s) => { if (opt.onProgress) opt.onProgress({ step: steps + s, chunks: sizes.length + 1 }); },
                            opt.signal, forced ? 'forced' : 'lazy');
                        break;
                    } catch (e) {
                        if (!/RANGE_MAX_STEPS/.test(e.message || '')) throw e;
                        if (!forced) { forced = true; continue; }        // 先换 forced
                        if (size <= 16) throw e;                          // 已到下限，如实报错
                        size = Math.max(16, size >> 1);                   // 再折半
                        forced = false;
                    }
                }
                bodies.push(done.text);
                sizes.push(size);
                steps += done.steps;
                off += size;
            } while (off < L);

            const text = bodies.join('');
            return {
                text, chars: text.length, chunks: bodies.length, sizes,
                steps, ms: Date.now() - t0, ver: 3,
            };
        },

        /**
         * **伪装文本 → 纯二进制**（Codec 层唯一出口）。
         *
         * 逐块自定界：读链首签名得版本与 cap 模式 → decodeChunk3 解出长度头 →
         * 攒够 2+actual_len 立即停止（尾部比特丢弃）→ 下一块从 consumed 续上。
         *
         * ver=1/2 的历史文本按签名分流给冻结件，**绝不"先试新编码"** ——
         * 旧文本用新路径可能偶然跑通并产出错误字节（静默损坏）。
         *
         * @param {string|Uint8Array} text 伪装文本（或已编码的 UTF-8 字节）
         * @returns {{bytes:Uint8Array, chunks, steps, ms, ver, legacy}}
         */
        async decodeText(text, opt) {
            opt = opt || {};
            if (!this.ready) throw new Error('模型未装载');
            const M = this._M, V = this._V;
            const fwd = makeForwarder(M, V);
            const tb = (text instanceof Uint8Array) ? text : _te.encode(String(text || ''));
            const t0 = Date.now();
            const outParts = [];
            let cursor = 0, steps = 0, chunks = 0;
            let sawLegacy = false;
            const useSig = opt.sig !== false && sigSupported();

            const mkOpts = (extra) => Object.assign({
                signal: opt.signal, onStep: () => {}, onChars: opt.onChars,
            }, extra || {});

            while (cursor < tb.length) {
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                const sg = useSig ? readSigChar(tb, cursor) : null;

                /* ── ① 签名明确：直接照做，不猜 ── */
                if (sg && sg.ver === 3) {
                    const r = await decodeChunk3(tb, cursor + sg.len, fwd, V,
                        mkOpts({ sig: false, capMode: sg.mode }));
                    outParts.push(r.bytes.subarray(0, 2 + r.actualLen));
                    steps += r.steps; chunks++;
                    cursor = r.consumed;
                    continue;
                }
                if (sg && (sg.ver === 2 || sg.ver === 1)) {
                    if (!global.StegoLegacy || !global.StegoLegacy.ready) {
                        const e = new Error('这段是历史版本（ver=' + sg.ver + '）伪装文本，需加载 stego-legacy.js 才能解');
                        e.code = 'NEED_LEGACY'; throw e;
                    }
                    const L = global.StegoLegacy;
                    if (sg.ver === 2) {
                        const g2 = LEGACY_RANGE_GEOM;
                        const r = await L.decodeChainRange(tb, cursor, g2.segBytes, fwd, V,
                            mkOpts({ sig: true, maxFrames: Math.max(1, Math.ceil(tb.length / 24)) }));
                        outParts.push(...legacyFrames(r.bytes, g2, L));
                        steps += r.steps; chunks += r.frames; cursor = r.consumed; sawLegacy = true;
                    } else {
                        const a = await L.decodeAuto(tb, fwd, V, mkOpts({ sig: true }));
                        outParts.push(...legacyFrames(a.bytes, frameGeometry(a.profile), L));
                        steps += a.steps; cursor = tb.length; sawLegacy = true;
                    }
                    continue;
                }

                /* ── ② 无签名（旧文本无签名 / 字库缺失）：先试 ver=3，再退历史 ──
                 * 顺序与旧实现一致，但新编码排在最前（它才是当前默认）。 */
                let ok = null;
                for (const cm of ['lazy', 'forced']) {
                    try {
                        ok = await decodeChunk3(tb, cursor, fwd, V, mkOpts({ sig: false, capMode: cm }));
                        break;
                    } catch (e2) { if (!(e2 && e2.code === 'NOT_STEGO')) throw e2; }
                }
                if (ok) {
                    outParts.push(ok.bytes.subarray(0, 2 + ok.actualLen));
                    steps += ok.steps; chunks++; cursor = ok.consumed;
                    continue;
                }
                /* 回退：无签名的历史 ver=2（lazy/forced）→ 最后 ver=1 七档竞速 */
                if (global.StegoLegacy && global.StegoLegacy.ready) {
                    const L = global.StegoLegacy, g2 = LEGACY_RANGE_GEOM;
                    let got = null;
                    for (const cm of ['lazy', 'forced']) {
                        try {
                            got = await L.decodeChainRange(tb, cursor, g2.segBytes, fwd, V,
                                mkOpts({ sig: false, capMode: cm, maxFrames: Math.max(1, Math.ceil(tb.length / 24)) }));
                            break;
                        } catch (e2) { if (!(e2 && e2.code === 'NOT_STEGO')) throw e2; }
                    }
                    if (got) {
                        outParts.push(...legacyFrames(got.bytes, g2, L));
                        steps += got.steps; chunks += got.frames; cursor = got.consumed; sawLegacy = true;
                        continue;
                    }
                    const a = await L.decodeAuto(tb, fwd, V, mkOpts({ sig: false }));
                    outParts.push(...legacyFrames(a.bytes, frameGeometry(a.profile), L));
                    steps += a.steps; cursor = tb.length; sawLegacy = true;
                    continue;
                }
                const e = new Error('这段内容不是隐写文本');
                e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
            }

            let total = 0;
            for (const p of outParts) total += p.length;
            const bytes = new Uint8Array(total);
            let o = 0;
            for (const p of outParts) { bytes.set(p, o); o += p.length; }
            return {
                bytes, chunks, steps, ms: Date.now() - t0,
                ver: sawLegacy ? 0 : 3, legacy: sawLegacy,
            };
        },

        /**
         * 快速预筛：该文本是否**可能**由词表里的 token 拼成。
         * O(n) 逐字符查表，不跑模型 —— 用于在进模型前廉价否决
         * 英文/代码等明显不可能的输入。
         *
         * 注意：这是**粗筛**，宁可放过不可错杀（普通中文文章也会高分通过，
         * 真正的判定交给 decode 的 desync 检测）。返回命中率。
         */
        prefilter(text) {
            if (!this._V) return 0;
            const chars = Array.from(String(text || ''));
            if (!chars.length) return 0;
            let hit = 0;
            for (const ch of chars) {
                const cp = ch.codePointAt(0);
                if ((cp >= 0x4E00 && cp <= 0x9FFF) ||
                    (cp >= 0x3000 && cp <= 0x303F) ||
                    (cp >= 0xFF00 && cp <= 0xFFEF) ||
                    (cp >= 0x2000 && cp <= 0x206F) ||
                    (cp >= 0x20 && cp <= 0x7E)) hit++;
            }
            return hit / chars.length;
        },
    };

    /* 历史 ver=1/2 的定长帧与段信封 —— 新路径不再使用，但 legacy 冻结件需要。
     * 它们在此**仅为兼容历史文本**保留，任何新编码都不得引用。 */
    function legacyFrames(bytes, g, L) {
        if (!g || !g.segBytes) return [bytes];
        const out = [];
        const n = Math.floor(bytes.length / g.segBytes);
        for (let i = 0; i < n; i++) {
            try { out.push(L.parseFrame(bytes.subarray(i * g.segBytes, (i + 1) * g.segBytes), i + 1, g)); }
            catch (e) { break; }
        }
        return out;
    }

    global.Stego = Stego;
})(typeof window !== 'undefined' ? window : globalThis);
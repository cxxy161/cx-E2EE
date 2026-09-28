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
        if (v && v.segBytes) return v;                        // 已是档位对象
        if (v && (v.topk != null || v.TOPK != null)) return v;  // 已是运行期几何(P)
        return PROFILES.find(p => p.topk === v) || PROFILES.find(p => p.bits === v) ||
            PROFILES.find(p => p.topk === DEFAULT_PROFILE);
    }

    /** 档位几何（帧长 / 载荷 / 位宽）。
     *
     *  ⚠️ 所有帧级操作都必须**显式携带几何**，禁止隐式读全局 P ——
     *  原实现的致命缺陷正是「按 A 档位的 segBytes 切片、却用全局 P（=B 档位）
     *  的帧长/载荷去校验」，于是接收端只要与发送端档位不同，
     *  frameMagicOk 就把**正确**的档位判死、留下错误的档位，
     *  最终整段还原失败并报「这段内容不是隐写文本」。 */
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

    /* ══════════════════ 档位随文传输（11 bit 签名汉字） ══════════════════
     *
     * ── 问题 ──
     * 档位（Top-K）决定帧长与每 token 位宽，是**收发双方必须一致**的协议
     * 参数，但原实现从不传输它：接收端只能靠「7 个档位各跑一遍、再用帧头
     * 自校验互相淘汰」的启发式去猜。一旦两端档位不同 —— 例如两个页面在
     * localStorage 写入 cx_stego_topk 之前各自打开、或一端改过档位而另一
     * 端没有 —— 淘汰过程会把**正确**的档位误杀，于是整段还原失败，
     * 用户看到的就是「这段内容不是隐写文本（模型已判定）」。
     *
     * ── 对策 ──
     * 每条链的**开头固定放 1 个汉字**作档位签名，用满字库的 11 bit：
     *
     *     idx(11) = [ver:1][0:1][pi:3][rnd:6]
     *
     *   ver = 1                 版本位（bit10；0 视为"无签名"，供旧文本识别）
     *   —   = 0                 保留位（恒 0，把签名区间收在 1024..1535）
     *   pi  = 0..6              PROFILES 下标 → top4/8/16/32/64/128/256
     *   rnd = 0..63             6 bit 随机 → 首字在 64 个字间散布，把
     *                           docs/hanzi-prefix.md 记录的「固定开头」指纹
     *                           压到与普通随机文本无异
     *
     * ⚠️ 位布局是**刻意收窄**的：idx = 1024 + pi·64 + rnd，
     *    最大 1024 + 6·64 + 63 = **1471 < 1792**，即恒落在字库的
     *    **常用汉字区**（0..1791），绝不落入符号区（1792..2047）。
     *    两条理由，缺一不可：
     *      ① 首字必须是汉字 —— 否则看起来就不像自然语言；
     *      ② StegoUI.prefilter 对非汉字/非 ASCII 字符**不计命中**，
     *         若首字落到 ⓐ/☎ 一类的符号区，首字命中率会被拉低，
     *         短消息甚至可能被预筛误拒（<0.85 直接判"不像是隐写文本"）。
     *
     * ── 为什么没有校验位 ──
     * 曾加过 4 bit 校验（把"普通汉字误认成签名"从 21.9% 压到 2.7%），
     * 现已移除：它不承担正确性。误命中只会让这次解码白跑一遍，随后由
     * decodeAll 的「带签名失败 → 去签名重试」兜底纠正；而误命中也不可能
     * 造成静默错误 —— 后面还有 frameMagicOk 的 16 bit 校验与 CX2 的
     * AES-GCM 认证兜着，只会走向 NOT_STEGO。
     * 代价却实打实：4 bit 校验会把 rnd 挤到只剩 2 bit（每档首字仅 4 种），
     * 反而放大了它本想缓解的指纹问题。故让位给随机性。
     *
     * 接收端在**每个链起点**读掉这 1 个字再开始匹配候选，档位因此不再需要
     * 猜。链起点是双方都按「每 CHAIN_TOKENS 个 token」确定性重置的位置，
     * 故分段发送 / 乱序拼接 / 裸正文三种形态下签名位置都天然对齐。
     *
     * ⚠️ 字库缺失（未引入 hanzi-table-v2.js 的宿主）时签名整体降级为关闭，
     *    退回旧的自动识别路径 —— 绝不静默产出解不开的文本。 */
    const SIG_VER = 1;
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
     *
     * ── 位布局（ver 位区分 Codec，零新增传输字段） ──
     *   ver=1（旧 6bit）：idx = 1024 | (pi<<6)     | rnd(6) → [1024, 1535]
     *   ver=2（区间编码）：idx = 1536 | (mode<<7) | (poolIdx<<6) | rnd(6)
     *                            → [1536, 1663] (mode=0, lazy)
     *                            → [1664, 1791] (mode=1, forced)
     * 判别：bit10 = ver；ver=2 时 bit7 = cap 模式（0 lazy / 1 forced）。
     *
     * ⚠️ 两段都必须落在 **常用汉字区 [0, 1791]**，绝不能进符号区 [1792, 2047]：
     *   ① 首字必须是汉字，否则不像自然语言；
     *   ② StegoUI.prefilter 对非汉字/非 ASCII **不计命中**，落到符号区会拉低
     *      首字命中率，短消息甚至被预筛误拒。
     *   （字库 HANZI_TABLE_V2.ALPHABET 总长 2048，故 idx 上限即 2047。）
     *
     * @param topk    旧路径：档位（决定 pi）。区间路径传 null。
     * @param ver     Codec 版本（1 | 2）
     * @param poolIdx 区间路径的池档下标（0..1，只用 bit6）
     * @param forced  区间路径是否使用 forced cap 模式
     */
    function makeSigChar(topk, ver, poolIdx, forced) {
        const T = SIG_TABLE();
        if (!T) return '';
        if (ver === 2) {
            const pi = (poolIdx == null) ? RANGE_POOL_IDX : poolIdx;
            const idx = 1536 | ((forced ? 1 : 0) << 7) | ((pi & 1) << 6) | Math.floor(Math.random() * 64);
            return T.ALPHABET[idx] || '';
        }
        const i = PROFILES.findIndex(p => p.topk === (topk || P.TOPK));
        if (i < 0) return '';
        return T.ALPHABET[1024 | (i << 6) | Math.floor(Math.random() * 64)] || '';
    }

    /** 从 textBytes[cursor] 读 1 个签名字。
     *  @returns {{ver:number, pf?:object, poolIdx?:number, forced?:boolean, len:number}|null}
     *           null = 此处没有合法签名 */
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

        // ver=2（区间编码）：bit10=1 且 bit9=1 → idx ∈ [1536, 1791]
        if ((idx & 1536) === 1536) {
            return {
                ver: 2,
                forced: !!(idx & 128),
                poolIdx: (idx >>> 6) & 1,
                len: n,
            };
        }
        // ver=1（旧 6bit）：bit10=1、bit9=0 → idx ∈ [1024, 1535]
        if ((idx & 1536) === 1024) {
            const pi = (idx >>> 6) & 7;
            if (pi >= PROFILES.length) return null;
            return { ver: 1, pf: PROFILES[pi], len: n };
        }
        return null;
    }

    /** 帧几何（ver=2 区间编码）—— 默认路径。
     *
     * 实测标定：512 token 链预算下，区间编码吞吐 ≈5.2~5.5 bit/token
     * （模型真实熵），故 288B 帧约需 430~450 token，留 ~15% 余量给最坏帧；
     * 帧头 4B 仅占 1.4%。
     *
     * ⚠️ 旧路径的 SEG_BYTES = 32×bits 整除约束在此**不再需要** ——
     *    区间编码是纯字节流，没有位对齐约束，帧长可自由取。 */
    const RANGE_GEOM = { topk: 0, bits: 0, segBytes: 288, payload: 284, tokensPerFrame: 0, ver: 2 };
    const RANGE_POOL = 256;       // 候选池深度（实测吞吐/速度折中）
    const RANGE_POOL_IDX = 1;     // 池档下标（签名 2 bit 用）：256 → idx 1
    const RANGE_BUDGET = 512;     // 每链 token 硬上限 = RoPE 位置表长度

    /* 运行期协议参数。
     *
     * ver 语义：1 = 旧「6bit 均匀抽签」Codec（仅解码兼容），2 = 区间编码（默认）。
     * 档位（Top-K）体系已随 ver=2 一并移除 —— 区间编码下候选池是常数，
     * 不存在"压缩 ↔ 通顺"的档位权衡。 */
    const P = {
        FRAME_HDR: 4, MAGIC: 0x5354,
        /* 链长 = 一条**连续 token 流**含几帧。
         * ver=2：1 帧/链（288B），因为区间编码每字节多花 ~15% token，
         *        2 帧会越过 RoPE 512 硬上限（实测 2×288B 需 ~870 token）。
         * ver=1：保持历史 2 帧/链（192B×2=384B），旧文本仍能解。
         *
         * 链与「显示分段」是两件事，必须解耦：
         *   链 = 编解码的**连续性**单位（状态重置点，决定互操作性）
         *   段 = 复制/发送的**排版**单位（决定要不要加段头） */
        CHAIN_FRAMES: 1,
        CHAIN_TOKENS: 512,          // RoPE 位置表长度（两条路径共用硬上限）
        SEG_CHAR_LIMIT: 2000,       // 排版上限（QQ 单条）
        BOS: 1,
        // 以下由 applyProfile / applyRangeGeometry 填充
        VER: 2,
        TOPK: 0, BITS: 0, NEED: 0, SEG_BYTES: 288, SEG_PAYLOAD: 284, TOKENS_PER_FRAME: 0,
        RANGE_POOL: RANGE_POOL,
    };

    /** 切到区间编码几何（ver=2，默认） */
    function applyRangeGeometry() {
        P.VER = 2;
        P.TOPK = 0; P.BITS = 0; P.NEED = 0;
        P.SEG_BYTES = RANGE_GEOM.segBytes;
        P.SEG_PAYLOAD = RANGE_GEOM.payload;
        P.TOKENS_PER_FRAME = 0;
        P.CHAIN_FRAMES = 1;
        P.RANGE_POOL = RANGE_POOL;
        return RANGE_GEOM;
    }

    /** 切回旧 6bit 几何（仅供解码旧文本 / 回归对照，UI 不再暴露） */
    function applyProfile(v) {
        const pf = profileFor(v);
        P.VER = 1;
        P.TOPK = pf.topk; P.BITS = pf.bits; P.NEED = pf.topk;
        P.SEG_BYTES = pf.segBytes; P.SEG_PAYLOAD = pf.payload;
        P.TOKENS_PER_FRAME = pf.tokensPerFrame;
        P.PROFILE = pf.topk;
        P.CHAIN_FRAMES = 2;
        return pf;
    }
    applyRangeGeometry();

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

    /* ── 以下帧级函数一律**显式接收档位几何 g**（第二参数）。
     *  默认值 P 只为兼容旧调用；解码路径必须传自己的 g，
     *  否则就会重演「用错档位的帧长/载荷校验」这个致命缺陷。 ── */

    function buildFrame(slice, seq, g) {
        g = frameGeometry(g);
        if (slice.length > g.payload) throw new Error('SLICE_TOO_LONG');
        const f = new Uint8Array(g.segBytes);
        const m = (P.MAGIC ^ nonceOf(slice)) & 0xffff;     // 自描述：由载荷导出
        f[0] = m >>> 8; f[1] = m & 0xff;
        f[2] = slice.length >>> 8; f[3] = slice.length & 0xff;
        f.set(slice, P.FRAME_HDR);
        const padLen = g.payload - slice.length;
        if (padLen > 0) {
            const seed = ((m << 16) ^ Math.imul(slice.length + 1, 2654435761) ^ hashBytes(slice)) >>> 0;
            f.set(prfStream(seed, padLen), P.FRAME_HDR + slice.length);
        }
        return f;
    }

    /** 解析并**自校验**（nonce 由载荷导出，故可独立验证，不依赖信封） */
    function parseFrame(f, seq, g) {
        g = frameGeometry(g);
        if (f.length !== g.segBytes) throw new Error('FRAME_SIZE');
        const len = (f[2] << 8) | f[3];
        if (len > g.payload) throw new Error('BAD_LEN');
        const slice = f.slice(P.FRAME_HDR, P.FRAME_HDR + len);
        const m = (f[0] << 8) | f[1];
        if (((m ^ nonceOf(slice)) & 0xffff) !== P.MAGIC) throw new Error('MAGIC_MISMATCH');
        return slice;
    }

    /** 只做帧头自校验（用于判定「这一档位解出的字节流是不是合法的帧流」） */
    function frameMagicOk(f, g) {
        g = frameGeometry(g);
        if (f.length !== g.segBytes) return false;
        const len = (f[2] << 8) | f[3];
        if (len > g.payload) return false;
        const m = (f[0] << 8) | f[1];
        return (((m ^ nonceOf(f.subarray(P.FRAME_HDR, P.FRAME_HDR + len))) & 0xffff) === P.MAGIC);
    }

    function splitPayload(bytes, g) {
        g = frameGeometry(g);
        const segs = [];
        for (let i = 0; i < bytes.length || segs.length === 0; i += g.payload) {
            segs.push(bytes.slice(i, i + g.payload));
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

    /* ══════════════════ ⑩ 定点整数区间编码（ver=2，默认路径） ══════════════════
     *
     * 取代「从密文读 6 bit 当 Top-64 下标」的均匀抽签。每步按模型原始
     * int32 定点分数建整数 CDF、细分区间，**分布保真**。
     *
     * ── 为什么不是 rANS ──
     * 教科书 rANS 要求 freq > 2^(s-8)，取 s=16 就得 freq ≥ 256，而候选池
     * 有 64~256 个符号、绝大多数 freq 远小于此 ⇒ 简单形式直接失效
     * （形式本身的限制，非实现问题）。故用**精确区间细分**。
     *
     * ── 帧边界为何无需传输 ──
     * 终止条件是 hi-lo == 1（区间坍缩到唯一整数）。解码端检出坍缩即为
     * 帧边界，故 token 数不必写进协议。
     *
     * ── 实测 ──
     * NLL 5.86 → 3.68（-37%）；吞吐 5.2~5.5 bit/token（模型真实熵）。
     * 旧路径的 6.00 bit/token 高于模型熵，信息论上不可达，多出的部分
     * 只能靠扭曲分布硬挤 —— 那正是文本崩坏的根因。
     */

    /* 帧几何见上方 P 区块的 RANGE_GEOM（单一真源）。 */

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

    /**
     * 每步定点尺度：取不超过 min(2^16, r) 的最大 2 的幂。
     *
     * ⚠️ 这是**终止性保证**，不是优化。若固定 M=2^16，当 r < 2^16 时某个
     * 极强势候选的 freq 可逼近 M，导致 hi'-lo' == r（区间不收缩）⇒ 死循环。
     * 取 M_step ≤ r 且池内每候选 freq ≥ 1 ⇒ freq_top ≤ M_step-1
     * ⇒ 新宽度 ≤ ceil(r·(M_step-1)/M_step) ≤ r-1 < r，严格收缩。
     * 两端都由 r 决定，无需传输；M_step ≤ r 也保证 t 不越界。
     */
    function stepScale(r) {
        const CAP = 1n << 16n;
        const m = r < CAP ? r : CAP;
        let p = 1n;
        while (p * 2n <= m) p *= 2n;
        return Number(p);
    }

    /**
     * 自适应最高频上限（保终止 + 几乎不损伤自然度）。
     *
     * ── 为什么必须存在 ──
     * 区间编码**最坏码长无上界**：某步 p→1 时只消耗 ≈0 bit，区间几乎不
     * 收缩。实测全 0x00 帧（V=0，每步都落 bucket 0）需 **805 步**，越过
     * 512 的 RoPE 硬上限。（真实密文不会出现 V=0，但协议不能靠这个。）
     *
     * ── 两种模式（配合签名里的 1 bit 模式位，解码端镜像） ──
     *  'lazy'（默认）：只在**落后于观测速率**时才压。正常密文速率 ≈5.2
     *      bit/token，need 通常低于它 ⇒ **不触发**，分布保持原样，
     *      实测 NLL 3.57。缺点是极端输入可能超预算（由编码端重试兜底）。
     *  'forced'（兜底）：严格按进度表 k = ceil(bitsLeft/stepsLeft) 压，
     *      保证每步 ≥k bit ⇒ **必在预算内坍缩**（实测最坏 510/512）。
     *      代价是全程压平分布，NLL 升到 ~4.8。
     *
     * 编码端先试 'lazy'；只有真的超了预算才改用 'forced' 重跑一次，并把
     * 模式写进链首签名，解码端据此走同一策略 ⇒ 两端逐字节一致。
     * 这样常规密文吃到 'lazy' 的自然度，病态输入也**绝不失败**。
     *
     * floorRate：lazy 模式下的保守速率下限（bit/token），低于它才干预。
     */
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

    /** 区间细分。⚠️ 必须取 **ceil** 而非 floor。
     *
     *  目标不变量 V ∈ [lo, hi)。设 a=cum[i]、b=cum[i+1]，
     *  t = floor((V-lo)·M/r) ∈ [a, b-1]：
     *    V-lo ≥ r·a/M ⇒ V-lo ≥ ceil(r·a/M)      （V-lo 为整数）
     *    V-lo < r·b/M ⇒ V-lo ≤ ceil(r·b/M)-1
     *  故 lo'=lo+ceil(r·a/M)、hi'=lo+ceil(r·b/M) 严格保持不变量。
     *  取 floor 时第二条不成立 —— 实测症状是区间**永不坍缩**、跑到步数上限。
     *  ceil 同时让相邻区间首尾相接（hi'(i)==lo'(i+1)），不重不漏。 */
    function narrow(lo, r, cum, i, Mv) {
        const Mb = BigInt(Mv);
        const a = (r * BigInt(cum[i]) + Mb - 1n) / Mb;
        const b = (r * BigInt(cum[i + 1]) + Mb - 1n) / Mb;
        return { lo: lo + a, hi: lo + b };
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

    /* ══════════════════ ⑪ 段级连续编解码 ══════════════════ */

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
            // ⚠️ logits 必须一并返回：区间编码的整数 CDF 依赖**原始定点分数**，
            //    只给名次无法还原模型真实分布（这正是本改造的核心）。
            return {
                topK: topKFromLogits(r.logits, MAX_TOPK),
                logits: r.logits,
                nextState: state,
            };
        };
        fwd.M = M;      // encodeChain 需要它来建初态
        fwd.V = V;
        return fwd;
    }

    /**
     * 编码**一条链**：chainBytes → 伪装文本（ver=2 路径）。
     *
     * ── cap 模式的两段式（保自然度 + 保成功） ──
     * ① 先用 'lazy'（只在落后时压）→ 常规密文 NLL ≈3.57；
     * ② 若真的超了 RANGE_BUDGET（病态输入），改用 'forced'（严格按进度表）
     *    重跑一次，必在预算内坍缩，代价是 NLL 升到 ≈4.8。
     * 最终用的模式写进链首签名，解码端据此走同一策略 ⇒ 两端逐字节一致。
     * 这样**绝不因输入而失败**，同时常规路径吃到最优自然度。
     */
    async function encodeChainRange(chainBytes, segBytes, fwd, V, onStep, signal) {
        const run = (mode) => encodeChainRangeOnce(chainBytes, segBytes, fwd, V, onStep, signal, mode);
        try {
            return await run('lazy');
        } catch (e) {
            if (e && /RANGE_MAX_STEPS/.test(e.message || '')) {
                return await run('forced');     // 兜底：必收敛
            }
            throw e;
        }
    }

    async function encodeChainRangeOnce(chainBytes, segBytes, fwd, V, onStep, signal, capMode) {
        const nFrames = Math.max(1, Math.ceil(chainBytes.length / segBytes));
        const state = createState(fwd.M);
        let last = P.BOS;
        const parts = [], perFrame = [];
        let total = 0, steps = 0;
        /* ⚠️ totalBits 必须**每帧局部**（= 8×segBytes），不能是整链总位数：
         * adaptiveCapFreq 的 rate = consumed/stepsUsed 必须两端看到同一组值。
         * 用整链值会让第 2 帧起 consumed 被前帧污染，编解码 cap 判断分叉 ⇒ DESYNC。 */
        const totalBits = 8 * segBytes;

        /* 链首 Codec 签名：1 个汉字，**不计入 step**（解码端读它也不占 step）。
         * 字库缺失时返回 ''，等价于关闭签名（此时退回旧路径自动识别）。 */
        const sig = makeSigChar(null, 2, RANGE_POOL_IDX, capMode === 'forced');
        if (sig) { const b = _te.encode(sig); parts.push(b); total += b.length; }

        for (let f = 0; f < nFrames; f++) {
            const slice = chainBytes.subarray(f * segBytes, Math.min((f + 1) * segBytes, chainBytes.length));
            const frame = new Uint8Array(segBytes);
            frame.set(slice);                       // 末帧零填充（与定长帧语义一致）
            const Vp = bytesToBigInt(frame);
            let lo = 0n, hi = 1n << BigInt(8 * segBytes);
            let fSteps = 0;

            while (hi - lo > 1n) {
                if (steps >= RANGE_BUDGET) {
                    throw new Error('RANGE_MAX_STEPS: ' + steps + '（超每链预算 ' + RANGE_BUDGET + '）');
                }
                const r = hi - lo;
                const Mv = stepScale(r);
                const Mb = BigInt(Mv);

                const fw = fwd(last, state);
                const pool = resolveRangePool(fw.topK, V, RANGE_POOL, Mv);
                const cdf = buildIntegerCDF(fw.logits, pool.ids, fwd.M.tables.exp_lut.arr, Mv,
                    adaptiveCapFreq(Mv, r, fSteps, totalBits, RANGE_BUDGET, capMode));

                const t = Number(((Vp - lo) * Mb) / r);
                const i = bucketOf(cdf.cum, cdf.L, Mv, t);
                const nx = narrow(lo, r, cdf.cum, i, Mv);
                lo = nx.lo; hi = nx.hi;

                parts.push(pool.bufs[i]);
                total += pool.bufs[i].length;
                last = pool.ids[i];
                steps++; fSteps++;

                if ((steps & (YIELD_EVERY - 1)) === 0) {
                    if (onStep) onStep(steps);
                    await yieldToUI();
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

    /**
     * 区间解码**一条链**：伪装文本 → 原始字节（ver=2 路径）。
     *
     * 逐帧检测「区间坍缩」即得帧边界，故帧数不必传输。
     * 终止：文本被完整消费，或达到 maxFrames。
     */
    async function decodeChainRange(textBytes, cursor0, segBytes, fwd, V, opts) {
        opts = opts || {};
        const signal = opts.signal;
        const maxFrames = opts.maxFrames || 64;
        const state = createState(fwd.M);
        let last = P.BOS;
        let cursor = cursor0 || 0, steps = 0;
        const out = [];
        const totalBits = 8 * segBytes;      // ⚠️ 与编码端同为**每帧**局部值

        /* 链首签名：编码端恒写 1 个 ver=2 汉字，解码端在此跳过它，
         * 并读出 cap 模式（lazy/forced）—— 两端必须走同一策略，否则 CDF 分叉。
         * 不占 step（两端同规则）。传 { sig:false } 可关闭（旧文本/裸正文），
         * 此时默认 lazy（与编码端首选模式一致）。 */
        let capMode = (opts.capMode) || 'lazy';
        if (opts.sig !== false) {
            const sg = readSigChar(textBytes, cursor);
            if (sg && sg.ver === 2) {
                cursor += sg.len;
                capMode = sg.forced ? 'forced' : 'lazy';
            }
        }

        while (cursor < textBytes.length && out.length < maxFrames) {
            let lo = 0n, hi = 1n << BigInt(8 * segBytes);
            let fSteps = 0;

            while (hi - lo > 1n) {
                if (steps >= RANGE_BUDGET) {
                    const e = new Error('RANGE_MAX_STEPS: ' + steps);
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                }
                if (cursor >= textBytes.length) {
                    const e = new Error('RANGE_TEXT_UNDERRUN@' + cursor);
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                }
                const r = hi - lo;
                const Mv = stepScale(r);

                const fw = fwd(last, state);
                const pool = resolveRangePool(fw.topK, V, RANGE_POOL, Mv);
                const cdf = buildIntegerCDF(fw.logits, pool.ids, fwd.M.tables.exp_lut.arr, Mv,
                    adaptiveCapFreq(Mv, r, fSteps, totalBits, RANGE_BUDGET, capMode));

                // 唯一命中：prefix-free 保证至多一个候选是此处前缀
                let hit = -1, hits = 0;
                for (let i = 0; i < pool.bufs.length; i++) {
                    if (V.matchesAt(textBytes, cursor, pool.bufs[i])) { if (hit < 0) hit = i; hits++; }
                }
                if (hits === 0) {
                    const e = new Error('RANGE_DESYNC@' + cursor + '（文本与候选集无法对齐）');
                    e.code = 'NOT_STEGO'; e.stepsUsed = steps; throw e;
                }
                if (hits > 1) throw new Error('RANGE_AMBIGUOUS@' + cursor);

                const nx = narrow(lo, r, cdf.cum, hit, Mv);
                lo = nx.lo; hi = nx.hi;

                last = pool.ids[hit];
                cursor += pool.bufs[hit].length;
                steps++; fSteps++;

                if ((steps & (YIELD_EVERY - 1)) === 0) {
                    if (opts.onStep) opts.onStep(steps);
                    if (opts.onChars) opts.onChars(cursor);
                    await yieldToUI();
                    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                }
            }
            out.push(bigIntToBytes(lo, segBytes));
        }
        if (opts.onChars) opts.onChars(cursor);

        let n = 0; for (const x of out) n += x.length;
        const bytes = new Uint8Array(n);
        let o = 0; for (const x of out) { bytes.set(x, o); o += x.length; }
        return { bytes, steps, consumed: cursor, frames: out.length };
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
        /* 链首档位签名：1 个汉字，**不计入 step**（解码端读它也不占 step）。
         * 字库缺失时 makeSigChar 返回 ''，等价于关闭签名。 */
        const sig = makeSigChar(P.TOPK);
        if (sig) { parts.push(_te.encode(sig)); total += parts[0].length; }
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

    /* ── 解码：**先读档位签名，再逐 token 解** ──
     *
     * 关键洞察（原实现依赖的性质，仍然成立）：**前向链与档位无关**。
     *   文本里第 i 个 token 是什么，是由密文决定的既定事实；
     *   档位只决定「该 token 在候选表中排第几」。
     *
     * 但「靠 7 个档位互相淘汰来猜档位」这条**启发式不可靠**：淘汰用的是
     * 帧头自校验，而只要接收端的全局 P 与发送端不一致，正确的档位就会被
     * 误杀 —— 这正是「跨页解不开」的根因。
     *
     * 现在改为：链起点固定读 1 个签名汉字，直接得到档位（见 makeSigChar）。
     * 读不到合法签名时（旧文本 / 字库缺失）才退回原来的 7 档竞速。
     */
    async function decodeAuto(textBytes, fwd, V, opts) {
        opts = opts || {};
        const signal = opts.signal;
        const useSig = opts.sig !== false && sigSupported();
        let live = PROFILES.map(pf => ({ pf, ok: true, acc: 0, nbits: 0, bytes: [] }));
        let state = createState(fwd.M);
        let last = P.BOS;
        let cursor = 0, steps = 0;
        let sigProfile = 0, sigAccepted = false;

        /* 只在「该档位自己的几何」上做帧头校验 —— 绝不读全局 P */
        const checkFrames = (L) => {
            if (L.bytes.length < L.pf.segBytes) return;
            const f = new Uint8Array(L.bytes.slice(0, L.pf.segBytes));
            if (!frameMagicOk(f, L.pf)) L.ok = false;
        };

        while (cursor < textBytes.length && live.some(L => L.ok)) {
            // ── 链起点：读档位签名（不占 step，编解码两侧同规则） ──
            if (steps % P.CHAIN_TOKENS === 0) {
                if (steps > 0) {                       // 新链：状态重置
                    state = createState(fwd.M);
                    last = P.BOS;
                }
                if (useSig) {
                    const sg = readSigChar(textBytes, cursor);
                    if (sg) {
                        cursor += sg.len;
                        sigAccepted = true;
                        if (sg.pf.topk !== sigProfile) {
                            sigProfile = sg.pf.topk;
                            // 钉死档位：只保留签名指定的那一档
                            for (const L of live) L.ok = (L.pf.topk === sigProfile);
                        }
                    }
                }
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
                checkFrames(L);                                    // ← 用 L 自己的几何
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

        let winner = live.filter(L => L.ok);
        if (!winner.length) {
            const e = new Error('这段内容不是隐写文本');
            e.code = 'NOT_STEGO'; e.stepsUsed = steps;
            throw e;
        }
        // 多档位同时存活说明文本太短（尚未凑满任何一档的帧长），取位宽最小者（最保守）
        winner.sort((a, b) => a.pf.bits - b.pf.bits);
        const W = winner[0];
        return {
            bytes: Uint8Array.from(W.bytes), profile: W.pf.topk,
            candidates: winner.length, steps, sig: sigAccepted,
        };
    }

    /* ══════════════════ 对外 API ══════════════════ */

    const Stego = {
        P, C,
        loadModel, loadVocab, createState, stepForward, topKFromLogits,
        makeForwarder,
        buildFrame, parseFrame, frameMagicOk, splitPayload, segmentEnvelope, mergeSegments,
        unitsFromBytes, bytesFromUnits, resolveByteCandidates,
        fnv1a16, nonceOf, nonce16, frameGeometry,
        makeSigChar, readSigChar, sigSupported,
        sigTable: SIG_TABLE,
        rshiftRound, isqrt, idivFloor,

        /* ── 区间编码（ver=2，默认） ── */
        encodeChainRange, decodeChainRange,
        buildIntegerCDF, stepScale, adaptiveCapFreq, resolveRangePool,
        bytesToBigInt, bigIntToBytes, bucketOf, narrow,
        RANGE_GEOM, RANGE_POOL, RANGE_BUDGET,
        applyRangeGeometry,
        get rangeGeometry() { return RANGE_GEOM; },
        /** 当前生效的编解码版本：2 = 区间编码，1 = 旧 6bit */
        get ver() { return P.VER; },

        /* ── 旧 6bit 路径（仅解码历史文本 / 回归对照，UI 不再暴露） ── */
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
            const g = frameGeometry(P);              // 帧几何，显式传递
            const segBytes = g.segBytes;
            const slices = splitPayload(cipherBytes, g);
            const framesTotal = slices.length;
            const chainsTotal = Math.ceil(framesTotal / P.CHAIN_FRAMES);
            const t0 = Date.now();
            let done = 0;
            /* ver=2 每帧 token 数不固定（区间编码变长），进度只能按链估算 */
            const estTokensPerFrame = P.VER === 2 ? 440 : P.TOKENS_PER_FRAME;
            const totalSteps = framesTotal * estTokensPerFrame;
            const msgid = opt.msgid || Math.random().toString(36).slice(2, 6);

            /* 先逐条链编码，再贪心打包成段（段的字数只有编完才知道，
             * 故不能预先按固定链数分段）。 */
            const chainTexts = [];
            for (let c = 0; c < chainsTotal; c++) {
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                const first = c * P.CHAIN_FRAMES;
                const K = Math.min(P.CHAIN_FRAMES, framesTotal - first);
                const chainBytes = new Uint8Array(K * segBytes);
                for (let k = 0; k < K; k++) {
                    chainBytes.set(buildFrame(slices[first + k], first + k + 1, g), k * segBytes);
                }
                const doneBase = done;
                const onStep = (stepInChain) => {
                    done = doneBase + stepInChain;
                    const el = Math.max(1, Date.now() - t0) / 1000;
                    if (opt.onProgress) opt.onProgress({
                        frame: Math.min(framesTotal, c + 1), framesTotal,
                        chain: c + 1, chainsTotal,
                        step: done, stepsTotal: totalSteps,
                        bps: done / el,
                        etaMs: ((totalSteps - done) / Math.max(done / el, 1e-6)) * 1000,
                    });
                };
                const body = (P.VER === 2)
                    ? (await encodeChainRange(chainBytes, segBytes, fwd, V, onStep, opt.signal)).text
                    : await encodeChain(chainBytes, fwd, V, onStep, opt.signal);
                chainTexts.push({ frames: K, body });
                done = doneBase + K * estTokensPerFrame;
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
            const segments = groups.map((gp, i) => ({
                seq: i + 1, total: segsTotal, msgid,
                frames: gp.frames, chains: gp.chains.length,
                body: gp.chains.join(''),
            }));
            const chars = segments.reduce((a, x) => a + x.body.length, 0);
            return { segments, frames: framesTotal, chains: chainsTotal, chars, ms: Date.now() - t0, ver: P.VER };
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
            /* 带签名解；失败且**这次确实读到过签名**时退回「无签名」再试一遍 ——
             * 签名与候选位流共用同一串文本，极小概率下签名校验会误命中
             * （7 档 × 含校验位 ≈ 2.7%），此时那 3 字节会整体错位。
             * 退回重试保证误命中不会变成"解不开"。 */
            try {
                return await this._decodeAll(text, opt, opt.sig);
            } catch (e) {
                if (e && e.code === 'NOT_STEGO' && opt.sig !== false && sigSupported() && !opt._retried) {
                    return await this._decodeAll(text, Object.assign({}, opt, { _retried: true }), false);
                }
                throw e;
            }
        },

        async _decodeAll(text, opt, useSig) {
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
            const enc = _te;
            const g2 = RANGE_GEOM;               // ver=2 几何（288B）
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
            let usedSig = false;

            for (let bi = 0; bi < mg.bodies.length; bi++) {
                const b = mg.bodies[bi];
                if (opt.signal && opt.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
                const base = charsDone;
                const tb = encBodies[bi];

                /* ── Codec 分流（零新增传输字段） ──
                 * 链首签名的 ver 位决定走哪条解码路径（**互斥，不猜**）：
                 *   ver=2 → 区间编码
                 *   ver=1 → 旧 6bit 均匀（历史文本），签名由 decodeAuto 自己读
                 *   无签名 → 先试区间编码（lazy/forced 都试），再退回旧 7 档竞速
                 *
                 * ⚠️ ver=1 不能走"先试区间"分支：区间解码对同一串文本可能
                 *    **偶然**跑通并产出错误字节（静默损坏），也可能直接失败。
                 *    既然签名已明确告知是旧 Codec，就必须直接照做。 */
                const wantSig = useSig !== false && sigSupported();
                const sigInfo = wantSig ? readSigChar(tb, 0) : null;
                let bytes = null, detectedVer = 0, steps = 0, usedThisSig = false;

                const mkOnChars = () => (byteOff) => {
                    const map = charAtByte[bi];
                    const done = base + map[Math.min(byteOff, map.length - 1)];
                    if (done < charsDone) return;             // 单调保护
                    charsDone = done;
                    if (opt.onProgress) opt.onProgress({
                        chars: charsDone, charsTotal: totalChars,
                        segment: b.seq, segmentsTotal: mg.total,
                    });
                };
                /* decodeChainRange 自己会跳过链首 ver=2 签名（sig:true 时）
                 * 并从签名读出 cap 模式；sig:false 时用 capMode 显式指定。 */
                const tryRange = (useSigChar, capMode) => decodeChainRange(tb, 0, g2.segBytes, fwd, V, {
                    signal: opt.signal,
                    sig: useSigChar,
                    capMode: capMode || 'lazy',
                    onStep: () => {},
                    maxFrames: Math.max(1, Math.ceil(tb.length / 24)),
                    onChars: mkOnChars(),
                });
                const tryLegacy = (useSigChar) => decodeAuto(tb, fwd, V, {
                    signal: opt.signal,
                    sig: useSigChar,
                    onStep: () => {},
                    onChars: mkOnChars(),
                });

                if (sigInfo && sigInfo.ver === 2) {
                    const r2 = await tryRange(true);
                    bytes = r2.bytes; steps = r2.steps; detectedVer = 2; usedThisSig = true;
                } else if (sigInfo && sigInfo.ver === 1) {
                    // 签名明确是旧 Codec ⇒ 直接走旧路径（由它自己读签名）
                    const auto = await tryLegacy(true);
                    bytes = auto.bytes; steps = auto.steps; detectedVer = 1;
                    detected = auto.profile; usedSig = usedSig || !!auto.sig;
                } else {
                    /* 无签名（旧文本无签名 / 字库缺失）：发送端可能用 lazy 或
                     * forced，两者都试；都失败再退回旧 6bit 的 7 档竞速。 */
                    let got = null;
                    for (const cm of ['lazy', 'forced']) {
                        try { got = await tryRange(false, cm); break; }
                        catch (e2) { if (!(e2 && e2.code === 'NOT_STEGO')) throw e2; }
                    }
                    if (got) {
                        bytes = got.bytes; steps = got.steps; detectedVer = 2;
                    } else {
                        const auto = await tryLegacy(false);
                        bytes = auto.bytes; steps = auto.steps; detectedVer = 1;
                        detected = auto.profile; usedSig = usedSig || !!auto.sig;
                    }
                }
                charsDone = base + b.body.length;
                if (opt.onProgress) opt.onProgress({
                    chars: charsDone, charsTotal: totalChars,
                    segment: b.seq, segmentsTotal: mg.total,
                });

                /* 切帧：ver=2 用区间几何（288B），ver=1 用识别出的档位几何。
                 * 尾部残帧（链末对齐不足）丢弃。 */
                const g = (detectedVer === 2) ? g2 : frameGeometry(detected);
                const nFrames = Math.floor(bytes.length / g.segBytes);
                for (let i = 0; i < nFrames; i++) {
                    try {
                        out.push(parseFrame(bytes.subarray(i * g.segBytes, (i + 1) * g.segBytes), i + 1, g));
                    } catch (e) { break; }
                }
                if (detectedVer === 2) { detected = 2; usedSig = usedSig || usedThisSig; }
            }
            const total = out.reduce((a, x) => a + x.length, 0);
            const joined = new Uint8Array(total);
            let o = 0;
            for (const x of out) { joined.set(x, o); o += x.length; }
            return {
                bytes: joined, ms: Date.now() - t0, profile: detected,
                segments: mg.total, bare: !!mg.bare, sig: usedSig,
            };
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

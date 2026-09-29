/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写 · 传输层（Transport）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 纯 script 加载，无 ESM / 无构建 / 无依赖 → window.StegoTransport
 *
 * ══ 为什么单独一层 ══
 *   Codec（src/stego.js）只应做一件事：二进制 ↔ 伪装文本。
 *   而下面这些都不是 Codec 的职责，故整体搬到这里：
 *
 *     ① 段信封  CX2|seq/total|msgid|total:seq|body
 *        —— 它是**发送排版**格式（把多段归到同一条消息、支持乱序粘贴），
 *           不是解码必需品。Codec 不认识它也能独立解码裸正文。
 *     ② 排版分段  —— QQ 单条 2000 字上限，纯 UI 约束。
 *     ③ 容量预估  —— 需要知道"加密开销"，而那是加密层的知识。
 *
 * ══ 与加密层的边界 ══
 *   本层**不实现**加密，也不持有密钥。它只在预估时接收一个由加密层注入的
 *   `overheadBytes`（CX2 固定开销），从而让隐写层彻底摆脱对加密开销的硬编码。
 *   加密层通过 StegoTransport.registerCrypto({ overhead }) 注册。
 */
(function (global) {
    'use strict';

    /* ── 排版常量（纯 UI / 传输约束，与编解码无关） ── */
    const SEG_CHAR_LIMIT = 2000;      // QQ 单条上限
    const HEADROOM = 16;              // 段头 "CX2|1/9|abcd|9:1|" 最大长度余量

    /* ── 容量系数（真模型实测标定） ──
     *
     * 每 1 字节**载荷**产出约 2.15 个伪装字符（单字平均承载 ≈3.69 bit）。
     * 该系数来自 ver=2 实测定标：288B 帧 → 624 字 → 624/288 = 2.17；
     * 多组随机载荷实测 1.96~2.36，取 2.15 作居中值。
     *
     * ⚠️ 改词表 / 模型后必须重测，否则预估会偏。 */
    const CHARS_PER_BYTE = 2.15;

    /* ── 加密层注入的固定开销（默认 0 = 未知，预估退化为纯载荷线性） ──
     * ⚠️ 硬编码 131 曾是"隐写层知道加密细节"的耦合点，现已移除：
     *    由 CX2 侧注册，未注册时**不猜**，宁可少算也不虚报。 */
    let cryptoOverhead = 0;
    function registerCrypto(info) {
        if (info && typeof info.overheadBytes === 'number' && isFinite(info.overheadBytes)) {
            cryptoOverhead = Math.max(0, Math.round(info.overheadBytes));
        }
        return { overheadBytes: cryptoOverhead };
    }
    const overhead = () => cryptoOverhead;

    /* ══════════════════ ① 段信封 ══════════════════ */

    const ENV_RE = /CX2\|(\d+)\/(\d+)\|([A-Za-z0-9]+)\|(\d+):(\d+)\|/g;

    const envelope = (seq, total, msgid, body) =>
        'CX2|' + seq + '/' + total + '|' + msgid + '|' + total + ':' + seq + '|' + body;

    /**
     * 把带段头的文本还原成"分段化的正文"。
     *
     * 三种输入都要能处理：
     *   ① 带段头（按段复制/乱序粘贴）→ 按 seq 归位
     *   ② 无段头全文（「复制全文」）→ 整段当正文
     *   ③ 单段裸正文 → 同 ②
     *
     * @returns {{bodies:Array|null, msgid?, total, got, missing, incomplete, bare?}}
     */
    function mergeSegments(text) {
        const s = String(text || '');
        // ⚠️ 剥离一切空白与零宽字符：token 内已保证不含空白（词表黑名单），
        //    故这是安全的，且能免疫 \r\n、平台插入空格、零宽空格等污染。
        const strip = (x) => x.replace(/[\s\u200b-\u200d\ufeff]/g, '');
        const found = [];
        let m; ENV_RE.lastIndex = 0;
        while ((m = ENV_RE.exec(s)) !== null) {
            found.push({ at: m.index, end: ENV_RE.lastIndex, total: +m[2], mid: m[3], i: +m[5] });
        }
        /* 无段头 → **整段就是正文**。
         * 段头只是排版标识（分组 + 乱序重排），不是解密的必需品 ——
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
        // 用户可能一次贴了多条消息：取段数最多的一组作为本次要处理的消息
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

    /* ══════════════════ ② 排版分段 ══════════════════ */

    /**
     * 把伪装文本按 SEG_CHAR_LIMIT 切成发送用的段。
     *
     * ⚠️ 切段是**按字符**截断，不做任何"对齐"——语言隐写是变长比特/字，
     *    字符数对不上字节数，跨段拼接由 Codec 的块长度头自定界，
     *    不需要（也不可能）保持什么位对齐周期。
     *
     * @param {string} text 纯正文（无段头）
     * @param {string} msgid 消息标识
     * @returns {{segments:Array<{seq,total,msgid,body}>, segs:number}}
     */
    function segmentText(text, msgid) {
        const body0 = String(text == null ? '' : text);
        const limit = Math.max(1, SEG_CHAR_LIMIT - HEADROOM);
        const mid = String(msgid || Math.random().toString(36).slice(2, 6));
        const parts = [];
        if (!body0.length) parts.push('');
        else for (let i = 0; i < body0.length; i += limit) parts.push(body0.slice(i, i + limit));
        const total = parts.length;
        return {
            segs: total,
            segments: parts.map((body, i) => ({ seq: i + 1, total, msgid: mid, body })),
        };
    }

    /** 带段头的线上文本（仅用于「复制本段 / 复制全部」） */
    function wires(segments) {
        return (segments || []).map(s => envelope(s.seq, s.total, s.msgid, s.body));
    }

    /* ══════════════════ ③ 容量预估（纯线性，单调） ══════════════════ */

    /**
     * 预估伪装文本规模。
     *
     * ── 公式（已废弃旧的分帧阶梯） ──
     *   旧：帧数 = ceil(密文 / 284)，字数 = 帧数 × 624
     *       → 阶梯跳跃、短消息虚高（不足 200B 时固定开销占比大）
     *   新：字数 ≈ (PayloadBytes + 2 × 块数) × 2.15
     *       → 单调线性，块数只贡献每块 2 字节的长度头
     *
     * @param {number} payloadBytes 纯载荷字节数（**不含**加密开销）
     * @param {object} [opt] {chunkMax, charsPerByte}
     */
    function estimate(payloadBytes, opt) {
        opt = opt || {};
        const S = global.Stego;
        const chunkMax = opt.chunkMax || (S && S.CHUNK_MAX) || 256;
        const cpb = opt.charsPerByte || CHARS_PER_BYTE;
        const n = Math.max(0, Math.round(payloadBytes || 0));
        /* 块数：与 encodeBytes 的分块规则一致（空载荷也算 1 块，仅长度头） */
        const chunks = Math.max(1, Math.ceil(n / chunkMax));
        const bytesWithHead = n + 2 * chunks;
        const chars = Math.ceil(bytesWithHead * cpb);
        const segs = Math.max(1, Math.ceil(chars / Math.max(1, SEG_CHAR_LIMIT - HEADROOM)));
        return {
            payloadBytes: n, chunks, chunksBytes: 2 * chunks, bytesWithHead,
            chars, segs, charsPerByte: cpb, chunkMax,
        };
    }

    /** 由明文规模预估（加密层注入的开销在此生效）。
     *  ⚠️ overhead 未注册时按 0 计，宁可少算也不虚报。 */
    function estimateFromPlain(plainBytes) {
        const p = Math.max(0, Math.round(plainBytes || 0));
        const payload = p + cryptoOverhead;
        return Object.assign(estimate(payload), {
            plainBytes: p, overheadBytes: cryptoOverhead,
            overheadKnown: cryptoOverhead > 0,
        });
    }

    const StegoTransport = {
        SEG_CHAR_LIMIT, HEADROOM, CHARS_PER_BYTE,
        registerCrypto, overhead,
        envelope, mergeSegments, segmentText, wires,
        estimate, estimateFromPlain,
        /** 由密文 Base64 字符串长度推载荷字节数（纯算术，不引入加密依赖） */
        b64Bytes(b64) {
            const s = String(b64 || '').replace(/\s+/g, '');
            if (!s) return 0;
            return Math.floor(s.length * 3 / 4);
        },
    };

    global.StegoTransport = StegoTransport;
})(typeof window !== 'undefined' ? window : globalThis);

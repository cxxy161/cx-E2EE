/* ═══════════════════════════════════════════════════════════════════
 * 帧封装：定长对齐 + Magic 头 + PRF 填充
 * ═══════════════════════════════════════════════════════════════════
 *
 * 帧布局（SEG_BYTES = 192）：
 *   [0..1]   Magic ⊕ nonce    —— 每段不同的伪魔数（见下）
 *   [2..3]   Len              —— 本段真实载荷字节数（大端）
 *   [4..]    CX2 密文切片
 *   [..192]  PRF 伪随机填充
 *
 * ── 为什么是 192 而不是"66 字节桶" ──
 * 原规范同时给了两个粒度：桶 66 字节、单段 192 字节。但 192 % 66 ≠ 0，
 * 两者互斥。这里**合并为一个概念**：段长 = 桶长 = 192 字节。
 *   192 × 8 = 1536 bit = 256 × 6 bit  → 整除，无残位
 *   192 % 3 == 0                      → 满足 8B % 6 == 0 的必要条件
 * （66 也整除，但 66 无法切成 192 的段；若确需 66，则段长应改为 198 = 3×66。）
 *
 * ── 为什么 Magic 要 XOR nonce ──
 * 原规范把固定 Magic 0x5354 放在载荷最前。但载荷最前就是位流最前，
 * 于是**每一步的首 2 个 token 由固定 12 bit 决定**，而 BOS 也是固定的 [1]，
 * 结果：每条密文的伪装文本都带同一个固定两词开头 ——
 * 正是 docs/hanzi-prefix.md 记录的「犯之说浙没」指纹，换了个位置复发。
 *
 * 对策：Magic 与 (msgid, seq) 派生的 nonce 异或。nonce 由**明文段头**里已有的
 * 字段导出，不新增字段、不改信封格式；接收端同样能算出，Fast-Fail 照旧可用。
 */

export const SEG_BYTES = 192;                       // 192*8 = 1536 = 256*6
export const FRAME_HDR = 4;                         // [magic^nonce:2][len:2]
export const SEG_PAYLOAD = SEG_BYTES - FRAME_HDR;   // 188 字节可用载荷
export const MAGIC = 0x5354;

export function fnv1a16(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ((h >>> 16) ^ h) & 0xffff;
}

export function hashBytes(u8) {
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = (h * 0x01000193) >>> 0; }
    return h >>> 0;
}

/** 段级 nonce：由信封里已有的 msgid + seq 派生，不新增传输字段 */
export const nonce16 = (msgid, seq) => fnv1a16(String(msgid) + '/' + String(seq));

/** 本段首 12 bit 的期望值（Fast-Fail 用） */
export const expected12 = (msgid, seq) => (((MAGIC ^ nonce16(msgid, seq)) & 0xffff) >>> 4) & 0xfff;

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

/**
 * 构造定长帧。
 * ⚠️ PRF 填充**不隐藏长度** —— Len 字段就明文躺在载荷里，任何拿到模型的人都能读。
 *    它的实际作用只是让尾部不是一片 0（对"知道有此方案但无模型"的观察者，
 *    零填充会直接暴露边界）。真正的长度遮蔽来自"每段都凑满 192 字节"。
 */
export function buildFrame(slice, msgid, seq) {
    if (slice.length > SEG_PAYLOAD) throw new Error('SLICE_TOO_LONG: ' + slice.length);
    const f = new Uint8Array(SEG_BYTES);
    const n = nonce16(msgid, seq);
    const m = (MAGIC ^ n) & 0xffff;
    f[0] = m >>> 8; f[1] = m & 0xff;
    const len = slice.length;
    f[2] = len >>> 8; f[3] = len & 0xff;
    f.set(slice, FRAME_HDR);
    const padLen = SEG_PAYLOAD - len;
    if (padLen > 0) {
        const seed = ((m << 16) ^ Math.imul(len + 1, 2654435761) ^ hashBytes(slice)) >>> 0;
        f.set(prfStream(seed, padLen), FRAME_HDR + len);
    }
    return f;
}

export function parseFrame(f, msgid, seq) {
    if (f.length !== SEG_BYTES) throw new Error('FRAME_SIZE: ' + f.length);
    const n = nonce16(msgid, seq);
    const m = (f[0] << 8) | f[1];
    if (((m ^ n) & 0xffff) !== MAGIC) throw new Error('MAGIC_MISMATCH');
    const len = (f[2] << 8) | f[3];
    if (len > SEG_PAYLOAD) throw new Error('BAD_LEN: ' + len);
    return f.slice(FRAME_HDR, FRAME_HDR + len);
}

/** 把 CX2 密文按 188 字节切成段切片（空输入也产出 1 段，保证有帧可发） */
export function splitPayload(bytes) {
    const segs = [];
    for (let i = 0; i < bytes.length || segs.length === 0; i += SEG_PAYLOAD) {
        segs.push(bytes.slice(i, i + SEG_PAYLOAD));
    }
    return segs;
}

/** 段信封（与既有格式一致，未改动） */
export function segmentEnvelope(seq, total, msgid, body) {
    return 'CX2|' + seq + '/' + total + '|' + msgid + '|' + total + ':' + seq + '|' + body;
}

const ENV_RE = /CX2\|(\d+)\/(\d+)\|([A-Za-z0-9]+)\|(\d+):(\d+)\|/g;

/** 与 text-crypto.html:_mergeSegments 同构的合并器（乱序拼接 / 缺段提示） */
export function mergeSegments(text) {
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
    const { mid, list } = best;

    const total = Math.max(...list.map(x => x.total));
    const have = new Map(list.map(x => [x.i, x]));
    const missing = [];
    for (let i = 1; i <= total; i++) if (!have.has(i)) missing.push(i);

    const out = [];
    for (let i = 1; i <= total; i++) {
        const f = have.get(i);
        if (!f) continue;
        const next = list.find(x => x.at > f.at);
        const bodyEnd = next ? next.at : s.length;
        // 段体清洗：剥离一切空白与零宽字符（已由白名单保证 token 内不含空白，故安全）
        out.push({ seq: i, body: s.slice(f.end, bodyEnd).replace(/[\s\u200b-\u200d\ufeff]/g, '') });
    }
    return { bodies: out, msgid: mid, total, got: list.length, missing, incomplete: missing.length > 0 };
}

/* ═══════════════════════════════════════════════════════════════════
 * 真词表加载器（字节级 · 零 TextDecoder 依赖）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 铁律（本次变更的核心）：**绝不对单个候选 token 调用 TextDecoder.decode()**。
 * 全程以 Uint8Array 做前缀比对与拼接，只有整段字节流拼装完成才允许解码成文本。
 *
 * 依据 vocab.bin 真实布局（format.json）：
 *   偏移 0            : 4096 × uint16 小端 = 索引表（8192 B）
 *   偏移 8192         : UTF-8 字节流（18,362 B）
 *   token i 的字节    = stream[offset[i] : offset[i+1]]
 *   末个 token 结束位 = vocab.stream_bytes
 */
import { readFileSync } from 'node:fs';

/**
 * 精确黑名单：只堵三类真正有害的 token。
 *
 * 唯一准则：编码端**绝不产出解码端会剥离的字符**。
 * 解码端（mergeSegments）剥 /[\s\u200b-\u200d\ufeff]/g，
 * 黑名单必须精确覆盖它 —— 漏一个就是「编码成功、解码必然 DESYNC」的静默损坏。
 *
 * 为什么不用白名单：边界永远太窄。实测 E4–E9 白名单把中文标点全灭
 * （标点数 = 0），并误杀 83 个多字词组，逼候选深层递补生僻字 → 语义崩塌。
 */
export function isBlacklistedBytes(t) {
    const len = t.length;
    for (let i = 0; i < len; i++) {
        const b = t[i];

        if (b < 0x20) return true;                  // C0 控制（含 \n \r \t）
        if (b === 0x20) return true;                // ⚠️ 半角空格（b<0x20 覆盖不到）
        if (b === 0x7F) return true;   // DEL（注意：0x80-0x9F 是 UTF-8 续接字节，绝不能当控制符拒！）

        if (b === 0xEF && i + 2 < len && t[i + 1] === 0xBF && t[i + 2] === 0xBD) return true;  // U+FFFD

        if (b === 0xE2 && i + 2 < len && t[i + 1] === 0x80 && t[i + 2] >= 0x8B && t[i + 2] <= 0x8D) return true; // 零宽
        if (b === 0xEF && i + 2 < len && t[i + 1] === 0xBB && t[i + 2] === 0xBF) return true;  // BOM

        if (b === 0xC2 && i + 1 < len && t[i + 1] === 0xA0) return true;                       // NBSP
        if (b === 0xE1 && i + 2 < len && t[i + 1] === 0x9A && t[i + 2] === 0x80) return true;  // U+1680
        if (b === 0xE2 && i + 2 < len && t[i + 1] === 0x80 &&
            ((t[i + 2] >= 0x80 && t[i + 2] <= 0x8A) || t[i + 2] === 0xA8 ||
             t[i + 2] === 0xA9 || t[i + 2] === 0xAF)) return true;                             // 各类空格/行分隔
        if (b === 0xE2 && i + 2 < len && t[i + 1] === 0x81 && t[i + 2] === 0x9F) return true;  // U+205F
        if (b === 0xE3 && i + 2 < len && t[i + 1] === 0x80 && t[i + 2] === 0x80) return true;  // U+3000

        if (b === 0x3C && i + 1 < len && t[i + 1] === 0x7C) return true;                       // `<|` 特殊 token
    }
    return false;
}

/**
 * @param {string} vocabBinPath  vocab.bin 路径
 * @param {object} fmt           format.json 的 vocab 段
 */
export function loadVocabBytes(vocabBinPath, fmtVocab) {
    const n = fmtVocab.vocab_size;
    const IB = fmtVocab.index_bytes;
    const SB = fmtVocab.stream_bytes;
    const raw = readFileSync(vocabBinPath);
    if (raw.length !== IB + SB) {
        throw new Error(`vocab.bin 大小不符：期望 ${IB + SB}，实际 ${raw.length}`);
    }

    // 索引 + 切片：全部 subarray，零拷贝、零字符串
    const offs = new Uint16Array(n);
    for (let i = 0; i < n; i++) offs[i] = raw.readUInt16LE(i * 2);

    const stream = new Uint8Array(raw.buffer, raw.byteOffset + IB, SB);
    const toks = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = offs[i];
        const b = (i + 1 < n) ? offs[i + 1] : SB;
        toks[i] = stream.subarray(a, b);
    }

    /* ── 字节级原语 ── */

    /** a 是否为 b 的前缀（含相等）。纯字节比较，不涉及任何编码。 */
    function isPrefix(a, b) {
        if (a.length > b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /** 文本字节流 text 在 pos 处是否以候选 a 开头 */
    function matchesAt(text, pos, a) {
        if (pos + a.length > text.length) return false;
        for (let i = 0; i < a.length; i++) if (text[pos + i] !== a[i]) return false;
        return true;
    }

    /** 拼接若干 token 的字节（仅用于整段输出，不在单 token 粒度解码） */
    function concat(ids) {
        let len = 0;
        for (const id of ids) len += toks[id].length;
        const out = new Uint8Array(len);
        let o = 0;
        for (const id of ids) { out.set(toks[id], o); o += toks[id].length; }
        return out;
    }

    /* ── 白名单（纯字节判定，不解码） ── */

    /** 黑名单准入：只堵会被解码端剥离 / 语义垃圾 / 特殊 token 三类 */
    const allowed = new Uint8Array(n);
    let passCount = 0;
    for (let i = 0; i < n; i++) {
        if (!isBlacklistedBytes(toks[i])) { allowed[i] = 1; passCount++; }
    }

    return {
        size: n,
        bytes: toks,
        byteLen: (id) => toks[id].length,
        raw: (id) => toks[id],
        isPrefix, matchesAt, concat,
        isAllowed: (id) => allowed[id] === 1,
        allowedCount: passCount,
        rejectedCount: n - passCount,
        isBlacklistedBytes,
        /** 仅供展示/自检使用：整段解码 */
        decodeAll: (ids) => new TextDecoder('utf-8', { fatal: false }).decode(concat(ids)),
    };
}

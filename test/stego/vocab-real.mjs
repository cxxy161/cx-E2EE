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

export const TOKEN_BYTES = (() => {
    throw new Error('deprecated');
});

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

    /**
     * 判定 token 是否为「可安全用于伪装文本的完整 UTF-8 汉字序列」。
     *
     * ⚠️ 这里**不做** TextDecoder 调用，而是用字节结构直接判定：
     *    只接受 3 字节序列 E4-E9 / xx / xx（CJK 统一汉字 U+4E00–U+9FFF）。
     *    这样天然排除：
     *      - 局部字节片段（无合法首字节）
     *      - 字面 EF BF BD（U+FFFD 替换字符，真词表里有 456 个 id 是这个）
     *      - ASCII / 空白 / 控制字节
     */
    function isCJKToken(id) {
        const t = toks[id];
        if (t.length === 0 || t.length % 3 !== 0) return false;
        for (let i = 0; i < t.length; i += 3) {
            const b0 = t[i], b1 = t[i + 1], b2 = t[i + 2];
            if (b0 < 0xE4 || b0 > 0xE9) return false;          // U+4E00..U+9FFF 的首字节
            if ((b1 & 0xC0) !== 0x80 || (b2 & 0xC0) !== 0x80) return false;
        }
        return true;
    }

    /** 汉字 + 中文标点（标点按 UTF-8 编码表逐个字节匹配，仍不解码） */
    const CN_PUNCT_IDS = (() => {
        const set = new Set();
        const punct = '，。！？、；：（）《》“”‘’…—·';
        const enc = new TextEncoder();
        for (const ch of punct) {
            const pb = enc.encode(ch);
            for (let i = 0; i < n; i++) {
                const t = toks[i];
                if (t.length === pb.length) {
                    let same = true;
                    for (let k = 0; k < pb.length; k++) if (t[k] !== pb[k]) { same = false; break; }
                    if (same) { set.add(i); break; }
                }
            }
        }
        return set;
    })();

    function isCJKPunctToken(id) { return isCJKToken(id) || CN_PUNCT_IDS.has(id); }

    /* ── 统计 ── */
    let cjk = 0;
    for (let i = 0; i < n; i++) if (isCJKToken(i)) cjk++;

    return {
        size: n,
        bytes: toks,
        byteLen: (id) => toks[id].length,
        raw: (id) => toks[id],
        isPrefix, matchesAt, concat,
        isCJKToken, isCJKPunctToken,
        cjkCount: cjk,
        punctCount: CN_PUNCT_IDS.size,
        /** 仅供展示/自检使用：整段解码 */
        decodeAll: (ids) => new TextDecoder('utf-8', { fatal: false }).decode(concat(ids)),
    };
}

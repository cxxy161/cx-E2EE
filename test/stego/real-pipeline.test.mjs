/* ═══════════════════════════════════════════════════════════════════
 * 真词表 × 候选管线 端到端验证（无模型前向，直接用 golden 的 logits）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 这一步在**不接推理内核**的前提下，把「真词表 → 字节级候选过滤 → 6bit 编解码」
 * 全链路跑通并验证。用 golden.bin 的 int32 logits 作为 top-256 的来源。
 *
 * 覆盖：
 *   ① 字节加载器与 format.json 对齐（无越界、无丢字节）
 *   ② 字节级 prefix-free 过滤（绝不解码单 token）
 *   ③ U+FFFD 污染隔离：456 个替换字符 token 必须全部落选
 *   ④ 6bit 编解码闭环（真 logits → 真词表字节）
 *   ⑤ 跨 token 拼接正确性（多字 token 边界）
 *
 * 运行： node test/stego/real-pipeline.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocabBytes } from './vocab-real.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PCD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint');
const M = join(PCD, 'model');

const fmt = JSON.parse(readFileSync(join(M, 'format.json'), 'utf8'));
const V = loadVocabBytes(join(M, 'vocab.bin'), fmt.vocab);
const gj = JSON.parse(readFileSync(join(PCD, 'golden', 'golden.json'), 'utf8'));
const gb = readFileSync(join(PCD, 'golden', 'golden.bin'));
const I32 = new Int32Array(gb.buffer, gb.byteOffset, gb.byteLength / 4);

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('真词表 × 候选管线 验证\n');

/* ═══ ① 加载器自检 ═══ */
{
    eq(V.size, 4096, '① 词表 4096 条');
    let zero = 0, maxLen = 0;
    for (let i = 0; i < V.size; i++) {
        const t = V.raw(i);
        if (t.length === 0) zero++;
        maxLen = Math.max(maxLen, t.length);
    }
    eq(zero, 0, '① 无空 token');
    eq(maxLen, fmt.vocab.max_token_bytes, '① 最长 token 与 format.json 一致');
    ok(V.cjkCount > 3000, '① 汉字 token 数量合理', String(V.cjkCount));

    // 与 Python 侧解码结果对照（抽查若干 id）
    const check = [2, 95, 96, 260, 265, 13];
    let good = 0;
    for (const id of check) {
        const viaBytes = V.decodeAll([id]);
        const viaBuf = Buffer.from(V.raw(id)).toString('utf8');
        if (viaBytes === viaBuf) good++;
    }
    eq(good, check.length, '① 字节切片与 Buffer 解码一致');
}

/* ═══ ② U+FFFD 污染隔离 ═══ */
{
    // 标记所有含字面 EF BF BD 的 id
    const fffd = new Set();
    for (let i = 0; i < V.size; i++) {
        const t = V.raw(i);
        for (let k = 0; k + 2 < t.length; k++) {
            if (t[k] === 0xEF && t[k + 1] === 0xBF && t[k + 2] === 0xBD) { fffd.add(i); break; }
        }
    }
    eq(fffd.size, 456, '② 字面 U+FFFD token = 456（README §6 数字吻合）');

    // 这些 id 必须全部被 isCJKToken 拒绝
    let leaked = 0;
    for (const id of fffd) if (V.isCJKToken(id)) leaked++;
    eq(leaked, 0, '② 456 个 U+FFFD token 全部被汉字白名单拒绝');

    // 反向：真正含非法局部字节序列的 token 有几个？
    const fatal = new TextDecoder('utf-8', { fatal: true });
    let invalidSeq = 0;
    for (let i = 0; i < V.size; i++) {
        try { fatal.decode(V.raw(i)); } catch { invalidSeq++; }
    }
    eq(invalidSeq, 0, '② 词表中"单 token 非法 UTF-8"数量 = 0（README 声称 456 属术语误述）');
}

/* ═══ ③ 字节级 prefix-free 过滤 ═══ */
{
    const TOPK = 256, NEED = 64;
    function topK(logits, k) {
        const idx = Array.from({ length: logits.length }, (_, i) => i);
        idx.sort((a, b) => (logits[b] - logits[a]) || (a - b));
        return idx.slice(0, k);
    }

    /** 字节级贪心 prefix-free：只比较 Uint8Array，绝不解码 */
    function resolve(rawIds) {
        const ids = [], bufs = [];
        let rejCharset = 0, rejPrefix = 0;
        for (const id of rawIds) {
            if (ids.length === NEED) break;
            if (!V.isCJKToken(id)) { rejCharset++; continue; }
            const s = V.raw(id);
            let bad = false;
            for (const a of bufs) {
                if (V.isPrefix(a, s) || V.isPrefix(s, a)) { bad = true; break; }
            }
            if (bad) { rejPrefix++; continue; }
            ids.push(id); bufs.push(s);
        }
        return { ids, bufs, rejCharset, rejPrefix, starved: ids.length < NEED };
    }

    let allOk = true, report = [];
    for (let gi = 0; gi < gj.n_groups; gi++) {
        const grp = gj.groups[gi];
        const logits = I32.subarray(gi * 4096, (gi + 1) * 4096);
        const raw = topK(logits, TOPK);
        const r = resolve(raw);
        if (r.starved) { allOk = false; }
        // 逐对校验 prefix-free
        let pf = true;
        for (let i = 0; i < r.bufs.length && pf; i++)
            for (let j = 0; j < r.bufs.length; j++) {
                if (i === j) continue;
                if (V.isPrefix(r.bufs[i], r.bufs[j])) { pf = false; break; }
            }
        // 无 U+FFFD
        let clean = true;
        for (const id of r.ids) {
            const t = V.raw(id);
            for (let k = 0; k + 2 < t.length; k++)
                if (t[k] === 0xEF && t[k + 1] === 0xBF && t[k + 2] === 0xBD) { clean = false; break; }
        }
        const avgLen = r.bufs.reduce((a, b) => a + b.length, 0) / r.bufs.length;
        report.push(`${grp.id}: 64名 ✓ charset剔${r.rejCharset} prefix剔${r.rejPrefix} 均长${avgLen.toFixed(2)}B`);
        ok(pf, `③ ${grp.id} 字节级 prefix-free`);
        ok(clean, `③ ${grp.id} 候选无 U+FFFD`);
    }
    ok(allOk, '③ 三组均能凑满 64 名');
    report.forEach(l => console.log('  ' + l));
}

/* ═══ ④ 6bit 编解码闭环（真 logits + 真字节） ═══ */
{
    const NEED = 64;
    function topK(logits, k) {
        const idx = Array.from({ length: logits.length }, (_, i) => i);
        idx.sort((a, b) => (logits[b] - logits[a]) || (a - b));
        return idx.slice(0, k);
    }
    function resolve(rawIds) {
        const ids = [], bufs = [];
        for (const id of rawIds) {
            if (ids.length === NEED) break;
            if (!V.isCJKToken(id)) continue;
            const s = V.raw(id);
            let bad = false;
            for (const a of bufs) if (V.isPrefix(a, s) || V.isPrefix(s, a)) { bad = true; break; }
            if (bad) continue;
            ids.push(id); bufs.push(s);
        }
        return { ids, bufs };
    }

    const logits = I32.subarray(0, 4096);
    const raw = topK(logits, 256);
    const cand = resolve(raw);
    eq(cand.ids.length, 64, '④ 候选 64 名');

    // 用 6bit 单元编造一批 index，编码成字节流文本，再解回来
    let state = {};   // 这里不跑模型，固定用同一候选集，纯验证字节层闭环
    const units = [];
    let x = 12345;
    for (let i = 0; i < 256; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; units.push(x % 64); }

    // 编码：按 index 取候选字节，顺序拼接
    let encLen = 0;
    for (const u of units) encLen += cand.bufs[u].length;
    const text = new Uint8Array(encLen);
    let o = 0;
    for (const u of units) { text.set(cand.bufs[u], o); o += cand.bufs[u].length; }

    // 解码：字节级前缀匹配，唯一命中
    const outUnits = [];
    let pos = 0, ambiguous = 0, miss = 0;
    while (pos < text.length) {
        let hit = -1, hits = 0;
        for (let i = 0; i < cand.bufs.length; i++) {
            if (V.matchesAt(text, pos, cand.bufs[i])) { if (hit < 0) hit = i; hits++; }
        }
        if (hits === 0) { miss++; break; }
        if (hits > 1) ambiguous++;
        outUnits.push(hit);
        pos += cand.bufs[hit].length;
    }
    eq(miss, 0, '④ 解码无失配');
    eq(ambiguous, 0, '④ 解码无歧义（字节级 prefix-free 生效）');
    eq(outUnits.length, units.length, '④ 单元数一致');
    ok(outUnits.every((v, i) => v === units[i]), '④ 256 个 6bit 单元逐个还原正确');

    // 拼回字节流：应与原密文一致
    const w = [];
    let acc = 0, nb = 0;
    for (const u of outUnits) {
        acc = ((acc << 6) | u) >>> 0; nb += 6;
        while (nb >= 8) { nb -= 8; w.push((acc >>> nb) & 0xff); }
        acc &= nb ? (1 << nb) - 1 : 0;
    }
    eq(w.length, 192, '④ 256×6bit = 192 字节');

    // 输出文本必须是合法 UTF-8（整段拼接后）
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(text);
    ok(decoded.length > 0 && !decoded.includes('\ufffd'), '④ 整段拼接后为合法 UTF-8 且无替换字符',
        JSON.stringify(decoded.slice(0, 24)));
    console.log('  伪装文本样例（前 24 字）: ' + decoded.slice(0, 24));
    console.log('  文本字节 ' + text.length + ' B（256 token，均长 ' + (text.length / 256).toFixed(2) + ' B）');
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

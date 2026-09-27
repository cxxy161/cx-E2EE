/* ═══════════════════════════════════════════════════════════════════
 * 黑名单不变量验证
 * ═══════════════════════════════════════════════════════════════════
 *
 * 核心不变量（唯一准则）：
 *   编码端产出的任何 token，都不得含解码端会剥离的字符。
 *   解码端剥 /[\s\u200b-\u200d\ufeff]/g —— 黑名单必须精确覆盖它。
 *
 * 一旦违反：段体字节长度在 mergeSegments 前后不一致 →
 * 位流错位 → 必然 DESYNC（且是"编码成功、解码失败"的静默损坏）。
 *
 * 运行： node test/stego/blacklist.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVocabBytes } from './vocab-real.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fmt = JSON.parse(readFileSync(join(REPO, '.pcd/pcd-v3-6M-fixedpoint/model/format.json'), 'utf8'));
const V = loadVocabBytes(join(REPO, '.pcd/pcd-v3-6M-fixedpoint/model/vocab.bin'), fmt.vocab);

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('黑名单不变量验证\n');

const STRIP = /[\s\u200b-\u200d\ufeff]/g;
const fatal = new TextDecoder('utf-8', { fatal: true });

/* ── ① 核心不变量：放行的 token 里不得有可剥离字符 ── */
{
    const leaks = [];
    for (let i = 0; i < V.size; i++) {
        if (!V.isAllowed(i)) continue;
        let s;
        try { s = fatal.decode(V.raw(i)); } catch { continue; }
        if (STRIP.test(s)) { STRIP.lastIndex = 0; leaks.push([i, s]); }
        STRIP.lastIndex = 0;
    }
    eq(leaks.length, 0, '① 放行 token 中无一含可剥离字符',
        leaks.slice(0, 6).map(([i, s]) => `id${i}=${JSON.stringify(s)}`).join(' '));
    if (leaks.length) for (const [i, s] of leaks.slice(0, 8)) console.log(`     ★ id ${i} ${JSON.stringify(s)}`);
}

/* ── ② 空白类必须全灭（逐个字节编码验证） ── */
{
    const enc = new TextEncoder();
    const wsSamples = [' ', '\t', '\n', '\r', '\u00a0', '\u1680', '\u2000', '\u2007',
        '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\u200b', '\u200c',
        '\u200d', '\ufeff', '\u0000', '\u001f', '\u007f'];
    let missed = [];
    for (const ch of wsSamples) {
        const bytes = enc.encode(ch);
        if (!V.isBlacklistedBytes(bytes)) missed.push(JSON.stringify(ch));
    }
    eq(missed.length, 0, '② 全部空白/控制/零宽字符被黑名单拦截', missed.join(' '));
}

/* ── ③ U+FFFD 与特殊 token 必须全灭 ── */
{
    let fffdAllowed = 0;
    for (let i = 0; i < V.size; i++) {
        const t = V.raw(i);
        for (let k = 0; k + 2 < t.length; k++) {
            if (t[k] === 0xEF && t[k + 1] === 0xBF && t[k + 2] === 0xBD) {
                if (V.isAllowed(i)) fffdAllowed++;
                break;
            }
        }
    }
    eq(fffdAllowed, 0, '③ 456 个 U+FFFD token 全被拒');

    const special = [];
    for (let i = 0; i < V.size; i++) {
        let s; try { s = fatal.decode(V.raw(i)); } catch { continue; }
        if (/<\|/.test(s) && V.isAllowed(i)) special.push(s);
    }
    eq(special.length, 0, '③ 特殊控制 token（<|endoftext|> 等）被拒', special.join(' '));
}

/* ── ④ 标点与词组必须在（对比旧白名单的致命缺陷） ── */
{
    const PUNCT = '。，？！、；：“”（）《》…—·';
    const found = [];
    for (let i = 0; i < V.size; i++) {
        let s; try { s = fatal.decode(V.raw(i)); } catch { continue; }
        if (s.length <= 2 && [...s].every(c => PUNCT.includes(c)) && V.isAllowed(i)) found.push(s);
    }
    ok(found.length >= 20, '④ 常用中文标点全部放行（旧白名单为 0）', `${found.length} 个：${found.slice(0, 12).join('')}`);

    // 多字符词组
    let multi = 0;
    for (let i = 0; i < V.size; i++) {
        if (!V.isAllowed(i)) continue;
        let s; try { s = fatal.decode(V.raw(i)); } catch { continue; }
        if ([...s].length > 1) multi++;
    }
    ok(multi > 1700, '④ 多字符词组正常放行', `${multi} 个`);
}

/* ── ⑤ 统计合理性 ── */
{
    console.log(`\n  词表 ${V.size} · 放行 ${V.allowedCount} · 拒绝 ${V.rejectedCount}`);
    ok(V.allowedCount > 3400, '⑤ 放行数 > 3400', String(V.allowedCount));
    ok(V.rejectedCount < 700, '⑤ 拒绝数 < 700（旧白名单拒 651 个且全是好词）', String(V.rejectedCount));
}

/* ── ⑥ 端到端：剥离前后字节一致 ── */
{
    // 用真实候选拼一段文本，验证 STRIP 不改变它
    const ids = [];
    for (let i = 0; i < V.size && ids.length < 200; i++) if (V.isAllowed(i)) ids.push(i);
    const raw = V.concat(ids);
    const s = fatal.decode(raw);
    const after = s.replace(STRIP, '');
    eq(after, s, '⑥ 放行 token 拼成的文本经解码端剥离后不变');
    eq(Buffer.byteLength(after, 'utf8'), raw.length, '⑥ 剥离前后字节数一致');
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

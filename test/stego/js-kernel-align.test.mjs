/* ═══════════════════════════════════════════════════════════════════
 * JS 定点内核 · 第一层对齐（emb 层哈希比对）
 * ═══════════════════════════════════════════════════════════════════
 *
 * README §8 建议"按层比对，先确保 emb 一致"。这一步用 JS 复现 emb 层并
 * 与 golden 的 FNV-1a 64 哈希逐 bit 比对，用来证明：
 *   ① weights.bin 的 q_offset/m_offset 切片语义正确
 *   ② 逐行 M 反量化 + W_SHIFT 语义正确
 *   ③ rshiftRound 的**正确**实现（README 给的 JS 版是错的，见下）
 *   ④ FNV-1a 64 与"int32 小端字节流"哈希口径一致
 *
 * ⚠️ 本文件同时给出 README §3 那个 rshiftRound 的反例。
 *
 * 运行： node test/stego/js-kernel-align.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PCD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint');
const M = join(PCD, 'model');

const fmt = JSON.parse(readFileSync(join(M, 'format.json'), 'utf8'));
const W = readFileSync(join(M, 'weights.bin'));
const gj = JSON.parse(readFileSync(join(PCD, 'golden', 'golden.json'), 'utf8'));

const RES_FRAC = fmt.globals.RES_FRAC;   // 12
const W_SHIFT = fmt.globals.W_SHIFT;     // 20

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ═══════════════════════════════════════════════════════════════
 * 舍入：唯一正确的实现
 * ═══════════════════════════════════════════════════════════════
 * 算术右移 + 半值远离零。
 *
 * ⚠️ README §3 给出的 JS 版是 **错的**：
 *      return x >= 0 ? (x + b) >> s : -((-x + b) >> s);
 *    JS 的 `>>` 会先把操作数 ToInt32，本模型中间量最大 ≈2^45.7，
 *    一进 `>>` 就被截成低 32 位，结果完全错误（实测差 1.3e10 量级）。
 *
 * 正确做法：用 2 的幂做除法。本模型所有中间量 ≤ 2^45.7 < 2^53，
 * 而除以 2^s 只是指数减 s，在 IEEE754 下**精确无舍入**，
 * 故 Math.floor((x + b) / 2^s) 与 Python 整数语义逐 bit 一致。
 */
function rshiftRound(x, s) {
    if (s === 0) return x;
    const b = Math.pow(2, s - 1);
    return x >= 0
        ? Math.floor((x + b) / Math.pow(2, s))
        : -Math.floor((-x + b) / Math.pow(2, s));
}

/* FNV-1a 64，输入为 int32 小端字节流 */
function fnv1a64FromI32(i32arr) {
    const buf = new Uint8Array(i32arr.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < i32arr.length; i++) dv.setInt32(i * 4, i32arr[i], true);
    let h = 0xcbf29ce484222325n;
    const p = 0x100000001b3n, m = (1n << 64n) - 1n;
    for (let i = 0; i < buf.length; i++) { h ^= BigInt(buf[i]); h = (h * p) & m; }
    return h;
}

/* 取张量 q / m */
function tensor(name) {
    const t = fmt.tensors.find(x => x.name === name);
    if (!t) throw new Error('no tensor ' + name);
    const [out, inn] = t.shape;
    const q = new Int8Array(W.buffer, W.byteOffset + t.q_offset, t.q_bytes);
    const mArr = new Int32Array(t.m_count);
    for (let i = 0; i < t.m_count; i++) mArr[i] = W.readInt32LE(t.m_offset + i * 4);
    return { q, m: mArr, out, inn };
}

console.log('JS 定点内核 · emb 层对齐\n');

/* ═══ ① rshiftRound 反例（README §3 的 JS 版） ═══ */
{
    const README = (x, s) => { if (s === 0) return x; const b = 1 << (s - 1); return x >= 0 ? (x + b) >> s : -((-x + b) >> s); };
    // 实测本模型出现的量级（rmsnorm num 最大 ≈5.5e13）
    const cases = [[55574230881045, 28], [29899084762035, 30], [67274188032, 16]];
    let diffs = 0;
    for (const [x, s] of cases) if (README(x, s) !== rshiftRound(x, s)) diffs++;
    eq(diffs, cases.length, '① README §3 的 JS rshiftRound 在大中间量上全部错误（反例成立）');
    console.log(`  README 版 rshiftRound(55574230881045, 28) = ${README(55574230881045, 28)}`);
    console.log(`  正确版   rshiftRound(55574230881045, 28) = ${rshiftRound(55574230881045, 28)}`);
    // 小量级下两者一致（所以只在小张量上测不出来）
    eq(README(36107, 4), rshiftRound(36107, 4), '① 小量级下两版一致（故该 bug 极易漏过）');

    // README §2 的 int64 拆分写法同样因 `<<` 而错
    const acc = 12387072, Mv = 5431;
    const readmeSplit = ((acc >>> 16) * Mv << 16) + (acc & 0xFFFF) * Mv;
    const plain = acc * Mv;
    ok(readmeSplit !== plain, '① README §2 的 (hi<<16)+lo 写法错误（反例成立）');
    ok(Number.isSafeInteger(plain), '① 直接 acc*M 在 double 下精确（无需拆分）',
        `acc*M=${plain} < 2^53=${Number.MAX_SAFE_INTEGER}`);
}

/* ═══ ② emb 层复现 ═══ */
{
    const te = tensor('tok_emb');
    const shift = W_SHIFT - RES_FRAC;   // 20-12 = 8

    for (let gi = 0; gi < gj.n_groups; gi++) {
        const grp = gj.groups[gi];
        const ids = grp.prompt_ids;
        const T = ids.length, d = te.inn;

        // x[t][k] = rshift_round(q[id][k] * M[id], W_SHIFT - RES_FRAC)
        const x = new Array(T * d);
        for (let t = 0; t < T; t++) {
            const id = ids[t];
            const m = te.m[id];
            const base = id * d;
            for (let k = 0; k < d; k++) {
                x[t * d + k] = rshiftRound(te.q[base + k] * m, shift);
            }
        }

        const h = fnv1a64FromI32(x);
        const expectJson = grp.layer_hashes.emb;
        // golden.json 里的哈希是 Python int，超过 2^53 后经 JSON 已变成最近 double；
        // 两边都做"最近 double"舍入后应完全相等
        const match = Number(h) === expectJson;
        ok(match, `② ${grp.id} emb 层哈希一致`,
            match ? '' : `got ${h.toString(16)} (${Number(h)}) want ${expectJson}`);
        console.log(`  ${grp.id.padEnd(14)} emb ${match ? '✓' : '★'}  ${h.toString(16).padStart(16, '0')}  T=${T} d=${d}`);
        if (gi === 0) {
            console.log(`     x[0][0..3] = ${x.slice(0, 4).join(', ')}`);
        }
    }
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

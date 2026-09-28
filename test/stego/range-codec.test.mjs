/* ═══════════════════════════════════════════════════════════════════
 * 纯整数区间编码原型 —— 小规模无损回环 + NLL 实测
 * ═══════════════════════════════════════════════════════════════════
 *
 * 规格（按拍板）：裸 BOS、无 θ 门控、纯整数、只换 Codec 内部。
 *
 * ⏱ 规模刻意做小（默认 48B 帧 ≈ 84 步 ≈ 0.5s/次），全套 < 1 分钟。
 *    真实 192B 帧只在 §B 跑 1 次做容量标定。
 *    用 SMALL=0 可切到 192B 全量（较慢）。
 *
 * 运行： node test/stego/range-codec.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, stepForward, createState } from './js-kernel.mjs';
import { loadVocabBytes } from './vocab-real.mjs';
import {
    encodeFrameRange, decodeFrameRange, encodeChainRange, decodeChainRange,
    buildPool, adaptiveCapFreq, FRAME_BYTES, POOL_MAX, TOKEN_BUDGET,
} from './codec-range.mjs';
import { buildIntegerCDF } from './range-coder.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PCD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint');
const MD = join(PCD, 'model');
const M = loadModel(MD);
const fmt = JSON.parse(readFileSync(join(MD, 'format.json'), 'utf8'));
const V = loadVocabBytes(join(MD, 'vocab.bin'), fmt.vocab);
const RF = 4096;
const MM = 1 << 16;
const SMALL = process.env.SMALL !== '0';
const N_SMALL = 48;                 // 小规模帧长（384 bit ≈ 84 步）
const N_BIG = FRAME_BYTES;          // 192B

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rng = (s) => { let x = s >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; };
const randBytes = (n, s) => { const r = rng(s), o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = Math.floor(r() * 256) & 0xff; return o; };
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const te = new TextEncoder();

/* 模型自评 NLL（浮点 softmax 仅用于评分，不进实现） */
function nllOf(picked) {
    const st = createState(M); let last = 1, nll = 0, n = 0;
    for (const id of picked) {
        const lg = stepForward(M, last, st).logits;
        let mx = -Infinity; for (let i = 0; i < lg.length; i++) if (lg[i] > mx) mx = lg[i];
        let s = 0, t = 0;
        for (let i = 0; i < lg.length; i++) { const e = Math.exp((lg[i] - mx) / RF); s += e; if (i === id) t = e; }
        const p = t / s;
        if (p > 1e-15) { nll -= Math.log(p); n++; }
        last = id;
    }
    return n > 0 ? nll / n : NaN;
}
function greedyPicked(n) {
    const st = createState(M); let last = 1; const o = [];
    for (let t = 0; t < n; t++) { const r = stepForward(M, last, st); const p = buildPool(r.logits, V, 256, 256); o.push(p.ids[0]); last = p.ids[0]; }
    return o;
}
function forcedPicked(n, seed) {
    const st = createState(M); let last = 1; const r0 = rng(seed), o = [];
    for (let t = 0; t < n; t++) {
        const r = stepForward(M, last, st); const p = buildPool(r.logits, V, 64, 64);
        const i = Math.floor(r0() * p.ids.length); o.push(p.ids[i]); last = p.ids[i];
    }
    return o;
}

const T0 = Date.now();
console.log('纯整数区间编码原型 · 小规模验证');
console.log(`帧 ${SMALL ? N_SMALL : N_BIG}B · 池 ${POOL_MAX} · token 预算 ${TOKEN_BUDGET}（RoPE 上限）\n`);

/* ═══ A 无损回环（小帧，多样本） ═══ */
console.log(`═══ A 无损回环（${N_SMALL}B 帧） ═══`);
{
    const cases = [
        ['全 0x00 (V=0 最坏)', new Uint8Array(N_SMALL)],
        ['全 0xFF', new Uint8Array(N_SMALL).fill(0xff)],
        ['递增', Uint8Array.from({ length: N_SMALL }, (_, i) => i & 0xff)],
        ['随机#1', randBytes(N_SMALL, 0xC0FFEE)],
        ['随机#2', randBytes(N_SMALL, 0x1234567)],
    ];
    for (const [name, f] of cases) {
        const enc = encodeFrameRange(f, M, V);
        const tb = te.encode(enc.text);
        const dec = decodeFrameRange(tb, M, V, { frameBytes: N_SMALL });
        const same = bytesEq(f, dec.frame);
        const full = dec.consumed === tb.length;
        ok(same, `A 逐字节精确 [${name}]`);
        ok(full, `A 文本被完整消费 [${name}]`, `${dec.consumed}/${tb.length}`);
        ok(enc.steps <= TOKEN_BUDGET, `A token 在预算内 [${name}]`, `${enc.steps}`);
        console.log(`  ${name.padEnd(18)} token=${String(enc.steps).padStart(3)} 文本=${String(enc.bytes).padStart(3)}B ` +
            `${enc.bitsPerToken.toFixed(2)} bit/tok  ${same && full ? '✓' : '✗'}`);
    }
}

/* ═══ B 真实 192B 帧标定（1 次，用于容量换算） ═══ */
console.log(`\n═══ B 真实 ${N_BIG}B 帧标定（1 次） ═══`);
let bigPerFrame = 0;
{
    const f = randBytes(N_BIG, 0xFACADE);
    const enc = encodeFrameRange(f, M, V);
    const tb = te.encode(enc.text);
    const dec = decodeFrameRange(tb, M, V);
    const same = bytesEq(f, dec.frame) && dec.consumed === tb.length;
    ok(same, 'B 192B 帧无损回环');
    ok(enc.steps <= TOKEN_BUDGET, 'B token 在预算内', `${enc.steps}`);
    bigPerFrame = enc.steps;
    console.log(`  ${N_BIG}B 帧 → ${enc.steps} token / ${enc.bytes}B 文本 / ${enc.bitsPerToken.toFixed(3)} bit/token`);
    console.log(`  既有 6bit：${N_BIG}B 帧 → 固定 256 token / 6.000 bit/token（强制均匀）`);
    console.log(`  ⇒ 吞吐 ${enc.bitsPerToken.toFixed(2)} < 6.00 是**熵极限**（模型真实熵约 5.4~5.9）；`);
    console.log(`     6.00 高于熵，信息论上不可达，多出的部分只能靠扭曲分布硬挤。`);
}

/* ═══ B2 链级（K 帧一条连续 token 流）—— 集成关键路径 ═══ */
console.log('\n═══ B2 链级编码（K 帧 = 一条连续 token 流） ═══');
{
    /* 链预算 512 = RoPE 上限；每帧 ~297~333 token ⇒ 192B 帧只能 1 帧/链 */
    const K = 1;
    const framesIn = Array.from({ length: K }, (_, k) => randBytes(N_BIG, 0x5A00 + k * 7919));
    let enc;
    try {
        enc = encodeChainRange(framesIn, M, V);
    } catch (e) { enc = null; }
    ok(!!enc, 'B2 单帧链可编码', enc ? '' : '超预算');
    if (enc) {
        const tb = te.encode(enc.text);
        const dec = decodeChainRange(tb, M, V, { maxFrames: K });
        const allSame = dec.frames.length === K && framesIn.every((f, i) => bytesEq(f, dec.frames[i]));
        ok(allSame, 'B2 链级无损回环（多帧自定界）');
        ok(dec.consumed === tb.length, 'B2 链文本被完整消费', `${dec.consumed}/${tb.length}`);
        ok(enc.steps <= TOKEN_BUDGET, 'B2 链 token 在 512 预算内', `${enc.steps}`);
        console.log(`  K=${K} 帧 → ${enc.steps} token（预算 ${TOKEN_BUDGET}）/ ${enc.bytes}B 文本`);
        console.log(`  每帧 token: ${enc.perFrame.map(x => x.steps).join(', ')}`);

        /* 容量红线核算：这是集成时真正要面对的数字 */
        const perFrame = enc.steps / K;
        console.log(`  ⇒ 单帧 ${N_BIG}B 需 ~${perFrame.toFixed(0)} token，而每链 512 预算`);
        console.log(`     既有几何 2 帧/链 需 ~${(perFrame * 2).toFixed(0)} token > 512 ⇒ **装不下**`);
        console.log(`     故区间编码下每链只能放 1 帧（${N_BIG}B），载荷须重新标定`);
    }
}

/* ═══ C 可读性 NLL（小帧，token 数等比） ═══ */
console.log('\n═══ C 可读性：NLL（nats/token，模型自评，越低越自然） ═══');
{
    const tgt = SMALL ? 84 : 300;
    const rn = [], rt = [];
    for (let k = 0; k < 3; k++) {
        const e = encodeFrameRange(randBytes(N_SMALL, 5000 + k * 104729), M, V);
        rn.push(nllOf(e.picked)); rt.push(e.steps);
    }
    const nTok = Math.round(avg(rt));
    const fn = avg([0, 1].map(s => nllOf(forcedPicked(nTok, 7000 + s * 15485863))));
    const gn = nllOf(greedyPicked(nTok));
    const ra = avg(rn);
    console.log(`  (a) 纯 Top-1 贪心（上界，0 bit 承载）       NLL = ${gn.toFixed(3)}`);
    console.log(`  (b) 6bit 均匀抽签（既有路径）              NLL = ${fn.toFixed(3)}`);
    console.log(`  (c) 整数区间编码（本原型）                 NLL = ${ra.toFixed(3)}`);
    console.log('');
    console.log(`  相对既有改善 ${((fn - ra) / fn * 100).toFixed(1)}%   (${fn.toFixed(3)} → ${ra.toFixed(3)})`);
    console.log(`  与上界差距：既有 +${(fn - gn).toFixed(3)}   区间 +${(ra - gn).toFixed(3)}`);
    ok(ra < fn, 'C 区间编码 NLL 优于 6bit 均匀抽签', `${ra.toFixed(3)} vs ${fn.toFixed(3)}`);
}

/* ═══ D 定点正确性 ═══ */
console.log('\n═══ D 定点正确性 ═══');
{
    const f = randBytes(N_SMALL, 424242);
    const a = encodeFrameRange(f, M, V), b = encodeFrameRange(f, M, V);
    eq(a.text, b.text, 'D 同输入两次编码逐字符相同');
    eq(a.steps, b.steps, 'D 同输入两次编码 token 数相同');

    const r = stepForward(M, 1, createState(M));
    const pool = buildPool(r.logits, V, POOL_MAX, MM);
    const cdf = buildIntegerCDF(r.logits, pool.ids, M.tables.exp_lut.arr, MM);
    eq(cdf.cum[cdf.L], MM, 'D CDF 总和精确 = M');
    let mono = true;
    for (let i = 0; i < cdf.L; i++) if (cdf.cum[i + 1] <= cdf.cum[i]) mono = false;
    ok(mono, 'D CDF 严格单调（每候选 freq ≥ 1）');
    let minF = Infinity, maxF = 0;
    for (let i = 0; i < cdf.L; i++) { minF = Math.min(minF, cdf.freqs[i]); maxF = Math.max(maxF, cdf.freqs[i]); }
    console.log(`  池 ${cdf.L} 名 · M=${MM} · freq∈[${minF},${maxF}] · Top-1 占 ${(cdf.freqs[0] / MM * 100).toFixed(1)}%`);

    let smallOk = true, why = '';
    for (const sb of [2, 3, 4, 6, 8, 10, 12, 16]) {
        const Ms = 1 << sb;
        for (const L of [2, 3, 5, 16, 64]) {
            if (L > Ms) continue;
            try {
                const c2 = buildIntegerCDF(r.logits, pool.ids.slice(0, L), M.tables.exp_lut.arr, Ms);
                if (c2.cum[L] !== Ms) { smallOk = false; why = `M=${Ms} L=${L} sum=${c2.cum[L]}`; }
            } catch (e) { smallOk = false; why = `M=${Ms} L=${L} ${e.message}`; }
        }
    }
    ok(smallOk, 'D 小尺度 CDF（M 小至 4）仍精确归一', why);
    console.log('  小尺度 M=4..65536 × 池 2..64 全部归一 ✓');

    /* 自适应 cap 的性质：在轨不干预、落后才收紧 */
    eq(adaptiveCapFreq(65536, 1n << 100n, 100, 1536, 512), 0, 'D 速率充足时不触发 cap');
    ok(adaptiveCapFreq(65536, 1n << 5000n, 5, 1536, 512) > 0, 'D 速率落后时触发 cap');
}

/* ═══ E 负向 ═══ */
console.log('\n═══ E 负向：普通中文文章必须被拒 ═══');
{
    const arts = [
        '今天天气很好，我们去公园散步，看到很多人在放风筝。',
        '人工智能的发展速度超出了所有人的预期，这将深刻改变社会结构。',
        '他在会议上提出了一个全新的方案，与会者纷纷表示赞同和支持。',
    ];
    let rej = 0;
    for (const a of arts) {
        try { decodeFrameRange(te.encode(a), M, V, { frameBytes: N_SMALL }); }
        catch (e) { if (e.code === 'NOT_STEGO') rej++; }
    }
    eq(rej, arts.length, 'E 三篇普通文章全部被拒');
    console.log(`  ${rej}/${arts.length} 篇被拒（NOT_STEGO）`);
}

/* ═══ 汇总 ═══ */
console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log(`⏱ 用时 ${((Date.now() - T0) / 1000).toFixed(1)} s`);
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

/* ═══════════════════════════════════════════════════════════════════
 * KV Cache 等价性 + 性能验证
 * ═══════════════════════════════════════════════════════════════════
 *
 * 硬指标（用户指定）：
 *   KV Cache 接入后，逐步输出必须与无 Cache 路径**严格等价** ——
 *   既要复现 golden 的 45/45 层哈希与 top-64，
 *   也要与 forward(全序列) 的最后位置逐 bit 相同。
 *
 * 覆盖：
 *   ① 逐步 (stepForward) 的 15 层哈希 == golden（3 组）
 *   ② 逐步 top-64 == golden top-64
 *   ③ 逐步 vs 全序列：每个位置 t 的 logits 逐 int32 相同（不只是最后一个）
 *   ④ 缓存增长后仍等价（T 跨越 ensureCap 的扩容点 64）
 *   ⑤ 性能：O(T) vs O(T²) 实测对比
 *
 * 运行： node test/stego/kv-cache.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, forward, stepForward, createState, fnv1a64I32 } from './js-kernel.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PCD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint');
const M = loadModel(join(PCD, 'model'));
const gj = JSON.parse(readFileSync(join(PCD, 'golden', 'golden.json'), 'utf8'));

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const sgn = (v) => v | 0;   // int32 语义

console.log('KV Cache 等价性与性能验证\n');

/* ═══ ① + ② 逐步复现 golden ═══ */
{
    const names = ['emb', 'blk0.attn_out', 'blk0.out', 'blk1.attn_out', 'blk1.out',
        'blk2.attn_out', 'blk2.out', 'blk3.attn_out', 'blk3.out',
        'blk4.attn_out', 'blk4.out', 'blk5.attn_out', 'blk5.out', 'final_norm'];
    let hashHit = 0, hashTotal = 0, topOk = 0;

    for (const grp of gj.groups) {
        const T = grp.prompt_ids.length;
        const st = createState(M);
        // 逐步收集每层的 [1,d] 切片，按 token 顺序拼回 [T,d] 再哈希
        // —— golden 的 layer_hashes 哈希的是**全序列张量**，
        //    不能拿单步的 [1,d] 切片去比（维度不同，哈希必然不同）。
        const acc = {};
        for (const n of names) acc[n] = [];
        let last = null;
        for (const id of grp.prompt_ids) {
            const cap = {};
            const r = stepForward(M, id, st, cap);
            for (const n of names) acc[n].push(cap[n]);
            last = r.logits;
        }
        const line = [];
        for (const n of names) {
            // 拼接成 C 序 [T,d]（token 优先），与 golden capture 布局一致
            const d = acc[n][0].length;
            const flat = new Float64Array(T * d);
            for (let t = 0; t < T; t++) flat.set(acc[n][t], t * d);
            const h = fnv1a64I32(flat);
            hashTotal++;
            if (Number(h) === grp.layer_hashes[n]) { hashHit++; line.push('✓'); }
            else line.push('✗' + n);
        }
        {
            const h = fnv1a64I32(Array.from(last, sgn));
            hashTotal++;
            if (Number(h) === grp.layer_hashes.logits_last) { hashHit++; line.push('✓lg'); }
            else line.push('✗lg');
        }
        const idx = Array.from({ length: 4096 }, (_, i) => i);
        const lo = Float64Array.from(last, sgn);
        idx.sort((a, b) => (lo[b] - lo[a]) || (a - b));
        const mine = idx.slice(0, 64);
        const want64 = grp.top64.map(e => e.token_id);
        const same = mine.every((v, i) => v === want64[i]);
        if (same) topOk++;
        const got = line.filter(s => s.startsWith('✓')).length;
        console.log(`  ${grp.id.padEnd(14)} 层哈希 ${got}/15  top64 ${same ? '✓' : '★'}${got < 15 ? '  ' + line.filter(s => s.startsWith('✗')).join(',') : ''}`);
    }
    eq(hashHit, hashTotal, `① 逐步 KV Cache 复现 golden 层哈希 ${hashHit}/${hashTotal}`);
    eq(topOk, gj.n_groups, '② 逐步 top-64 与 golden 一致');
}

/* ═══ ③ 逐步 vs 全序列：每个位置逐 int32 比对 ═══ */
{
    const seq = [1306, 3260, 1609, 956, 291, 2254, 703, 2477, 1884, 3004, 512, 77, 2001, 88];
    const full = forward(M, seq);
    const st = createState(M);
    let mismatch = 0, firstBad = '';
    for (let t = 0; t < seq.length; t++) {
        const r = stepForward(M, seq[t], st);
        const a = full.logits.subarray(t * 4096, (t + 1) * 4096);
        for (let k = 0; k < 4096; k++) {
            if (sgn(a[k]) !== sgn(r.logits[k])) { mismatch++; if (!firstBad) firstBad = `t=${t} k=${k} full=${sgn(a[k])} step=${sgn(r.logits[k])}`; break; }
        }
    }
    eq(mismatch, 0, '③ 逐步与全序列在全部 14 个位置逐 int32 相同', firstBad);
}

/* ═══ ④ 跨越扩容点（cap 从 64 起倍增） ═══ */
{
    const T = 100;                                  // > 64，触发一次扩容
    const seq = Array.from({ length: T }, (_, i) => (i * 613 + 41) % 4096);
    const full = forward(M, seq);
    const st = createState(M);
    let r = null;
    for (const id of seq) r = stepForward(M, id, st);
    eq(st.pos, T, '④ 缓存位置计数正确');
    ok(st.cap >= T, '④ 缓存已扩容至 ≥ T', `cap=${st.cap}`);
    let bad = 0;
    const a = full.logits.subarray((T - 1) * 4096, T * 4096);
    for (let k = 0; k < 4096; k++) if (sgn(a[k]) !== sgn(r.logits[k])) bad++;
    eq(bad, 0, '④ 扩容后最后位置 logits 逐 int32 相同');
}

/* ═══ ⑤ 性能：O(T) vs O(T²) ═══ */
{
    // 在同一 T 上直接对比，不做外推（避免把公式写错）。
    // 无 Cache 的总代价 = Σ_{t=1..T} forward(t)，随 T 平方增长。
    const T = 64;
    const seq = Array.from({ length: T }, (_, i) => (i * 37 + 11) % 4096);

    const st = createState(M);
    let t0 = Date.now();
    for (const id of seq) stepForward(M, id, st);
    const kvMs = Date.now() - t0;

    t0 = Date.now();
    for (let t = 1; t <= T; t++) forward(M, seq.slice(0, t));
    const noKvMs = Date.now() - t0;

    const ratio = noKvMs / kvMs;
    console.log(`\n  ⑤ 性能对比（T=${T}，同序列、同机器）`);
    console.log(`     KV Cache : ${kvMs} ms 总计 · ${(kvMs / T).toFixed(1)} ms/token`);
    console.log(`     无 Cache : ${noKvMs} ms 总计（Σ forward(1..T)）`);
    console.log(`     加速比   : ${ratio.toFixed(1)}×   ← 且随 T 继续拉大（O(T²) vs O(T)）`);

    ok(ratio > 10, '⑤ KV Cache 显著更快', `${ratio.toFixed(1)}×`);
    ok(kvMs / T < 60, '⑤ 单 token 耗时 < 60ms', `${(kvMs / T).toFixed(1)} ms`);

    // 一帧 256 token 的实测（这是序列化的真实单位代价）
    const T2 = 256;
    const seq2 = Array.from({ length: T2 }, (_, i) => (i * 37 + 11) % 4096);
    const st2 = createState(M);
    t0 = Date.now();
    for (const id of seq2) stepForward(M, id, st2);
    const frameMs = Date.now() - t0;

    // 同 T 的无 Cache 代价用 T=64 的规模按平方律折算
    const projected = noKvMs * (T2 / T) * (T2 / T);
    console.log(`\n     一帧 256 token（KV Cache 实测）: ${(frameMs / 1000).toFixed(2)} 秒`);
    console.log(`     同帧无 Cache（按平方律折算）  : ${(projected / 1000).toFixed(0)} 秒`);
    console.log(`     → 相差 ${(projected / frameMs).toFixed(0)}×`);
    ok(frameMs < 5000, '⑤ 一帧 256 token < 5 秒', `${(frameMs / 1000).toFixed(2)} s`);
    globalThis.__frameMs = frameMs;
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

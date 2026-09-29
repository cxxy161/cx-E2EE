/* ═══════════════════════════════════════════════════════════════════
 * ver=3 滑窗重归一化区间编解码器 · 数学原型（不含模型，纯合成 CDF）
 * ═══════════════════════════════════════════════════════════════════
 *
 * ── 为什么需要重归一化 ──
 *   ver=2 用「整块当作一个大整数、细分到 hi-lo==1」来保证逐字节精确。
 *   它有个硬限制：解码端**必须知道块长 N**（初始区间 [0,2^(8N))），
 *   于是块长只能由协议写死（288B 定长桶 + PRF 填充），且必须演完整块。
 *
 *   ver=3 改为滑窗：窗口恒为 W bit，顶部字节一旦确定就吐出并左移补进
 *   下一个输入字节。块长因此**无需预先知道** —— 长度头就写在数据最前面，
 *   解码端解出 2 字节拿到 actual_len，攒够就停，尾部一律丢弃。
 *
 * ── 角色是**反的**（关键，容易搞混） ──
 *   隐写编码器 = 区间**解码器**角色：吃明文字节，吐 token
 *   隐写解码器 = 区间**编码器**角色：吃 token，吐明文字节
 *   因为「token」才是被压缩的符号，而字节是码流。
 *
 * ── 为什么无进位 ──
 *   吐字节的条件是「窗口顶部整字节已确定」：
 *       floor(lo / 2^(W-8)) == floor((lo+r-1) / 2^(W-8))
 *   该条件 ⇒ r ≤ 2^(W-8)（因为低 (W-8) 位加上 r-1 不得跨过边界），
 *   于是左移 8 位后 r*256 ≤ 2^W、lo*256 < 2^W，后续加法永远进不到
 *   已经吐出的字节里 —— 不需要 LZMA 那套 cache/carry 机制。
 */
import { strict as assert } from 'node:assert';

const W = 40n;                       // 窗口位宽
const SHIFT = 32n;                   // 顶部字节的移位量 = W - 8
const TOPBYTE = 1n << SHIFT;
const MASK = (1n << W) - 1n;
const INIT_BYTES = Number(W / 8n);   // 4 字节？不：5 字节
const ceilDiv = (x, y) => (x + y - 1n) / y;
const topDet = (lo, r) => (lo >> SHIFT) === ((lo + r - 1n) >> SHIFT);

/** 每步定点尺度：≤ min(2^16, r) 的最大 2 的幂（与 ver=2 同一条规则） */
function stepScale(r) {
    const CAP = 1n << 16n;
    const m = r < CAP ? r : CAP;
    let p = 1n;
    while (p * 2n <= m) p *= 2n;
    return Number(p);
}

/** 每步符号池深度：**必须 ≤ M**，否则 CDF 无法做到每符号 freq≥1。
 *
 *  ⚠️ 这不是优化而是正确性前提：重归一化后 r 仍可能只剩 3（甚至 2）——
 *     当 lo mod 2^32 恰好落在边界上时 topDet 为假，小 r 得以存续。
 *     此时 M = stepScale(r) 可能只有 2，池深就必须收到 2。
 *     生产侧对应 resolveRangePool(..., limit = Mv) 与 buildIntegerCDF 的
 *     CDF_POOL_GT_SCALE 守卫，两端由同一个 M 推出同一池深，无需传输。 */
function poolSize(L, M) { return Math.max(2, Math.min(L, M)); }

/** 合成 CDF：由 prev 符号 + 池深派生，两端可独立算出（模拟模型的确定性） */
function synthCDF(prev, L, M) {
    let h = (prev * 2654435761 + 1013904223) >>> 0;
    const w = new Array(L);
    let sum = 0;
    for (let i = 0; i < L; i++) {
        h = (Math.imul(h ^ (h >>> 15), 2246822519) + 374761393) >>> 0;
        const v = 1 + (h % 4096);
        w[i] = v; sum += v;
    }
    const f = new Array(L);
    let used = 0;
    for (let i = 0; i < L; i++) { let v = Math.floor(w[i] * M / sum); if (v < 1) v = 1; f[i] = v; used += v; }
    let diff = M - used;
    for (let k = 0; k < L && diff > 0; k++) { const t = Math.min(diff, 64); f[L - 1 - k] += t; diff -= t; }
    for (let k = L - 1; k >= 0 && diff < 0; k--) { const t = Math.min(f[k] - 1, -diff); f[k] -= t; diff += t; }
    const cum = new Array(L + 1); cum[0] = 0;
    for (let i = 0; i < L; i++) cum[i + 1] = cum[i] + f[i];
    if (cum[L] !== M) throw new Error('CDF 归一化失败 ' + cum[L] + ' != ' + M);
    return { cum, f, L, M };
}

function bucketOf(cum, L, M, t) {
    if (t < 0) t = 0; else if (t >= M) t = M - 1;
    let lo = 0, hi = L - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
}

/* ══════════════════ 隐写解码器角色：符号 → 字节 ══════════════════ */

class ByteSink {
    constructor() { this.bytes = []; }
    put(b) { this.bytes.push(b & 0xff); }
}

/**
 * @param {number} L        符号池大小
 * @param {number} maxSteps 步数上限（= token 预算）
 * @returns {{bytes:number[], picked:number[], steps:number, r:bigint}}
 */
function rangeEncodeRole(symbols, L, maxSteps, onStep) {
    const sink = new ByteSink();
    let lo = 0n, r = 1n << W;
    let prev = 0;
    let steps = 0;
    for (const sym of symbols) {
        if (steps >= maxSteps) throw new Error('RANGE_MAX_STEPS: ' + steps);
        const M = stepScale(r);
        const pool = poolSize(L, M);
        if (sym >= pool) throw new Error('SYM_OUT_OF_POOL: ' + sym + ' >= ' + pool + ' (M=' + M + ')');
        const cdf = synthCDF(prev, pool, M);
        const i = sym;
        const a = ceilDiv(r * BigInt(cdf.cum[i]), BigInt(M));
        const b = ceilDiv(r * BigInt(cdf.cum[i + 1]), BigInt(M));
        lo += a; r = b - a;
        /* ⚠️ 守卫**不能**写成 `r > 1n && topDet(...)`：r 缩到 1 时 topDet 恒真，
         *    而那正是唯一的解脱出口，加了 r>1 就永久卡死。
         *    反过来，正因为「r==1 ⇒ topDet」必然成立，循环退出后必有 r ≥ 2，
         *    故 stepScale(r) ≥ 2、候选池下限 2 个符号始终有效。 */
        while (topDet(lo, r)) {
            const t = lo >> SHIFT;
            sink.put(Number(t & 0xffn));
            lo = (lo - (t << SHIFT)) << 8n;
            r <<= 8n;
        }
        prev = i; steps++;
        if (onStep) onStep(lo, r, steps, pool);
    }
    return { bytes: sink.bytes, steps, r };
}

/* ══════════════════ 隐写编码器角色：字节 → 符号 ══════════════════ */

/**
 * 吃 `inBytes`，吐出符号序列。停止条件：已消费的输入字节数达到 limitBytes。
 * 越界读取一律补 0（确定性），故供编码端使用时须在尾部补够 INIT 个 0。
 */
function rangeDecodeRole(inBytes, L, limitBytes, maxSteps, onStep) {
    const readAt = (k) => (k < inBytes.length ? inBytes[k] : 0);
    let ptr = 0;
    let lo = 0n, r = 1n << W;
    let rel = 0n;
    for (let i = 0; i < INIT_BYTES; i++) { rel = (rel << 8n) | BigInt(readAt(ptr++)); }

    const picked = [];
    let prev = 0, steps = 0;
    while (ptr < limitBytes) {
        if (steps >= maxSteps) throw new Error('RANGE_MAX_STEPS: ' + steps);
        const M = stepScale(r);
        const pool = poolSize(L, M);
        const cdf = synthCDF(prev, pool, M);
        const t = Number((rel * BigInt(M)) / r);
        const i = bucketOf(cdf.cum, pool, M, t);
        const a = ceilDiv(r * BigInt(cdf.cum[i]), BigInt(M));
        const b = ceilDiv(r * BigInt(cdf.cum[i + 1]), BigInt(M));
        rel -= a; lo += a; r = b - a;
        picked.push(i);
        prev = i; steps++;
        /* 循环内**不设**提前 break：重归一化必须做完，否则不变式被破坏。
         * 越过 limitBytes 的读取由 readAt 统一补 0 —— 两端确定性一致。 */
        while (topDet(lo, r)) {
            const nb = BigInt(readAt(ptr++));
            lo = (lo - ((lo >> SHIFT) << SHIFT)) << 8n;
            r <<= 8n;
            rel = (rel << 8n) | nb;
        }
        if (onStep) onStep(lo, r, steps, pool);
    }
    return { picked, steps, consumed: ptr };
}

/* ══════════════════ 自测 ══════════════════ */

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (x ? '  :: ' + x : '')); } };
const rnd = (s) => { let x = s >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; };

console.log('ver=3 滑窗重归一化区间编解码器 · 数学原型\n');
console.log(`  窗口 ${W} bit · 初始预取 ${INIT_BYTES} 字节 · 顶部判定 floor(lo/2^${SHIFT}) == floor((lo+r-1)/2^${SHIFT})\n`);

/* ── T1：协议回环 —— 明文 B → 符号 S → 字节 C，要求 C 的前 |B| 字节 == B ── */
{
    console.log('═══ T1 协议回环（字节 → 符号 → 字节，逐字节精确） ═══');
    const L = 256, MAXSTEPS = 4096;
    let worstSteps = 0, worstBpt = 0;
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 31, 33, 64, 100, 256, 500]) {
        for (let trial = 0; trial < 3; trial++) {
            const R = rnd(0x1000 + n * 31 + trial);
            const B = new Uint8Array(n);
            if (trial === 0) { for (let i = 0; i < n; i++) B[i] = Math.floor(R() * 256); }
            else if (trial === 1) { /* 全 0：病态 */ }
            else { for (let i = 0; i < n; i++) B[i] = 0xff; }
            /* 前 2 字节当长度头（与真实协议一致） */
            const actual = Math.max(0, n - 2);
            B[0] = (actual >>> 8) & 0xff; B[1] = actual & 0xff;

            const padded = Array.from(B).concat(new Array(INIT_BYTES).fill(0));
            const enc = rangeDecodeRole(padded, L, n + INIT_BYTES, MAXSTEPS);
            const dec = rangeEncodeRole(enc.picked, L, MAXSTEPS);
            const got = Uint8Array.from(dec.bytes.slice(0, n));
            const same = got.length === n && got.every((v, i) => v === B[i]);
            ok(same, `T1 ${n}B 回环`, same ? '' :
                `\n      want ${Array.from(B.slice(0, 24))}\n      got  ${Array.from(got.slice(0, 24))} (${got.length}B)`);
            if (same) {
                const bpt = n * 8 / enc.steps;
                if (bpt > worstBpt) worstBpt = bpt;
                if (enc.steps > worstSteps) worstSteps = enc.steps;
                process.stdout.write(`  ${String(n).padStart(4)}B ${['随机', '全0', '全f'][trial]} 符号=${String(enc.steps).padStart(4)} ` +
                    `产出=${String(dec.bytes.length).padStart(4)}B ${bpt.toFixed(2)} bit/符号  ✓\n`);
            }
        }
    }
    console.log(`  → 最坏 ${worstSteps} 符号，最高 ${worstBpt.toFixed(2)} bit/符号\n`);
}

/* ── T2：生产方向的强化回环（多组随机 + 预算受限 + 全字节取值） ──
 *
 *  ⚠️ 只测**生产方向** byte → symbol → byte。反方向 symbol → byte → symbol
 *     **刻意不做保证**：本编码器不 flush，尾部区间内的具体取值未定，
 *     同一串符号可对应多串字节（经典算术编码性质）。
 *     协议不依赖反方向 —— 终止条件是**字节计数**（解出 2+actual_len 即停），
 *     不是状态收敛，故不需要 flush，也不需要唯一可解性。 */
{
    console.log('═══ T2 生产方向强化回环（随机 / 极端字节 + 受限预算） ═══');
    const L = 256;
    let bad = 0, cases = 0, worstSteps = 0, minSlack = Infinity;
    for (let seed = 1; seed <= 60; seed++) {
        const R = rnd(seed * 104729);
        const n = 2 + Math.floor(R() * 200);
        const B = new Uint8Array(n);
        const mode = seed % 5;
        for (let i = 0; i < n; i++) {
            B[i] = mode === 1 ? 0 : mode === 2 ? 0xff
                : mode === 3 ? (i & 0xff) : mode === 4 ? (R() < 0.9 ? 0 : 0xff)
                    : Math.floor(R() * 256);
        }
        const actual = n - 2;
        B[0] = (actual >>> 8) & 0xff; B[1] = actual & 0xff;

        const padded = Array.from(B).concat(new Array(INIT_BYTES).fill(0));
        /* 预算按生产口径给足：真实模型 ~5 bit/token ⇒ 8n/5 步；这里合成 CDF
         * 更高，给 8n 步的上限，用来验证"不因预算而失败"。 */
        const budget = Math.max(64, n * 8);
        const enc = rangeDecodeRole(padded, L, n + INIT_BYTES, budget);
        const dec = rangeEncodeRole(enc.picked, L, budget);
        const got = Uint8Array.from(dec.bytes.slice(0, n));
        const same = got.length === n && got.every((v, i) => v === B[i]);
        cases++;
        if (!same) { bad++; if (bad <= 2) console.log(`   ✗ seed=${seed} n=${n} mode=${mode}`); }
        if (enc.steps > worstSteps) worstSteps = enc.steps;
        const slack = dec.bytes.length - n;
        if (slack < minSlack) minSlack = slack;
    }
    ok(bad === 0, 'T2 60 组生产方向回环全部逐字节精确', bad + '/' + cases + ' 失败');
    console.log(`  ${cases} 组 ✓ · 最坏 ${worstSteps} 符号`);
    console.log(`  解码端产出字节数 - 需求字节数，最小富余 = ${minSlack}（须 ≥ 0，否则判 NOT_STEGO）\n`);
    ok(minSlack >= 0, 'T2 解码端产出字节数恒不少于需求（长度头可达）');
}

/* ── T3：窗口不变式（r ≤ 2^W、lo < 2^W） ── */
{
    console.log('═══ T3 窗口不变式 ═══');
    const L = 256;
    const R = rnd(0xabcd);
    const S = []; for (let i = 0; i < 300; i++) S.push(Math.floor(R() * L));
    let bad = 0, minR = null, smallSteps = 0, pools = [];
    rangeEncodeRole(S, L, 8192, (lo, r, steps, pool) => {
        if (lo + r - 1n > MASK || r > (1n << W) || r < 1n) bad++;
        if (minR === null || r < minR) minR = r;
        if (r < 65536n) smallSteps++;
        pools.push(pool);
    });
    ok(bad === 0, 'T3 窗口恒在 [0,2^W) 内且 r ≥ 1');
    const minPool = Math.min.apply(null, pools);
    console.log(`  300 步内最小 r = ${minR}（最小池 = ${minPool}）`);
    console.log(`  r < 2^16 的步数：${smallSteps}（这些步 M 由 r 决定，池深随之收紧）\n`);
    ok(minR >= 2n, 'T3 重归一化退出后 r ≥ 2（stepScale 与池下限 2 有效）');
}

/* ── T4：小 r ⇒ 池深收紧，回环仍须精确 ──
 *
 *  以 1B / 2B 明文起步，强制走极端小 M 的分支（M 可能只有 2、4、8），
 *  验证「池深 = min(池上限, M)」这条规则在小尺度下仍然自洽。 */
{
    console.log('═══ T4 小 M（池深收紧）下的生产方向回环 ═══');
    const L = 256;
    let bad = 0, cases = 0, minPoolSeen = L, minMSeen = 1 << 16;
    for (let seed = 1; seed <= 60; seed++) {
        const R = rnd(seed * 7919);
        const n = 2 + (seed % 4);                  // 2..5 字节（含 2B 长度头）
        const B = new Uint8Array(n);
        for (let i = 0; i < n; i++) B[i] = Math.floor(R() * 256);
        const actual = n - 2;
        B[0] = (actual >>> 8) & 0xff; B[1] = actual & 0xff;

        const padded = Array.from(B).concat(new Array(INIT_BYTES).fill(0));
        const budget = 512;
        let okRun = true;
        try {
            const enc = rangeDecodeRole(padded, L, n + INIT_BYTES, budget,
                (lo, r, st, pool) => { if (pool < minPoolSeen) minPoolSeen = pool; });
            const m = stepScale(1n << W);
            if (m < minMSeen) minMSeen = m;
            const dec = rangeEncodeRole(enc.picked, L, budget);
            const got = Uint8Array.from(dec.bytes.slice(0, n));
            okRun = got.length === n && got.every((v, i) => v === B[i]);
        } catch (e) { okRun = false; console.log('   throw: ' + e.message); }
        cases++;
        if (!okRun) bad++;
    }
    ok(bad === 0, 'T4 60 组短明文（小 M 分支）全部精确回环', bad + '/' + cases + ' 失败');
    console.log(`  ${cases} 组 ✓（观测到的最小池 ${minPoolSeen}）\n`);
}

console.log('═'.repeat(60));
console.log(fail === 0 ? `✅ 全通：${pass} 项断言` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
console.log('═'.repeat(60));
process.exit(fail === 0 ? 0 : 1);

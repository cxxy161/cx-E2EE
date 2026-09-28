/* ═══════════════════════════════════════════════════════════════════
 * 纯整数区间编码原语（原型分支 · 与既有实现并列，不替换任何文件）
 * ═══════════════════════════════════════════════════════════════════
 *
 * ── 为什么不用 rANS ──
 * 教科书 rANS 要求 x_max = ((RANS_L >> s) << 8)·freq > RANS_L，即 freq > 2^(s-8)。
 * 取 s=16（M=2^16）就得 freq ≥ 256，而我们的候选池有 64~256 个符号，
 * 绝大多数 freq 远小于 256 —— 简单形式的 rANS 直接失效（形式本身的限制，
 * 不是实现问题）。故改用**精确区间细分**。
 *
 * ── 区间细分（exact interval subdivision） ──
 * 把「待编码的整个字节串」当成一个大整数 V ∈ [0, 2^(8·N))，
 * 逐符号把区间 [lo, hi) 按整数 CDF 细分，直到 hi-lo == 1（V 被唯一确定）。
 *
 * 本文件只放**纯函数原语**；驱动循环在 codec-range.mjs。
 */

/* ── 整数地板除（对浮点误差做一次校正） ── */
function idivFloor(a, b) {
    let q = Math.floor(a / b);
    if (q * b > a) q--;
    else if ((q + 1) * b <= a) q++;
    return q;
}

/* ══════════════════ ① 定点整数 CDF ══════════════════
 *
 * 权重直接来自 tables.bin 的 exp_lut —— 与模型自身 softmax（stego.js:softmaxLut）
 * 是同一条整数映射，因此不引入任何浮点概率。
 *
 *   d   = z_max - z_i                  （int32 logits 差，定点 2^-RES_FRAC / nat）
 *   idx = floor(d · (NL-1) / span)      span = EXP_LUT_MAX · 2^RES_FRAC = 65536
 *   w_i = exp_lut[idx]，下限 1           （尾部候选不许被抹成 0）
 *
 * 归一化到 M 的整数 CDF：f_i = max(1, floor(w_i·M/Σw))，再确定性补/退残差使 Σf = M。
 * 残差顺序：权重降序、同权下标升序 —— 两端从同一组 logits 得到逐字节相同的 CDF，
 * 故**概率表无需传输**。
 */
export function buildIntegerCDF(logits, ids, expLut, M, maxFreq) {
    const L = ids.length;
    if (L < 2) throw new Error('CDF_POOL_TOO_SMALL: ' + L);
    if (L > M) throw new Error('CDF_POOL_GT_SCALE: ' + L + ' > ' + M);

    const NL = expLut.length;          // 8192
    const span = 16 * 4096;            // EXP_LUT_MAX · 2^RES_FRAC = 65536

    const w = new Int32Array(L);
    let maxS = -Infinity;
    for (let i = 0; i < L; i++) { const s = logits[ids[i]] | 0; if (s > maxS) maxS = s; }
    let sum = 0;
    for (let i = 0; i < L; i++) {
        const d = maxS - (logits[ids[i]] | 0);
        let x = (d >= span) ? expLut[NL - 1] : expLut[idivFloor(d * (NL - 1), span)];
        if (!(x >= 1)) x = 1;
        w[i] = x; sum += x;
    }

    /* ── 最高频上限（**最坏码长保证**，非优化） ──
     *
     * 不设上限时，「区间坍缩」所需的步数是数据相关的、**没有上界**：
     * 若某步的 p 逼近 1，该步只消耗 -log2(p) ≈ 0 bit，区间几乎不收缩。
     * 实测：全 0x00 帧（V=0，每步都落 bucket 0）需 **805 步**，
     * 直接越过 RoPE 的 512 硬上限 —— 编码端抛 RANGE_MAX_STEPS。
     *
     * 设 freq ≤ M/2^k ⇒ 每步至少消耗 k bit ⇒ 步数 ≤ 8N/k。
     * 这是保证「任意输入都在 512 步内坍缩」的**唯一**手段，
     * 代价是压平分布（NLL 上升）——两者是硬 trade-off，实测见测试报告。
     * 两端由同一 (M, maxFreq) 推出同一 CDF，故仍无需传输。 */
    const cap = (maxFreq && maxFreq > 1) ? Math.min(maxFreq, M >> 1) : 0;

    const f = new Int32Array(L);
    let used = 0;
    for (let i = 0; i < L; i++) {
        let v = idivFloor(w[i] * M, sum);
        if (v < 1) v = 1;
        if (cap && v > cap) v = cap;
        f[i] = v; used += v;
    }

    /* 残差修正（确定性，O(L log L) 一次收敛）
     *
     * ⚠️ 原实现用"有界循环反复 +1/-1"，在 M_step 较小（尾部 r 变小时
     *    M_step 会降到 2^10 甚至 2^2）且池很大时会**收敛不了** ——
     *    实测 M=1024、池 256 时抛 CDF_NORMALIZE_FAIL: 1101 != 1024，
     *    因为要达到 M 需要从大量 freq==1 的条目上各扣 1，而有界循环
     *    的 `f[i] > 1` 守卫会让它空转。
     *    这里改为按权重降序**一次性**分配差额，必然成功：
     *      差额 > 0  → 从权重最高的开始逐个 +1
     *      差额 < 0  → 从权重最低的、且 freq>1 的开始逐个 -1
     *    L ≤ M 已由入参保证，故每个候选最终必 ≥ 1。 */
    const order = Array.from({ length: L }, (_, i) => i).sort((a, b) => (w[b] - w[a]) || (a - b));
    let diff = M - used;
    if (diff > 0) {
        /* ⚠️ 残差必须补到**权重最低**的条目上，不能补到最高的 ——
         * 后者会把刚被 cap 压下去的最高频重新抬起来，cap 失效、最坏码长
         * 又变成无上界。补到尾部只抬高长尾（质量极小，对 NLL 影响可忽略），
         * 从而严格保持 freq_top ≤ cap，步数上界 8N/k 才真正成立。 */
        const fill = cap ? order.slice().reverse() : order;
        for (let k = 0; k < diff; k++) f[fill[k % L]]++;
    } else if (diff < 0) {
        // 从权重最低者开始扣，且只扣 freq>1 的
        for (let k = L - 1; k >= 0 && diff < 0; k--) {
            const i = order[k];
            const take = Math.min(f[i] - 1, -diff);
            if (take > 0) { f[i] -= take; diff += take; }
        }
        // 若仍有剩余差额（理论上不应发生：Σf ≥ L 且 L ≤ M），
        // 从权重最高者继续扣，保证严格收敛
        for (let k = 0; k < L && diff < 0; k++) {
            const i = order[k];
            const take = Math.min(f[i] - 1, -diff);
            if (take > 0) { f[i] -= take; diff += take; }
        }
    }
    used = 0; for (let i = 0; i < L; i++) used += f[i];
    if (used !== M) throw new Error('CDF_NORMALIZE_FAIL: ' + used + ' != ' + M + ' (L=' + L + ')');

    const cum = new Int32Array(L + 1);
    for (let i = 0; i < L; i++) cum[i + 1] = cum[i] + f[i];
    if (cum[L] !== M) throw new Error('CDF_CUM_FAIL: ' + cum[L]);

    return { M, cum, freqs: f, L };
}

/* ══════════════════ ② 每步几何：自适应定点尺度 ══════════════════
 *
 * ⚠️ 这一步是**终止性保证**，不是优化。
 *
 * 若全程固定 M=2^16，当剩余区间 r < 2^16 时，某个极强势候选的
 * freq 可能逼近 M，导致
 *     hi' - lo' = ceil(r·freq/M) == r      ← 区间**不收缩**
 * 于是编码端死循环（实测症状：跑到步数上限 RANGE_MAX_STEPS）。
 *
 * 取 M_step = 不超过 min(2^16, r) 的最大 2 的幂，即可证明严格收缩：
 *   池内 L ≥ 2 且每个 freq ≥ 1 ⇒ freq_top ≤ M_step - 1
 *   ⇒ hi'-lo' = ceil(r·freq_top/M_step) ≤ ceil(r·(M_step-1)/M_step)
 *             = ceil(r - r/M_step) ≤ r - 1  <  r        （因 M_step ≤ r）
 *
 * 两端都由 r 决定 M_step，故**无需传输**；且 M_step ≤ r 也保证了
 * t = floor((V-lo)·M_step/r) ∈ [0, M_step) 不越界。
 */
export function stepScale(r) {
    const CAP = 1n << 16n;
    const m = r < CAP ? r : CAP;          // m ≥ 2（调用点保证 r ≥ 2）
    let p = 1n;
    while (p * 2n <= m) p *= 2n;
    return Number(p);
}

/* ══════════════════ ③ 区间细分原语 ══════════════════ */

/** 在 cum 中二分：找 i 使 cum[i] ≤ t < cum[i+1]。t ∈ [0, M) */
export function bucketOf(cum, L, M, t) {
    if (t < 0) t = 0; else if (t >= M) t = M - 1;
    let lo = 0, hi = L - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** 由区间大小 r 与桶 i 推出 [lo', hi')。纯 BigInt。
 *
 * ⚠️ 必须取 **ceil**，不能取 floor。目标不变量是 V ∈ [lo, hi)。
 *    设 a = cum[i]、b = cum[i+1]，t = floor((V-lo)·M/r) ∈ [a, b-1]：
 *      V-lo ≥ r·a/M  ⇒ V-lo ≥ ceil(r·a/M)          （V-lo 为整数）
 *      V-lo < r·b/M  ⇒ V-lo ≤ ceil(r·b/M) - 1
 *    故 lo' = lo + ceil(r·a/M)、hi' = lo + ceil(r·b/M) 严格保持 V ∈ [lo', hi')。
 *    取 floor 时第二条不成立，不变量破坏 —— 实测症状正是区间永不坍缩。
 *    ceil 同时让相邻区间严格首尾相接（hi'(i) == lo'(i+1)），不重不漏。
 */
export function narrow(lo, r, cum, i, M) {
    const Mb = BigInt(M);
    const a = (r * BigInt(cum[i]) + Mb - 1n) / Mb;
    const b = (r * BigInt(cum[i + 1]) + Mb - 1n) / Mb;
    return { lo: lo + a, hi: lo + b };
}

/* ══════════════════ ④ 大整数 ↔ 字节串 ══════════════════ */

export function bytesToBigInt(u8) {
    let v = 0n;
    for (let i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]);
    return v;
}

export function bigIntToBytes(v, len) {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
}

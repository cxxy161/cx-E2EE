/* ═══════════════════════════════════════════════════════════════════
 * 原型分支：纯整数区间编码 Codec
 * ═══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 并行原型，**不替换** codec.mjs，也**不改动** js-kernel.mjs
 *    （后者是 golden 45/45 层哈希对齐的黄金参考，必须逐 bit 稳定）。
 *
 * ── 与既有 6bit 路径的唯一差别 ──
 *   既有：每步从密文读 6 bit 当 Top-64 下标 → **均匀抽签**
 *   此处：每步按定点整数 CDF 细分区间     → **分布保真**
 *
 * ── 契约（与既有 codec 一致，上游无感） ──
 *   encodeFrameRange(frameBytes, M, V) -> 纯文本
 *   decodeFrameRange(textBytes,  M, V) -> 原始 frameBytes（逐字节精确）
 *   encodeChainRange([f1,f2,...])      -> 纯文本（多帧连续 token 流）
 *   decodeChainRange(textBytes)        -> [f1,f2,...]（自定界）
 *   帧 = 192 字节定长；AES-GCM / 段头 / 数据流边界一律不碰。
 *
 * ── 帧边界为何无需传输 ──
 *   每帧的初始区间 [0, 2^(8N)) 由帧长 N 唯一确定，终止条件是 hi-lo==1
 *   （区间坍缩到唯一整数）。解码端逐帧检测坍缩即知帧边界，**无需长度字段**。
 *
 * ── 链与帧的关系（关键集成约束） ──
 *   链 = 一条连续 token 流，RoPE 位置表长度（512）= 每链 token 硬上限。
 *   区间编码吞吐 ≈ 模型熵（5.2~5.9 bit/token）< 既有强制的 6.00，
 *   故同样 512 token 能载的字节数**少于**既有 384B —— 这是信息论下界，
 *   不是实现缺陷（6.00 bit/token 高于模型熵，只能靠扭曲分布硬挤出来）。
 */

import { stepForward, createState } from './js-kernel.mjs';
import { loadVocabBytes, isBlacklistedBytes } from './vocab-real.mjs';
import {
    buildIntegerCDF, stepScale, bytesToBigInt, bigIntToBytes, bucketOf, narrow,
} from './range-coder.mjs';

export const BOS_TOKEN = 1;
export const FRAME_BYTES = 192;          // 与 frame.mjs 的 SEG_BYTES 对齐
export const POOL_MAX = 256;             // 候选池上限（>64：只砍长尾，不改形状）
export const TOKEN_BUDGET = 512;         // RoPE 位置表长度 = 每链 token 硬上限
export const MAX_STEPS = TOKEN_BUDGET;   // 硬上限（别名）

/* ── 自适应最高频上限（保终止 + 几乎不损伤自然度） ──
 *
 * ── 为什么必须存在 ──
 * 区间编码的**最坏码长没有上界**：某步 p→1 时只消耗 -log2(p)≈0 bit，
 * 区间几乎不收缩。实测全 0x00 帧（V=0，每步都落 bucket 0）需 **805 步**，
 * 越过 512 的 RoPE 硬上限。（真实密文不会出现 V=0，但协议不能靠这个。）
 *
 * ── 为什么不能用固定 cap ──
 * 固定 cap = M>>k 能保证 ≤8N/k 步，但**全程**压平分布，代价极大：
 * 实测 k=3 → NLL 5.255，k=0（不压）→ 3.498，等于把本改造的收益全吃掉。
 *
 * ── 本规则：按「观测速率 vs 所需速率」只在**落后时**才压 ──
 *     rate = consumed / stepsUsed      观测到的实际 bit/token
 *     need = bits(r) / stepsLeft       要在预算内收完所需的 bit/token
 *  仅当 need 超过观测速率与保守下限时，才设 k = ceil(need)。
 *
 * 性质：
 *   ① 正常数据（随机密文，速率 ≈5.4 > need）**不触发**，分布保持原样；
 *   ② 病态数据（全 0、强复读）速率塌陷 ⇒ 自动收紧 ⇒ 必在预算内坍缩；
 *   ③ 两端一致：r / stepsUsed / 8N 双方完全相同，无需传输任何参数。
 */
export function adaptiveCapFreq(Mv, r, stepsUsed, totalBits, budget, floorRate) {
    const stepsLeft = budget - stepsUsed;
    if (stepsLeft <= 0) return 0;
    const bitsLeft = bitlenBig(r);
    if (bitsLeft <= 0) return 0;
    const need = bitsLeft / stepsLeft;
    const consumed = totalBits - bitsLeft;
    const rate = stepsUsed > 0 ? consumed / stepsUsed : 0;
    const slack = Math.max(rate, floorRate == null ? 2.0 : floorRate);
    if (need <= slack) return 0;               // 在轨 → 不干预
    const k = Math.ceil(need);
    if (k <= 0) return 0;
    return Math.max(2, Mv >> k);
}

function bitlenBig(x) { let n = 0; while (x > 0n) { n++; x >>= 1n; } return n; }

/* ── 候选池：黑名单准入 + 单趟贪心 prefix-free（与 stego.js 同规则） ──
 *
 * prefix-free 仍然必需：算术编码只省掉"均匀"，没省掉"可辨识" ——
 * 解码端仍要靠"文本在游标处以哪个候选开头"唯一认出被编码的符号。
 *
 * ⚠️ 池大小必须 ≤ 当前步的定点尺度 M_step，否则 CDF 无法做到每候选 freq≥1。
 *    M_step 由区间宽度 r 唯一决定（两端都算得出），故 L=min(poolMax, M_step)
 *    同样是**两端一致的确定性规则**，无需传输。 */
export function buildPool(logits, V, poolMax, limit) {
    const cap = Math.max(2, Math.min(poolMax, limit == null ? poolMax : limit));
    const idx = Array.from({ length: logits.length }, (_, i) => i);
    idx.sort((a, b) => {
        const d = (logits[b] | 0) - (logits[a] | 0);
        return d !== 0 ? d : (a - b);
    });
    const ids = [], bufs = [];
    for (let k = 0; k < idx.length && ids.length < cap; k++) {
        const id = idx[k];
        if (!V.isAllowed(id)) continue;
        const s = V.raw(id);
        let bad = false;
        for (let j = 0; j < bufs.length; j++) {
            if (V.isPrefix(bufs[j], s) || V.isPrefix(s, bufs[j])) { bad = true; break; }
        }
        if (bad) continue;
        ids.push(id); bufs.push(s);
    }
    if (ids.length < 2) throw new Error('POOL_TOO_SMALL: ' + ids.length);
    return { ids, bufs };
}

/* ══════════════════ 链级编码（K 帧 = 一条连续 token 流） ══════════════════
 *
 * ⚠️ 段内 K 帧必须是**同一条连续 token 流**（README §八 踩过的坑）：
 *    每帧 reset 状态会让第 2 帧以 BOS 重新起步，与解码端错位。
 *    故模型状态 st 与 last 跨帧延续；**只有区间 [lo,hi) 每帧重置**。 */
export function encodeChainRange(frameList, M, V, opts = {}) {
    const poolMax = opts.poolMax || POOL_MAX;
    const budget = opts.maxSteps || MAX_STEPS;
    let totalBits = 0;
    for (const f of frameList) totalBits += 8 * f.length;

    const st = createState(M);
    let last = BOS_TOKEN;
    const parts = [], picked = [], poolLog = [], perFrame = [];
    let steps = 0;

    for (const frame of frameList) {
        const N = frame.length;
        const Vp = bytesToBigInt(frame);
        let lo = 0n, hi = 1n << BigInt(8 * N);
        const fStart = steps;

        while (hi - lo > 1n) {
            if (steps >= budget) throw new Error('RANGE_MAX_STEPS: ' + steps + '（超每链预算 ' + budget + '）');
            const r = hi - lo;
            const Mv = stepScale(r);                       // 自适应尺度 ⇒ 保证收缩
            const Mb = BigInt(Mv);

            const fw = stepForward(M, last, st);
            const pool = buildPool(fw.logits, V, poolMax, Mv);
            poolLog.push(pool.ids.length);
            const cdf = buildIntegerCDF(fw.logits, pool.ids, M.tables.exp_lut.arr, Mv,
                adaptiveCapFreq(Mv, r, steps, totalBits, budget));

            const t = Number(((Vp - lo) * Mb) / r);
            const i = bucketOf(cdf.cum, cdf.L, Mv, t);
            const nx = narrow(lo, r, cdf.cum, i, Mv);
            lo = nx.lo; hi = nx.hi;

            parts.push(pool.bufs[i]);
            picked.push(pool.ids[i]);
            last = pool.ids[i];
            steps++;
        }
        if (lo !== Vp) throw new Error('RANGE_NOT_EXACT: 坍缩值 ≠ 原值');
        perFrame.push({ steps: steps - fStart });
    }

    let total = 0;
    for (const p of parts) total += p.length;
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }

    return {
        text: new TextDecoder('utf-8').decode(bytes),
        steps, bytes: total, picked, perFrame,
        avgPool: poolLog.reduce((a, b) => a + b, 0) / poolLog.length,
        bitsPerToken: totalBits / steps,
    };
}

/* ══════════════════ 链级解码（逐帧检测坍缩 ⇒ 自定界） ══════════════════
 *
 * 帧数不需要传输：每帧解码到 hi-lo==1 即为该帧结束，区间重置后继续。
 * 终止条件 = 文本被完整消费（或达到 maxFrames 上限，供单帧调用）。 */
export function decodeChainRange(textBytes, M, V, opts = {}) {
    const N = opts.frameBytes || FRAME_BYTES;
    const poolMax = opts.poolMax || POOL_MAX;
    const budget = opts.maxSteps || MAX_STEPS;
    const maxFrames = opts.maxFrames || 64;
    const totalBits = 8 * N * maxFrames;

    const st = createState(M);
    let last = BOS_TOKEN;
    let cursor = 0, steps = 0;
    const frames = [], picked = [];

    while (cursor < textBytes.length) {
        if (frames.length >= maxFrames) break;
        let lo = 0n, hi = 1n << BigInt(8 * N);

        while (hi - lo > 1n) {
            if (steps >= budget) throw new Error('RANGE_MAX_STEPS: ' + steps);
            if (cursor >= textBytes.length) {
                const e = new Error('RANGE_TEXT_UNDERRUN@' + cursor);
                e.code = 'NOT_STEGO'; e.stepsUsed = steps;
                throw e;
            }
            const r = hi - lo;
            const Mv = stepScale(r);

            const fw = stepForward(M, last, st);
            const pool = buildPool(fw.logits, V, poolMax, Mv);
            const cdf = buildIntegerCDF(fw.logits, pool.ids, M.tables.exp_lut.arr, Mv,
                adaptiveCapFreq(Mv, r, steps, totalBits, budget));

            // 唯一命中：prefix-free 保证至多一个候选是此处前缀
            let hit = -1, hits = 0;
            for (let i = 0; i < pool.bufs.length; i++) {
                if (V.matchesAt(textBytes, cursor, pool.bufs[i])) { if (hit < 0) hit = i; hits++; }
            }
            if (hits === 0) {
                const e = new Error('RANGE_DESYNC@' + cursor + '（文本与候选集无法对齐）');
                e.code = 'NOT_STEGO'; e.stepsUsed = steps;
                throw e;
            }
            if (hits > 1) throw new Error('RANGE_AMBIGUOUS@' + cursor);

            const nx = narrow(lo, r, cdf.cum, hit, Mv);
            lo = nx.lo; hi = nx.hi;

            last = pool.ids[hit];
            picked.push(pool.ids[hit]);
            cursor += pool.bufs[hit].length;
            steps++;
        }
        frames.push(bigIntToBytes(lo, N));
    }

    return { frames, steps, consumed: cursor, picked };
}

/* ══════════════════ 单帧便捷入口（与既有 codec 同形） ══════════════════ */
export function encodeFrameRange(frameBytes, M, V, opts = {}) {
    const r = encodeChainRange([frameBytes], M, V, opts);
    return {
        text: r.text, steps: r.steps, bytes: r.bytes, picked: r.picked,
        avgPool: r.avgPool, bitsPerToken: r.bitsPerToken,
    };
}

export function decodeFrameRange(textBytes, M, V, opts = {}) {
    const r = decodeChainRange(textBytes, M, V, Object.assign({}, opts, { maxFrames: 1 }));
    return { frame: r.frames[0], steps: r.steps, consumed: r.consumed, picked: r.picked };
}

export { loadVocabBytes, isBlacklistedBytes };

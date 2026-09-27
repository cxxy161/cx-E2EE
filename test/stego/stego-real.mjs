/* ═══════════════════════════════════════════════════════════════════
 * 真模型驱动 · 密文 ↔ 伪装文本（字节级）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 把已验证的三块拼成完整链路：
 *   js-kernel.mjs   （KV Cache 定点前向，已对齐 golden 45/45）
 *   vocab-real.mjs  （字节级词表，零 TextDecoder）
 *   frame/bitstream （192B 定长帧 + 6bit 位流）
 *
 * 铁律：全程以 Uint8Array 做前缀比对与拼接，只有整段文本产出时才解码。
 */

import { loadModel, stepForward, createState } from './js-kernel.mjs';
import { loadVocabBytes } from './vocab-real.mjs';
import { unitsFromBytes, bytesFromUnits } from './bitstream.mjs';
import {
    SEG_BYTES, SEG_PAYLOAD, buildFrame, parseFrame,
    splitPayload, expected12, segmentEnvelope, mergeSegments,
} from './frame.mjs';

export const BOS_TOKEN = 1;
export const TOPK = 256;          // 推理输出深度（>64，供过滤后递补）
export const NEED = 64;           // 有效候选数（6 bit）
export const FRAMES_PER_SEG = 3;  // 每段 3 帧 ≈ 1773 字 < QQ 2000 上限

/* ── 资产加载 ── */
export function loadReal(modelDir) {
    const M = loadModel(modelDir);
    const V = loadVocabBytes(modelDir + '/vocab.bin', M.fmt.vocab);
    return { M, V };
}

/* ── logits → top-K（int32 偏序，零浮点） ── */
export function topKFromLogits(logits, k = TOPK) {
    const n = logits.length;
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    // 分数降序；同分 token_id 升序（与 golden 的 lexsort 规则一致）
    idx.sort((a, b) => {
        const d = (logits[b] | 0) - (logits[a] | 0);
        return d !== 0 ? d : (a - b);
    });
    return Uint16Array.from(idx.slice(0, k));
}

/* ── 推理引擎（符合 Stego 的 forward(lastId, state) 契约） ── */
export function createEngine(M) {
    let calls = 0;
    return {
        reset() { return createState(M); },
        async forward(lastTokenId, state) {
            calls++;
            const st = state || createState(M);
            const r = stepForward(M, lastTokenId, st);
            return { topK: topKFromLogits(r.logits, TOPK), nextState: st };
        },
        get calls() { return calls; },
        resetCalls() { calls = 0; },
    };
}

/* ── 字节级候选解析：字符集过滤 + 逐对 prefix-free ──
 *
 * 过滤顺序固定（两端必须一致）：
 *   ① isAllowed —— 精确黑名单（空白/控制/零宽/U+FFFD/特殊 token 一律拒）
 *      不用白名单：白名单会误杀模型学到的词组与标点，逼候选深层递补
 *   ② 与已接受集逐对 prefix-free
 */
export function resolveByteCandidates(rawIds, V, need = NEED) {
    const ids = new Array(need);
    const bufs = new Array(need);
    let n = 0;
    const stats = { scanned: 0, rejBlack: 0, rejPrefix: 0 };
    for (let i = 0; i < rawIds.length && n < need; i++) {
        const id = rawIds[i];
        stats.scanned++;
        if (!V.isAllowed(id)) { stats.rejBlack++; continue; }
        const s = V.raw(id);
        let bad = false;
        for (let j = 0; j < n; j++) {
            if (V.isPrefix(bufs[j], s) || V.isPrefix(s, bufs[j])) { bad = true; break; }
        }
        if (bad) { stats.rejPrefix++; continue; }
        ids[n] = id; bufs[n] = s; n++;
    }
    if (n < need) throw new Error(`CANDIDATE_STARVED: ${n}/${need}（黑名单剔 ${stats.rejBlack}，prefix 剔 ${stats.rejPrefix}）`);
    return { ids, bufs, stats };
}

/* ── 帧级编解码 ── */

export async function encodeFrameReal(frame, engine, V, onStep) {
    const units = unitsFromBytes(frame, 6);        // 192*8/6 = 256
    let state = engine.reset();
    let last = BOS_TOKEN;
    const parts = [];
    let total = 0;
    for (let i = 0; i < units.length; i++) {
        const r = await engine.forward(last, state);
        state = r.nextState;
        const cand = resolveByteCandidates(r.topK, V);
        const u = units[i];
        parts.push(cand.bufs[u]);
        total += cand.bufs[u].length;
        last = cand.ids[u];
        if (onStep) onStep(i + 1);
    }
    // 整段拼接后才解码（中途绝不做单 token 解码）
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    return new TextDecoder('utf-8').decode(bytes);
}

/** 把伪装文本按候选集切回 6bit 单元（字节级前缀匹配，唯一命中） */
export async function decodeFrameReal(text, engine, V, opts = {}) {
    const { msgid = 'm', seq = 1, fastFail = true, fastFailSteps = 4, onStep } = opts;
    const bytes = new TextEncoder().encode(text);
    let state = engine.reset();
    let last = BOS_TOKEN;
    const units = [];
    let cursor = 0, steps = 0;

    const bail = (msg) => { const e = new Error(msg); e.code = 'NOT_STEGO'; e.stepsUsed = steps; return e; };

    while (cursor < bytes.length) {
        const r = await engine.forward(last, state);
        state = r.nextState;
        const cand = resolveByteCandidates(r.topK, V);

        let hit = -1, hits = 0;
        for (let i = 0; i < cand.bufs.length; i++) {
            if (V.matchesAt(bytes, cursor, cand.bufs[i])) { if (hit < 0) hit = i; hits++; }
        }
        if (hits === 0) {
            if (fastFail && steps < fastFailSteps) throw bail('NOT_STEGO（文本与候选集无法对齐）');
            throw new Error('DESYNC@' + cursor);
        }
        if (hits > 1) throw new Error('AMBIGUOUS@' + cursor);

        units.push(hit);
        last = cand.ids[hit];
        cursor += cand.bufs[hit].length;
        steps++;
        if (onStep) onStep(steps);
        if (fastFail && steps === 2) {
            const got12 = ((units[0] << 6) | units[1]) & 0xfff;
            if (got12 !== expected12(msgid, seq)) throw bail('NOT_STEGO（Magic 位不匹配）');
        }
    }
    return bytesFromUnits(units, 6);
}

/* ── 段级连续编解码 ──
 *
 * ⚠️ 关键一致性约束：
 *   一个段内的 K 个帧必须当作**同一条连续 token 流**处理，
 *   绝不可"每帧 reset 一次状态" —— 那会让第 2 帧起以 BOS 重新起步，
 *   而解码端沿段体连续推进状态，两边必然错位（实测 DESYNC）。
 *
 *   段的字节数 = K × 192（帧本来就定长），
 *   token 数 = K × 256，天然整除。
 */
export async function encodeSegmentReal(segBytes, engine, V, onStep) {
    const units = unitsFromBytes(segBytes, 6);
    let state = engine.reset();
    let last = BOS_TOKEN;
    const parts = [];
    let total = 0;
    for (let i = 0; i < units.length; i++) {
        const r = await engine.forward(last, state);
        state = r.nextState;
        const cand = resolveByteCandidates(r.topK, V);
        const u = units[i];
        parts.push(cand.bufs[u]);
        total += cand.bufs[u].length;
        last = cand.ids[u];
        if (onStep) onStep();
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    return new TextDecoder('utf-8').decode(bytes);
}

/* ── 消息级：密文字节 → 分段伪装文本 ── */

export async function encodeAll(cipherBytes, { engine, V, msgid, onProgress, signal } = {}) {
    const slices = splitPayload(cipherBytes);
    const framesTotal = slices.length;
    const segsTotal = Math.ceil(framesTotal / FRAMES_PER_SEG);
    const t0 = Date.now();
    let done = 0;
    const totalSteps = framesTotal * 256;
    const segments = [];

    for (let s = 0; s < segsTotal; s++) {
        const first = s * FRAMES_PER_SEG;
        const lastF = Math.min(first + FRAMES_PER_SEG, framesTotal);
        const K = lastF - first;

        // 把本段的 K 帧拼成一条连续字节流，再整体编码
        const segBytes = new Uint8Array(K * SEG_BYTES);
        for (let k = 0; k < K; k++) {
            segBytes.set(buildFrame(slices[first + k], msgid, first + k + 1), k * SEG_BYTES);
        }

        const body = await encodeSegmentReal(segBytes, engine, V, () => {
            done++;
            if (onProgress && done % 16 === 0) {
                const el = Math.max(1, Date.now() - t0) / 1000;
                onProgress({
                    frame: Math.min(framesTotal, Math.floor(done / 256) + 1), framesTotal,
                    segment: s + 1, segmentsTotal: segsTotal,
                    step: done, stepsTotal: totalSteps,
                    bps: done / el,
                    etaMs: ((totalSteps - done) / (done / el)) * 1000,
                });
            }
        });
        if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        segments.push({ seq: s + 1, total: segsTotal, msgid, body });
    }

    const chars = segments.reduce((a, x) => a + x.body.length, 0);
    return { segments, frames: framesTotal, chars, ms: Date.now() - t0 };
}

/** 伪装文本（可含多段信封）→ 密文字节 */
export async function decodeAll(text, { engine, V, onProgress, signal } = {}) {
    const mg = mergeSegments(text);
    if (!mg.bodies) throw new Error('未找到段信封（CX2|<seq>/<total>|…）');
    if (mg.incomplete) {
        const e = new Error('收到第 ' + mg.got + '/' + mg.total + ' 段，还缺第 ' + mg.missing.join('、') + ' 段');
        e.code = 'INCOMPLETE';
        throw e;
    }
    const out = [];
    const t0 = Date.now();
    let done = 0;
    const framesTotal = mg.total * FRAMES_PER_SEG;

    for (const b of mg.bodies) {
        if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        const firstFrame = (b.seq - 1) * FRAMES_PER_SEG + 1;
        const expectedFrames = Math.min(FRAMES_PER_SEG, framesTotal - (b.seq - 1) * FRAMES_PER_SEG);

        // 整段一次性解码：段内 token 流连续，解出的字节流按 192B 自然分帧。
        // ⚠️ 不要"每帧重置状态再解" —— 与编码端的连续流契约不符。
        const frameBytes = await decodeFrameReal(b.body, engine, V, {
            msgid: mg.msgid, seq: firstFrame, fastFail: true,
            onStep: () => { done++; if (onProgress && done % 32 === 0) onProgress({ step: done, stepsTotal: framesTotal * 256 }); },
        });

        const nFrames = Math.floor(frameBytes.length / SEG_BYTES);
        for (let i = 0; i < Math.min(nFrames, expectedFrames); i++) {
            const frameNo = firstFrame + i;
            out.push(parseFrame(frameBytes.subarray(i * SEG_BYTES, (i + 1) * SEG_BYTES), mg.msgid, frameNo));
        }
    }

    const total = out.reduce((a, x) => a + x.length, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const x of out) { joined.set(x, o); o += x.length; }
    return { bytes: joined, ms: Date.now() - t0 };
}

export { segmentEnvelope, mergeSegments, SEG_BYTES, SEG_PAYLOAD, FRAMES_PER_SEG as FPS };

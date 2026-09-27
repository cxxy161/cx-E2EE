/* ═══════════════════════════════════════════════════════════════════
 * 隐写编解码驱动 —— 位流 ↔ 伪装文本
 * ═══════════════════════════════════════════════════════════════════
 *
 * 编码：帧字节 → 256 个 6bit 单元 → 每单元取过滤后 Top-64 的第 u 名 token
 * 解码：伪装文本 → 每步重算 Top-64 → 前缀唯一命中 → 名次即 6bit
 *
 * 自同步性：解码第 t 步只依赖「已解出的 token 历史」，与文本长度、后续内容无关。
 *           故任意段边界、任意段顺序都能独立解码。
 *
 * Fast-Fail：解出前 2 个 token（12 bit）即与 Magic⊕nonce 的高 12 位比对。
 *            普通文章在第 2 步就被拒，不会白跑几百步推演。
 */

import { unitsFromBytes, bytesFromUnits } from './bitstream.mjs';
import { resolveCandidates } from './candidates.mjs';
import { parseFrame, expected12, SEG_BYTES } from './frame.mjs';

export const BOS_TOKEN = 1;        // 协议写死的起手符，两端必须一致

export async function encodeFrame(frame, engine, vocab) {
    if (frame.length !== SEG_BYTES) throw new Error('BAD_FRAME: ' + frame.length);
    const units = unitsFromBytes(frame, 6);       // 192*8/6 = 256，恰好整除
    let state = engine.reset();
    let last = BOS_TOKEN;
    let text = '';
    for (let i = 0; i < units.length; i++) {
        const r = await engine.forward(last, state);
        state = r.nextState;
        const cand = resolveCandidates(r.topK, vocab);
        const idx = units[i];
        text += cand.strings[idx];
        last = cand.ids[idx];
    }
    return text;
}

export async function decodeFrame(text, engine, vocab, opts = {}) {
    const { msgid = 'mock', seq = 1, fastFail = true, fastFailSteps = 4 } = opts;
    let state = engine.reset();
    let last = BOS_TOKEN;
    const units = [];
    let cursor = 0;
    let steps = 0;

    // Fast-Fail 双闸：
    //   闸① 「走不动」——普通文章常在头几步就撞上"没有任何候选是当前文本的前缀"。
    //        这本身就是强否定信号，直接判非密文退出，不必等满 12 bit。
    //   闸② 「值不对」——能走满 fastFailSteps 步但 Magic 位不匹配。
    // 两闸合起来保证：普通文章的实际推理步数是个位数，绝不会跑满 256 步。
    const bail = (msg) => {
        const err = new Error(msg);
        err.code = 'NOT_STEGO';
        err.stepsUsed = steps;
        return err;
    };

    while (cursor < text.length) {
        const r = await engine.forward(last, state);
        state = r.nextState;
        const cand = resolveCandidates(r.topK, vocab);

        let hit = -1, hits = 0;
        for (let i = 0; i < cand.strings.length; i++) {
            if (text.startsWith(cand.strings[i], cursor)) { if (hit < 0) hit = i; hits++; }
        }
        if (hits === 0) {
            // 首步就走不动 → 判定非密文（普通文章的正常结局）
            if (fastFail && steps < fastFailSteps) throw bail('NOT_STEGO（文本与候选集无法对齐）');
            throw new Error('DESYNC@' + cursor + '（文本被改过，或不是本工具生成的隐写文本）');
        }
        if (hits > 1) throw new Error('AMBIGUOUS@' + cursor + '（候选集非 prefix-free，属实现缺陷）');

        units.push(hit);
        last = cand.ids[hit];
        cursor += cand.strings[hit].length;
        steps++;

        if (fastFail && steps === 2 && units.length >= 2) {
            const got12 = ((units[0] << 6) | units[1]) & 0xfff;
            if (got12 !== expected12(msgid, seq)) throw bail('NOT_STEGO（Magic 位不匹配）');
        }
    }
    return { frame: bytesFromUnits(units, 6), units: units.length };
}

/** 段级往返：切片 → 帧 → 伪装文本 */
export async function encodeSegment(slice, msgid, seq, engine, vocab, buildFrameFn) {
    return encodeFrame(buildFrameFn(slice, msgid, seq), engine, vocab);
}

/** 段级反向：伪装文本 → 帧 → 切片 */
export async function decodeSegment(text, msgid, seq, engine, vocab) {
    const { frame } = await decodeFrame(text, engine, vocab, { msgid, seq });
    return parseFrame(frame, msgid, seq);
}

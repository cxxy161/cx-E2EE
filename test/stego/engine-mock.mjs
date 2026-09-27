/* ═══════════════════════════════════════════════════════════════════
 * Mock 推理引擎 —— 占位真模型，接口先行
 * ═══════════════════════════════════════════════════════════════════
 *
 * 与真模型一致的黑盒接口：
 *   reset() -> state
 *   forward(lastTokenId, state) -> { topK: Uint16Array, nextState }
 *
 * ⚠️ 与原规范的一处接口修正：
 *   原规范写的是 `top64: Uint16Array`。但候选集要经过字符集 + prefix-free 过滤，
 *   会剔掉若干项再递补 —— **只给 64 个就无 65 名可补，过滤器必然 starved**。
 *   故这里返回 `topK`（默认 256），编解码各自取过滤后的前 64。
 *
 * 本 mock 的行为：
 *   - 纯确定性（同一 (lastTokenId, state) 必得同一 topK），等价于 int16 定点模型；
 *   - 每步把对抗样本轮转塞进候选头部，**保证每步都出现 prefix 冲突与换行 token**，
 *     从而让测试真正压到过滤器，而不是走运躲开；
 *   - KV Cache 语义：state 只带递增 step，接口形态与真模型一致。
 */

export function createMockEngine(vocab, { topK = 256 } = {}) {
    let calls = 0;
    const reset = () => ({ step: 0, seed: 0x9e3779b9 >>> 0, hist: 0 });

    const forward = async (lastTokenId, state) => {
        calls++;
        const st = state || reset();

        // 状态推进：hist 累积历史上所有 token 的混合，等价于真模型 KV Cache 的"上下文指纹"。
        // ⚠️ 必须让候选分布**依赖完整历史**，而不是只依赖 step 与 lastTokenId ——
        //    否则载荷的前若干位（经 lastTokenId 反馈）无法影响候选集，
        //    不同载荷会算出相同的前缀，伪装文本出现可预测的固定开头。
        const hist = (Math.imul(st.hist ^ (lastTokenId + 1), 0x9e3779b9) ^ Math.imul(st.step + 1, 0x85ebca6b)) >>> 0;
        let x = (st.seed ^ hist) >>> 0;

        const out = []; const seen = new Set();
        const push = (id) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };

        // 对抗样本轮转植入（每步都出现，压测过滤器）
        const adv = vocab.adversarialIds;
        for (let i = 0; i < adv.length; i++) push(adv[(i + st.step) % adv.length]);

        let guard = 0;
        while (out.length < topK && guard++ < topK * 20) {
            x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
            push(x % vocab.size);
        }
        return {
            topK: Uint16Array.from(out.slice(0, topK)),
            nextState: { step: st.step + 1, seed: st.seed, hist },
        };
    };

    return {
        forward, reset,
        get calls() { return calls; },
        resetCalls() { calls = 0; },
    };
}

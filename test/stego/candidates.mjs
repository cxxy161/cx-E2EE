/* ═══════════════════════════════════════════════════════════════════
 * 候选集解析：raw 排序 → 有效 64 名
 * ═══════════════════════════════════════════════════════════════════
 *
 * 过滤顺序**固定**（编解码两端必须逐字一致）：
 *   ① 字符集白名单（含换行/空格/ASCII 直接拒）—— 这条同时覆盖了"禁用换行符"约束
 *   ② 与已接受集逐对 prefix-free（任一方向的前缀包含都拒）
 *
 * ── 为什么"删一个补一个"是错的 ──
 * 原规范说：Top-64 内若出现 "我"/"我们"，只保留 rank 更高者，被删的空位由第 65 名递补。
 * 但第 65 名自己可能与集合内其他成员冲突，**一趟递补不闭合**，需要迭代到不动点。
 * 本实现改用**单趟贪心扫描**：沿原始排序从头扫，凡与已接受集兼容的就收，
 * 收到 64 个即止。这天然是闭合解（集合内任意两元素必无前缀关系），且必然终止。
 *
 * ── 为什么 prefix-free 就够了（可证） ──
 * 设编码端发出候选 c，解码端在游标处看到文本 T，T 以 c 开头。
 * 若另一候选 c' 也是 T 的前缀：
 *   |c'| ≤ |c| → c' 是 c 的前缀；
 *   |c'| > |c| → c' 越过 c 进入下一个 token，故 c 是 c' 的前缀。
 * 两种情形都被 prefix-free 排除 ⇒ 命中唯一。 ∎
 */

export const TOP_K = 64;

export function resolveCandidates(rawIds, vocab, k = TOP_K) {
    const ids = new Array(k);
    const strs = new Array(k);
    let n = 0;
    const stats = { scanned: 0, rejectedCharset: 0, rejectedPrefix: 0, rawAvailable: rawIds.length };

    for (let i = 0; i < rawIds.length && n < k; i++) {
        const id = rawIds[i];
        stats.scanned++;
        if (!vocab.isAllowed(id)) { stats.rejectedCharset++; continue; }
        const s = vocab.str(id);
        let conflict = false;
        for (let j = 0; j < n; j++) {
            const a = strs[j];
            if (a === s || a.startsWith(s) || s.startsWith(a)) { conflict = true; break; }
        }
        if (conflict) { stats.rejectedPrefix++; continue; }
        ids[n] = id; strs[n] = s; n++;
    }
    if (n < k) {
        throw new Error('CANDIDATE_STARVED: 仅凑出 ' + n + '/' + k +
            '（raw 只给了 ' + rawIds.length + ' 个，剔除 charset=' + stats.rejectedCharset +
            ' prefix=' + stats.rejectedPrefix + '）');
    }
    return { ids, strings: strs, stats };
}

/** 校验集合是否逐对 prefix-free（测试用） */
export function isPrefixFree(strings) {
    for (let i = 0; i < strings.length; i++) {
        for (let j = 0; j < strings.length; j++) {
            if (i === j) continue;
            if (strings[j].startsWith(strings[i])) return false;
        }
    }
    return true;
}

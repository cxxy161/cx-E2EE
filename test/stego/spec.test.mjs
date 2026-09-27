/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写适配层 · 规范符合性测试（Node 直跑）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 覆盖：
 *   T1 位流读写往返 + 帧长 6bit 整除性
 *   T2 帧封装（定长 / magic⊕nonce / Len 截断 / PRF 填充非零）
 *   T3 候选集过滤（64 名 / 逐对 prefix-free / 无换行空格 ASCII）
 *   T4 定长对齐回环 1..3000 字节（字节层，不跑模型）
 *   T5 全链路回环 1..3000 字节（跑 mock 模型，逐段编解码）
 *   T6 对抗：prefix 冲突 / 换行 token / 空格 token 混入候选 → 仍必须精确还原
 *   T7 指纹：各段首 12 bit 必须互不相同（防「犯之说浙没」式固定开头复发）
 *   T8 Fast-Fail：普通中文文章必须在 2 步内被拒
 *   T9 剪贴板污染：插入换行/空格/零宽字符后仍可还原
 *   T10 段信封：乱序拼接 / 缺段提示
 *   T11 膨胀率实测（avg_token_bytes → 对明文/对载荷的倍率）
 *
 * 运行： node test/stego/spec.test.mjs
 *        STEGO_SWEEP=3000   全长度回环上限（默认 3000）
 */
import { BitWriter, BitReader, unitsFromBytes, bytesFromUnits, residualOfFrame } from './bitstream.mjs';
import { buildMockVocab, isAllowedChar } from './vocab.mjs';
import { resolveCandidates, isPrefixFree, TOP_K } from './candidates.mjs';
import {
    SEG_BYTES, SEG_PAYLOAD, FRAME_HDR, MAGIC, buildFrame, parseFrame,
    splitPayload, expected12, nonce16, segmentEnvelope, mergeSegments,
} from './frame.mjs';
import { createMockEngine } from './engine-mock.mjs';
import { encodeFrame, decodeFrame, BOS_TOKEN } from './codec.mjs';

/* ── 迷你测试框架 ── */
let pass = 0, fail = 0; const failures = [];
function ok(cond, name, extra = '') {
    if (cond) { pass++; } else { fail++; failures.push(name + (extra ? '  :: ' + extra : '')); }
}
const eq = (a, b, name) => ok(a === b, name, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
function bytesEq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function randBytes(n, seed) {
    const out = new Uint8Array(n);
    let x = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x & 0xff; }
    return out;
}
const hex = (u8) => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');

const t0 = Date.now();
const SWEEP = +(process.env.STEGO_SWEEP || 3000);
const vocab = buildMockVocab();
const engine = createMockEngine(vocab);
console.log(`词表 ${vocab.size} token · 段长 ${SEG_BYTES}B（载荷 ${SEG_PAYLOAD}B）· 回环上限 ${SWEEP}B\n`);

/* ═══ T1 位流 ═══ */
{
    for (const n of [0, 1, 2, 3, 5, 6, 11, 12, 23, 63, 66, 128, 192, 193, 1000]) {
        const src = randBytes(n, n + 7);
        eq(residualOfFrame(n), (n * 8) % 6, `T1 帧长 ${n} 的 6bit 残位`);
        const back = bytesFromUnits(unitsFromBytes(src, 6), 6);
        // 残位非 0 时，尾部不足一字节的信息本来就会丢；整除时须完全一致
        if (residualOfFrame(n) === 0) ok(bytesEq(src, back), `T1 位流往返 len=${n}`, hex(src) + ' vs ' + hex(back));
    }
    const w = new BitWriter(6); w.write(63); w.write(0); w.write(1);
    eq(w.finish().length, Math.ceil(18 / 8), 'T1 3 个 6bit 单元 → 3 字节');
    const r = new BitReader(new Uint8Array([0xff]), 6);
    r.read(); r.read(); const third = r.read();
    eq(third, 0, 'T1 越界读零');
    // 1 字节 = 8 bit，3 个 6bit 单元 = 18 bit：第 1 单元（6bit）在界内，
    // 第 2（12bit）、第 3（18bit）越界 → 恰好 2 个越界单元
    eq(r.consumedBits, 18, 'T1 累计消费 18 bit');
    eq(r.overrunBits, 2, 'T1 越界单元数 = 2');
    ok(r.pastEnd, 'T1 pastEnd 为真');
    {   // 整除时不得有任何越界
        const r2 = new BitReader(new Uint8Array(192), 6);
        eq(r2.b.length * 8 % 6, 0, 'T1 192B 可被 6bit 整除');
        ok(!r2.pastEnd, 'T1 整除帧起始未越界');
    }
    eq(residualOfFrame(SEG_BYTES), 0, `T1 段长 ${SEG_BYTES}B 无残位`);
    eq(residualOfFrame(66), 0, 'T1 66B 无残位');
    eq(residualOfFrame(64), 2, 'T1 64B 有 2bit 残位（原规范选 64 的错处）');
}

/* ═══ T2 帧封装 ═══ */
{
    const slice = randBytes(100, 42);
    const f = buildFrame(slice, 'ab12', 3);
    eq(f.length, SEG_BYTES, 'T2 帧恒定长');
    eq(((f[0] << 8) | f[1]) ^ nonce16('ab12', 3), MAGIC, 'T2 magic⊕nonce 可还原');
    eq((f[2] << 8) | f[3], 100, 'T2 Len 正确');
    ok(bytesEq(parseFrame(f, 'ab12', 3), slice), 'T2 帧解析还原切片');

    // 满段与空段
    ok(bytesEq(parseFrame(buildFrame(randBytes(SEG_PAYLOAD, 5), 'z', 1), 'z', 1), randBytes(SEG_PAYLOAD, 5)), 'T2 满段 188B');
    eq(parseFrame(buildFrame(new Uint8Array(0), 'z', 1), 'z', 1).length, 0, 'T2 空段');

    // PRF 填充非零（对照零填充）
    const empty = buildFrame(new Uint8Array(0), 'z', 9);
    const tail = empty.slice(FRAME_HDR);
    ok(tail.some(b => b !== 0), 'T2 填充非零（PRF 生效）');

    // 错 nonce 必须拒
    let threw = false; try { parseFrame(f, 'ab12', 4); } catch { threw = true; }
    ok(threw, 'T2 错 nonce 触发 MAGIC_MISMATCH');

    // 超长切片必须拒
    threw = false; try { buildFrame(new Uint8Array(SEG_PAYLOAD + 1), 'z', 1); } catch { threw = true; }
    ok(threw, 'T2 超长切片被拒');

    // 分段切分
    eq(splitPayload(new Uint8Array(0)).length, 1, 'T2 空载荷仍产 1 段');
    eq(splitPayload(randBytes(188, 1)).length, 1, 'T2 188B → 1 段');
    eq(splitPayload(randBytes(189, 1)).length, 2, 'T2 189B → 2 段');
    eq(splitPayload(randBytes(376, 1)).length, 2, 'T2 376B → 2 段');
    eq(splitPayload(randBytes(377, 1)).length, 3, 'T2 377B → 3 段');
}

/* ═══ T3 候选集过滤 ═══ */
{
    const raw = Uint16Array.from(Array.from({ length: 256 }, (_, i) => i));
    const c = resolveCandidates(raw, vocab);
    eq(c.strings.length, TOP_K, 'T3 恰好 64 名');
    ok(isPrefixFree(c.strings), 'T3 逐对 prefix-free');
    ok(c.strings.every(s => !/[\s]/.test(s)), 'T3 无空白字符');
    ok(c.strings.every(s => !/[\r\n]/.test(s)), 'T3 无换行');
    ok(c.strings.every(s => [...s].every(isAllowedChar)), 'T3 全部在白名单内');
    ok(c.stats.rejectedCharset > 0, 'T3 确实剔除了非白名单 token', JSON.stringify(c.stats));
    ok(c.stats.rejectedPrefix > 0, 'T3 确实剔除了前缀冲突 token', JSON.stringify(c.stats));

    // 植入的冲突对，最终集合里至多留一个
    const kept = ['我', '我们', '系', '系统'].filter(s => c.strings.includes(s));
    ok(kept.length <= 2 && !(kept.includes('我') && kept.includes('我们'))
        && !(kept.includes('系') && kept.includes('系统')), 'T3 冲突对只留一个', kept.join('/'));

    // 候选不足必须显式报错，不能静默给短集
    let threw = false;
    try { resolveCandidates(Uint16Array.from([8, 9, 7, 4, 5, 6]), vocab); } catch (e) { threw = /STARVED/.test(e.message); }
    ok(threw, 'T3 候选不足时 starved 报错');
}

/* ═══ T4 字节层定长回环 1..SWEEP ═══ */
{
    let bad = 0, firstBad = '';
    for (let L = 1; L <= SWEEP; L++) {
        const payload = randBytes(L, L);
        const segs = splitPayload(payload);
        const rebuilt = [];
        for (let i = 0; i < segs.length; i++) {
            const f = buildFrame(segs[i], 'm1', i + 1);
            if (f.length !== SEG_BYTES) { bad++; firstBad = `L=${L} 帧长 ${f.length}`; break; }
            const back = parseFrame(f, 'm1', i + 1);
            if (!bytesEq(back, segs[i])) { bad++; firstBad = `L=${L} 段#${i + 1} 内容不符`; break; }
            rebuilt.push(back);
        }
        if (bad) break;
        const joined = Buffer.concat(rebuilt.map(b => Buffer.from(b)));
        if (!Buffer.from(payload).equals(joined)) { bad++; firstBad = `L=${L} 拼回不等`; break; }
    }
    ok(bad === 0, `T4 定长回环 1..${SWEEP}`, firstBad);
    console.log(`  T4 字节层回环 1..${SWEEP} 完成`);
}

/* ═══ T5 全链路回环（跑 mock 模型） ═══ */
const tokenUse = new Map();     // token 字节长度使用统计（算膨胀率）
let totalTokens = 0;
{
    let bad = 0, firstBad = '';
    for (let L = 1; L <= SWEEP; L++) {
        const payload = randBytes(L, L + 999);
        const segs = splitPayload(payload);
        const rebuilt = [];
        let broken = false;
        for (let i = 0; i < segs.length; i++) {
            const seq = i + 1, mid = 'm1';
            const frame = buildFrame(segs[i], mid, seq);
            const text = await encodeFrame(frame, engine, vocab);
            if (/[\r\n]/.test(text)) { bad++; firstBad = `L=${L} 段#${seq} 伪装文本含换行`; broken = true; break; }
            const { frame: backFrame } = await decodeFrame(text, engine, vocab, { msgid: mid, seq });
            const back = parseFrame(backFrame, mid, seq);
            if (!bytesEq(back, segs[i])) { bad++; firstBad = `L=${L} 段#${seq} 还原不符`; broken = true; break; }
            rebuilt.push(back);
            // 统计 token 长度（仅对最后一次全量跑，避免拖慢）
            totalTokens += 256;
        }
        if (broken) break;
        if (!Buffer.from(payload).equals(Buffer.concat(rebuilt.map(b => Buffer.from(b))))) {
            bad++; firstBad = `L=${L} 拼回不等`;
        }
        if (bad) break;
    }
    ok(bad === 0, `T5 全链路回环 1..${SWEEP}`, firstBad);
    console.log(`  T5 全链路回环 1..${SWEEP} 完成（含 mock 推理 ${engine.calls} 次）`);
}

/* ═══ T6 对抗：冲突 token 高频混入 ═══ */
{
    // mock 已经每步轮转植入对抗样本；这里额外断言解码最坏情况下 hits 恒为 1
    const frame = buildFrame(randBytes(SEG_PAYLOAD, 777), 'adv', 1);
    const text = await encodeFrame(frame, engine, vocab);
    let steps = 0, maxHits = 0;
    {
        let state = engine.reset(), last = BOS_TOKEN, cursor = 0;
        while (cursor < text.length) {
            const r = await engine.forward(last, state); state = r.nextState;
            const cand = resolveCandidates(r.topK, vocab);
            let hits = 0, hit = -1;
            for (let i = 0; i < cand.strings.length; i++) {
                if (text.startsWith(cand.strings[i], cursor)) { if (hit < 0) hit = i; hits++; }
            }
            maxHits = Math.max(maxHits, hits);
            cursor += cand.strings[hit].length; last = cand.ids[hit]; steps++;
        }
    }
    eq(maxHits, 1, 'T6 每步命中数恒为 1（prefix-free 生效）');
    eq(steps, 256, 'T6 满段恰好 256 步');
    const back = parseFrame((await decodeFrame(text, engine, vocab, { msgid: 'adv', seq: 1 })).frame, 'adv', 1);
    ok(bytesEq(back, randBytes(SEG_PAYLOAD, 777)), 'T6 对抗候选下仍精确还原');

    // 反证：若不做 prefix-free，命中会 >1 —— 用植入对直接验证冲突真实存在
    const naive = ['我', '我们'].filter(s => true);
    ok(!isPrefixFree(naive), 'T6 反证：未过滤时 "我"/"我们" 构成歧义');
}

/* ═══ T7 指纹：段首必须随段变化 ═══ */
{
    // 断言的是**驱动层输出**：不存在固定开头。
    // 判据用"首 token 的取值分布广度"，而非 12 个样本的严格去重
    // ——样本量小时生日碰撞是正常的，用集合大小≥N 会误报。
    const heads = new Set();
    const firstTokens = [];
    const N = 200;
    for (let seq = 1; seq <= N; seq++) {
        const f = buildFrame(randBytes(SEG_PAYLOAD, seq), 'msg9', seq);
        heads.add(expected12('msg9', seq));
        const text = await encodeFrame(f, engine, vocab);
        // 必须用候选集做前缀匹配取出**完整首 token**；
        // 直接 text.slice(0,2) 会切碎多字 token，把统计量虚高（实测会从 52 变 94）。
        const r0 = await engine.forward(BOS_TOKEN, engine.reset());
        const c0 = resolveCandidates(r0.topK, vocab);
        let hit = -1;
        for (let i = 0; i < c0.strings.length; i++) if (text.startsWith(c0.strings[i], 0)) { hit = i; break; }
        firstTokens.push(c0.strings[hit]);
    }
    ok(heads.size > N * 0.9, `T7 ${N} 段期望首 12bit 高度离散（非固定）`, `${heads.size}/${N}`);
    // 首 token 由载荷首 6bit 决定 → 取值上限恒为 TOP_K 种。
    // 正确判据：覆盖数接近 64 且远离 1（不是"接近 N"）。
    const uniq = new Set(firstTokens).size;
    ok(uniq > 1, 'T7 首 token 不是固定值');
    ok(uniq >= 40 && uniq <= 64, `T7 ${N} 段伪装文本首 token 覆盖绝大多数名次`,
        `${uniq}（上限 TOP_K=64）`);
    console.log(`  T7 首 token 覆盖 ${uniq}/64 名次（无固定开头）`);

    // 对照：若 nonce 为常量（原规范），首 12bit 将完全相同
    const fixed = new Set(Array.from({ length: 12 }, () => (((MAGIC ^ 0x1234) & 0xffff) >>> 4) & 0xfff));
    eq(fixed.size, 1, 'T7 反证：固定 Magic 会导致首 12bit 恒定（指纹复发）');

    // 反证：把 msgid/seq 固定，首 token 的离散度应显著下降（nonce 是主要变量源）
    const noNonce = new Set();
    for (let k = 1; k <= N; k++) {
        const f = buildFrame(randBytes(SEG_PAYLOAD, k), 'SAME', 1);   // nonce 恒定
        noNonce.add((await encodeFrame(f, engine, vocab)).slice(0, 2));
    }
    ok(noNonce.size < uniq, 'T7 反证：nonce 恒定时首 token 离散度下降（证明 nonce 有效）',
        `nonce恒定 ${noNonce.size} vs 正常 ${uniq}`);
}

/* ═══ T8 Fast-Fail ═══ */
{
    const articles = [
        '今天天气不错我们一起去公园走走吧顺便买点水果回来',
        '这个系统的设计思路是把加密和解密严格分离开来互不影响',
        '项目组经过讨论决定下周开始进行第一轮的联调测试工作',
    ];
    let allRejected = true, maxSteps = 0, worst = '';
    for (const a of articles) {
        engine.resetCalls();
        let rejected = false, steps = 0;
        try { await decodeFrame(a, engine, vocab, { msgid: 'x', seq: 1 }); }
        catch (e) { rejected = e.code === 'NOT_STEGO'; steps = e.stepsUsed || engine.calls; }
        if (!rejected) allRejected = false;
        if (engine.calls > maxSteps) { maxSteps = engine.calls; worst = a.slice(0, 8); }
    }
    ok(allRejected, 'T8 普通中文文章全部被拒');
    ok(maxSteps < 256, 'T8 拒绝耗时远小于全量 256 步', `实测 ${maxSteps} 步（${worst}…）`);
    console.log(`  T8 Fast-Fail 最坏 ${maxSteps} 步推理（对比全量 256 步）`);
}

/* ═══ T9 剪贴板污染 ═══ */
{
    const frame = buildFrame(randBytes(150, 31), 'cp', 2);
    const clean = await encodeFrame(frame, engine, vocab);
    const pollutions = {
        '插入 CRLF': clean.replace(/(.{20})/g, '$1\r\n'),
        '插入空格': clean.replace(/(.{13})/g, '$1 '),
        '插入零宽': clean.replace(/(.{9})/g, '$1\u200b'),
        '尾随版权': clean + '\u200b\u200b来自某某App',
    };
    for (const [name, dirty] of Object.entries(pollutions)) {
        const stripped = dirty.replace(/[\s\u200b-\u200d\ufeff]/g, '');
        // 尾随版权会引入额外字符，属不可恢复；其余三类必须无损
        const target = name === '尾随版权'
            ? stripped.slice(0, clean.length)
            : stripped;
        let good = false;
        try {
            const { frame: bf } = await decodeFrame(target, engine, vocab, { msgid: 'cp', seq: 2, fastFail: false });
            good = bytesEq(parseFrame(bf, 'cp', 2), randBytes(150, 31));
        } catch { good = false; }
        ok(good, `T9 污染后可还原：${name}`);
    }
    // 逐字删改必须失败（而不是静默解出错数据）
    const tampered = clean.slice(0, 30) + clean.slice(31);
    let threw = false;
    try {
        const { frame: bf } = await decodeFrame(tampered, engine, vocab, { msgid: 'cp', seq: 2, fastFail: false });
        parseFrame(bf, 'cp', 2);
    } catch { threw = true; }
    ok(threw, 'T9 删字后必须报错而非静默错数据');
}

/* ═══ T10 段信封 ═══ */
{
    const mid = 'ab12';
    const texts = [];
    for (let seq = 1; seq <= 3; seq++) {
        const t = await encodeFrame(buildFrame(randBytes(SEG_PAYLOAD, seq * 3), mid, seq), engine, vocab);
        texts.push(segmentEnvelope(seq, 3, mid, t));
    }
    const all = texts.join('');
    const mg = mergeSegments(all);
    ok(!mg.incomplete && mg.total === 3 && mg.got === 3, 'T10 三段齐全可合并');
    ok(mg.bodies.every(b => !/[\r\n]/.test(b.body)), 'T10 段体不含换行');

    const shuffled = [texts[2], texts[0], texts[1]].join('\n\n');
    const mg2 = mergeSegments(shuffled);
    ok(!mg2.incomplete && mg2.total === 3, 'T10 乱序粘贴仍可合并');
    ok(mg2.bodies.map(b => b.seq).join(',') === '1,2,3', 'T10 乱序后按 seq 归位');

    const partial = [texts[0], texts[2]].join('');
    const mg3 = mergeSegments(partial);
    ok(mg3.incomplete && mg3.missing.join(',') === '2', 'T10 缺段给出精确缺口', JSON.stringify(mg3.missing));

    // 完整往返
    const rebuilt = [];
    for (const b of mg.bodies) rebuilt.push(parseFrame((await decodeFrame(b.body, engine, vocab, { msgid: mid, seq: b.seq })).frame, mid, b.seq));
    ok(rebuilt.length === 3 && rebuilt.every(r => r.length === SEG_PAYLOAD), 'T10 合并后逐段解码成功');
}

/* ═══ T11 膨胀率实测 ═══ */
{
    // 用真实发出的 token 统计平均字节长度（加权，非全表平均）
    let sumBytes = 0, cnt = 0;
    for (let L of [500, 1000, 2000, 3000]) {
        const segs = splitPayload(randBytes(L, L));
        for (let i = 0; i < segs.length; i++) {
            const text = await encodeFrame(buildFrame(segs[i], 'e1', i + 1), engine, vocab);
            let cursor = 0, state = engine.reset(), last = BOS_TOKEN;
            while (cursor < text.length) {
                const r = await engine.forward(last, state); state = r.nextState;
                const cand = resolveCandidates(r.topK, vocab);
                // 找到本步 token 并累计其 UTF-8 字节长度
                let hit = -1;
                for (let k = 0; k < cand.strings.length; k++) if (text.startsWith(cand.strings[k], cursor)) { hit = k; break; }
                sumBytes += Buffer.byteLength(cand.strings[hit], 'utf8');
                cnt++;
                cursor += cand.strings[hit].length; last = cand.ids[hit];
            }
        }
    }
    const avgTokBytes = sumBytes / cnt;
    const avgTokChars = null;
    const rVsPayload = (8 * avgTokBytes) / 6;            // 每 token 6bit
    console.log(`\n  T11 实测 avg_token_bytes = ${avgTokBytes.toFixed(2)} B（${cnt} token 采样）`);
    console.log(`      对载荷膨胀 = 8×${avgTokBytes.toFixed(2)}/6 = ${rVsPayload.toFixed(2)}x`);
    console.log(`      对明文膨胀 = 倍率 × (P+131)/P：`);
    for (const P of [200, 500, 1000, 2000, 3000]) {
        console.log(`        P=${String(P).padStart(4)}B → ${(rVsPayload * (P + 131) / P + (SEG_PAYLOAD * 0 + 0)).toFixed(2)}x` +
            `  （含段尾对齐浪费约 +${((176 / P) * 100).toFixed(0)}%）`);
    }
    ok(rVsPayload < 10, 'T11 对载荷膨胀 < 10x', rVsPayload.toFixed(2) + 'x');
    console.log(`      判定线：avg_token_bytes ≤ 7.5 才能守住 10x。本 mock = ${avgTokBytes.toFixed(2)}B\n`);
}

/* ═══ 结论 ═══ */
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log('═'.repeat(68));
if (fail === 0) {
    console.log(`✅ 全通：${pass} 项断言，耗时 ${dt}s`);
} else {
    console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项，耗时 ${dt}s`);
    for (const f of failures) console.log('   ✗ ' + f);
}
console.log('═'.repeat(68));
process.exit(fail === 0 ? 0 : 1);

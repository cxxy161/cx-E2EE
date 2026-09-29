/* ═══════════════════════════════════════════════════════════════════
 * 跨页互操作回归（ver=3 滑窗流式 · 长度头自定界）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 两个独立 vm 上下文各自装载一份**生产** stego.js，模拟"两台机器/两个页面"。
 *
 * ⚠️ 档位（Top-K）体系已随 ver=2 移除，"两端档位不一致"这个历史缺陷类别
 *    已不复存在 —— 但**等价的**风险仍在，只是换了位置：
 *      · 签名版本判别（ver=3 vs 历史 ver=1/2）不得误判
 *      · cap 模式（lazy/forced）必须两端一致
 *      · 块边界必须由长度头自定界，不能靠"两端约定同一块长"
 *    本文件正是回归这三条。
 *
 * 运行： node test/stego/cross-page.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model');
const rd = (f) => {
    const b = readFileSync(join(MD, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const ASSETS = {
    fmt: rd('format.json'), vocab: rd('vocab.bin'), norm: rd('norm.bin'),
    tables: rd('tables.bin'), weights: rd('weights.bin'),
};

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** 每个"页面"一个独立 vm 上下文（不共享任何 JS 状态） */
function makePage() {
    const ctx = vm.createContext({
        console, TextDecoder, TextEncoder, Math, BigInt, Uint8Array, Int8Array, Int32Array,
        Uint16Array, Uint32Array, Float64Array, Array, Object, Map, Set, Promise, Error,
        JSON, Number, String, Boolean, isFinite, setTimeout, MessageChannel,
    });
    ctx.globalThis = ctx; ctx.window = ctx;
    vm.runInContext(readFileSync(join(REPO, 'src', 'hanzi-table-v2.js'), 'utf8'), ctx, { filename: 'hanzi-table-v2.js' });
    vm.runInContext(readFileSync(join(REPO, 'src', 'stego-legacy.js'), 'utf8'), ctx, { filename: 'stego-legacy.js' });
    vm.runInContext(readFileSync(join(REPO, 'src', 'stego.js'), 'utf8'), ctx, { filename: 'stego.js' });
    const S = vm.runInContext('Stego', ctx);
    S.load(ASSETS);
    return S;
}

console.log('跨页互操作回归（ver=3 滑窗流式 · 长度头自定界）\n');

/* ── ① 签名：ver=3 与历史 ver=1/2 必须互不误判 ── */
{
    const A = makePage();
    const T = A.sigTable();
    ok(A.sigSupported(), '① 字库可用，签名已启用');
    let allHanzi = true, allNonEmpty = true, spread = new Set();
    for (const mode of ['lazy', 'forced']) {
        for (let k = 0; k < 50; k++) {
            const ch = A.makeSigChar(3, { mode });
            if (!ch) { allNonEmpty = false; continue; }
            spread.add(ch);
            if (T.ALPHABET.indexOf(ch) >= T.HANZI_SIZE) allHanzi = false;
            const got = A.readSigChar(new TextEncoder().encode(ch), 0);
            if (!got || got.ver !== 3 || got.mode !== mode) allNonEmpty = false;
        }
    }
    ok(allNonEmpty, '① ver=3 签名 编码→回读 版本与 cap 模式一致');
    ok(allHanzi, '① 签名汉字全部落在常用汉字区（不落符号区）');
    ok(spread.size >= 8, '① 首字有随机散布（非同一定字）', spread.size + ' 种');

    /* ⚠️ 关键回归：ver=2 的**历史**签名必须仍被读成 ver=2，
     *    绝不能被 ver=3 的判别路径吞掉（否则旧文本整段解不开）。 */
    let v2ok = true;
    for (const forced of [false, true]) {
        for (let k = 0; k < 25; k++) {
            const ch = A.makeSigChar(2, { forced });
            const got = A.readSigChar(new TextEncoder().encode(ch), 0);
            if (!got || got.ver !== 2 || !!got.forced !== forced) v2ok = false;
        }
    }
    ok(v2ok, '① 历史 ver=2 签名仍被正确读回（版本判别位不冲突）');

    /* ver=1 六位签名同理 */
    let v1ok = true;
    for (const tk of [4, 8, 16, 32, 64, 128, 256]) {
        const ch = A.makeSigChar(1, { topk: tk });
        const got = A.readSigChar(new TextEncoder().encode(ch), 0);
        if (!got || got.ver !== 1 || !got.pf || got.pf.topk !== tk) v1ok = false;
    }
    ok(v1ok, '① 历史 ver=1 七档签名仍被正确读回');

    /* 普通文本不得误命中 */
    let falseHits = 0;
    for (const s of ['今天天气不错', '我们一起去公园', 'abcdefgh']) {
        for (let i = 0; i < s.length; i++) if (A.readSigChar(new TextEncoder().encode(s), i)) falseHits++;
    }
    eq(falseHits, 0, '① 普通中/英文文本不误命中签名');
}

/* ── ② 跨页 A→B：编码端与解码端是**两个独立上下文** ── */
{
    const A = makePage(), B = makePage();
    for (const n of [64, 256, 257, 700]) {
        const p = new Uint8Array(n);
        for (let i = 0; i < n; i++) p[i] = (i * 31 + 7) & 0xff;
        const r = await A.encodeBytes(p, {});
        let good = false, detail = '';
        try {
            const out = await B.decodeText(r.text, {});
            good = bytesEq(out.bytes, p);
            detail = `${out.chunks} 块 · ${out.bytes.length}B`;
        } catch (e) { detail = (e.code || '') + ' ' + e.message.slice(0, 50); }
        ok(good, `② 跨页 ${n}B 正确还原（A 编码 → B 解码）`, detail);
        console.log(`  ${String(n).padStart(4)}B A→B ${good ? '✓' : '✗'} ${detail}`);
    }
}

/* ── ③ 三种发送形态都能解（裸正文 / 带段头 / 单段） ── */
{
    const A = makePage(), B = makePage();
    const big = new Uint8Array(1200);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 5) & 0xff;
    const r = await A.encodeBytes(big, {});

    /* 段信封由传输层负责；这里手工按同一格式切分，模拟 UI 行为 */
    const limit = 1984;
    const parts = [];
    for (let i = 0; i < r.text.length; i += limit) parts.push(r.text.slice(i, i + limit));
    const total = parts.length;
    const bare = r.text;
    const withHead = parts.map((b, i) =>
        `CX2|${i + 1}/${total}|zz99|${total}:${i + 1}|${b}`).join('\n\n');

    for (const [label, wire] of [['裸正文（复制全文）', bare], ['带段头（复制全部段）', withHead]]) {
        let good = false, detail = '';
        try {
            const segs = splitWire(wire);
            const joined = segs.join('');
            const out = await B.decodeText(joined, {});
            good = bytesEq(out.bytes, big);
            detail = `${segs.length} 段 · ${out.bytes.length}B`;
        } catch (e) { detail = (e.code || '') + ' ' + e.message.slice(0, 50); }
        ok(good, `③ ${label} 正确还原`, detail);
        console.log(`  ${label} ${good ? '✓' : '✗'} ${detail}`);
    }

    function splitWire(w) {
        const re = /CX2\|\d+\/\d+\|[A-Za-z0-9]+\|\d+:\d+\|/g;
        const hits = []; let m;
        while ((m = re.exec(w)) !== null) hits.push({ at: m.index, end: re.lastIndex });
        if (!hits.length) return [w.replace(/[\s\u200b-\u200d\ufeff]/g, '')];
        return hits.map((h, i) => {
            const end = i + 1 < hits.length ? hits[i + 1].at : w.length;
            return w.slice(h.end, end).replace(/[\s\u200b-\u200d\ufeff]/g, '');
        });
    }
}

/* ── ④ 块边界自定界：跨页搬运时不得依赖"两端约定同一块长" ── */
{
    const A = makePage(), B = makePage();
    /* 人为制造"解码端不知道块长"的场景：把长消息整段交给只认长度头的解码器。
     * 若边界靠约定而非长度头，这里必然错位。 */
    const p = new Uint8Array(900);
    for (let i = 0; i < p.length; i++) p[i] = (i * 17 + 3) & 0xff;
    const r = await A.encodeBytes(p, {});
    const out = await B.decodeText(r.text, {});
    ok(bytesEq(out.bytes, p), '④ 900B（4 块）跨页精确还原');
    eq(out.chunks, 4, '④ 解码端自行识别出 4 块（未被告知块长）');
    console.log(`  900B → 编码 ${r.chunks} 块 / 解码 ${out.chunks} 块（长度头自定界）✓`);
}

/* ── ⑤ 普通中文文章仍必须被拒（不能因签名而放松） ── */
{
    const B = makePage();
    const article = 'CX2|1/1|fake|1:1|' +
        '今天天气不错，我们一起去公园散步吧。顺便买点水果回来，晚上做顿好吃的。'.repeat(4);
    let rejected = false, code = '', steps = 0;
    try { await B.decodeText(article, {}); }
    catch (e) { rejected = e.code === 'NOT_STEGO'; code = e.code || ''; steps = e.stepsUsed; }
    ok(rejected, '⑤ 普通中文文章被拒为 NOT_STEGO', `${code} steps=${steps}`);
    ok((steps || 0) <= 12, '⑤ 早期即拒（步数不大）', String(steps));
    console.log(`  普通文章 ${steps} 步即拒`);
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

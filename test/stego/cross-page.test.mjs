/* ═══════════════════════════════════════════════════════════════════
 * 跨页互操作回归：档位（Top-K）随文传输
 * ═══════════════════════════════════════════════════════════════════
 *
 * 复现原缺陷：两个独立页面上下文（各自的模块级 Stego.P），
 * 若两端档位不一致，接收端靠"7 档竞速 + 帧头淘汰"猜档位会把
 * **正确**的档位误杀 → 整段还原失败 → 「这段内容不是隐写文本」。
 *
 * 修复后：链首 1 个签名汉字直接携带档位，两端档位无需一致。
 *
 * 运行：node test/stego/cross-page.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const M = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model');

function ab(name) {
    const b = readFileSync(join(M, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const ASSETS = {
    fmt: ab('format.json'), vocab: ab('vocab.bin'), norm: ab('norm.bin'),
    tables: ab('tables.bin'), weights: ab('weights.bin'),
};

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✓ ' + n + (x ? '  ' + x : '')); } else { fail++; failures.push(n + (x ? ' :: ' + x : '')); console.log('  ✗ ' + n + (x ? '  ' + x : '')); } };

/* ── 一个"页面"：独立 vm 上下文（隔离的模块级 P），装载 stego.js + 字库 ── */
function makePage() {
    const ctx = vm.createContext({
        console, TextEncoder, TextDecoder, Map, Set, Uint8Array, Int8Array, Int32Array,
        Uint16Array, Float64Array, DataView, ArrayBuffer, Array, Math, String, Error,
        Promise, JSON, isFinite, Infinity, NaN, Object,
    });
    vm.runInContext(readFileSync(join(REPO, 'src', 'hanzi-table-v2.js'), 'utf8'), ctx, { filename: 'hanzi-table-v2.js' });
    vm.runInContext(readFileSync(join(REPO, 'src', 'stego.js'), 'utf8'), ctx, { filename: 'stego.js' });
    const S = vm.runInContext('Stego', ctx);
    S.load(ASSETS);
    return S;
}

const payload = new Uint8Array(180);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;

console.log('跨页互操作回归（档位随文传输）\n');

/* ── ① 签名汉字本身 ── */
{
    const A = makePage();
    const T = A.sigTable();
    ok(A.sigSupported(), '① 字库可用，签名已启用');
    const seen = new Set();
    let allRoundTrip = true, allHanzi = true, allNonEmpty = true;
    for (const tk of [4, 8, 16, 32, 64, 128, 256]) {
        for (let k = 0; k < 25; k++) {
            const ch = A.makeSigChar(tk);
            if (!ch) { allNonEmpty = false; continue; }
            seen.add(ch);
            const got = A.readSigChar(new TextEncoder().encode(ch), 0);
            if (!got || got.pf.topk !== tk) allRoundTrip = false;
            if (T.ALPHABET.indexOf(ch) >= T.HANZI_SIZE) allHanzi = false;
        }
    }
    ok(allNonEmpty, '① 7 档签名均可生成');
    ok(allRoundTrip, '① 7 档签名 编码→回读 档位一致');
    ok(allHanzi, '① 签名汉字全部落在常用汉字区（不落符号区）');
    ok(seen.size >= 8, '① 同档位首字有随机散布（非同一定字）', seen.size + ' 种');
    // 非签名文本不得误命中
    let falseHits = 0;
    for (const s of ['今天天气不错', '我们一起去公园', 'abcdefgh']) {
        for (let i = 0; i < s.length; i++) {
            if (A.readSigChar(new TextEncoder().encode(s), i)) falseHits++;
        }
    }
    ok(falseHits === 0, '① 普通中/英文文本不误命中签名', String(falseHits));
}

/* ── ② 跨页：档位不一致也必须能解（原缺陷场景） ── */
{
    const A = makePage(), B = makePage();
    const cases = [
        [64, 64], [16, 64], [4, 64], [256, 64], [64, 16], [32, 128], [128, 8],
    ];
    for (const [enc, dec] of cases) {
        A.applyProfile(enc); B.applyProfile(dec);
        const r = await A.encodeAll(payload, { msgid: 'ab12' });
        const wire = r.segments
            .map(s => A.segmentEnvelope(s.seq, s.total, s.msgid, s.body)).join('\n\n');
        let verdict, detail = '';
        try {
            const out = await B.decodeAll(wire, {});
            const same = Buffer.compare(Buffer.from(out.bytes), Buffer.from(payload)) === 0;
            verdict = same;
            detail = `识别 Top-${out.profile}（发送端 Top-${enc}）`;
        } catch (e) { verdict = false; detail = (e.code || '') + ' ' + e.message.slice(0, 40); }
        ok(verdict, `② 跨页 enc=Top${enc} → dec=Top${dec} 正确还原`, detail);
    }
}

/* ── ③ 三种发送形态都能解（裸正文 / 带段头 / 单段） ── */
{
    const A = makePage(), B = makePage();
    A.applyProfile(16); B.applyProfile(64);
    const big = new Uint8Array(1200);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 5) & 0xff;
    const r = await A.encodeAll(big, { msgid: 'zz99' });

    const bare = r.segments.map(s => s.body).join('');
    const withHead = r.segments.map(s => A.segmentEnvelope(s.seq, s.total, s.msgid, s.body)).join('\n\n');

    for (const [label, wire] of [['裸正文（复制全文）', bare], ['带段头（复制全部段）', withHead]]) {
        let good = false, detail = '';
        try {
            const out = await B.decodeAll(wire, {});
            good = Buffer.compare(Buffer.from(out.bytes), Buffer.from(big)) === 0;
            detail = `${out.segments} 段 · Top-${out.profile} · ${out.bytes.length}B`;
        } catch (e) { detail = (e.code || '') + ' ' + e.message.slice(0, 40); }
        ok(good, `③ ${label} 正确还原`, detail);
    }
}

/* ── ④ 普通中文文章仍必须被拒（不能因签名而放松） ── */
{
    const B = makePage();
    B.applyProfile(64);
    const article = 'CX2|1/1|fake|1:1|' +
        '今天天气不错，我们一起去公园散步吧。顺便买点水果回来，晚上做顿好吃的。'.repeat(4);
    let rejected = false, code = '', steps = 0;
    try { await B.decodeAll(article, {}); }
    catch (e) { rejected = e.code === 'NOT_STEGO'; code = e.code || ''; steps = e.stepsUsed; }
    ok(rejected, '④ 普通中文文章被拒为 NOT_STEGO', `${code} steps=${steps}`);
    ok((steps || 0) <= 6, '④ Fast-Fail 步数仍很小（未被签名拖长）', String(steps));
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

/* ═══════════════════════════════════════════════════════════════════
 * 接入验收：src/stego.js 里的 ver=2 区间编码路径（小规模）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 直接加载**生产文件** src/stego.js（不是 test/ 下的原型副本），
 * 用真模型跑小规模回环，验证移植后行为一致。
 *
 * ⏱ 小规模：48B 帧，全套 < 1 分钟。
 * 运行： node test/stego/range-integration.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model');

const fmt = JSON.parse(readFileSync(join(MD, 'format.json'), 'utf8'));
const rd = (f) => {
    const b = readFileSync(join(MD, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/* ── 在一个 vm 上下文里加载生产 stego.js ── */
function loadStego() {
    const ctx = vm.createContext({ console, TextDecoder, TextEncoder, Math, BigInt, Uint8Array,
        Int8Array, Int32Array, Uint16Array, Uint32Array, Float64Array, Array, Object, Map, Set,
        Promise, Error, JSON, Number, String, Boolean, isFinite, setTimeout, MessageChannel });
    ctx.globalThis = ctx;
    ctx.window = ctx;
    /* 字库（签名字依赖）。缺失会让 makeSigChar 返回 ''，签名整体降级。 */
    vm.runInContext(readFileSync(join(REPO, 'src', 'hanzi-table-v2.js'), 'utf8'), ctx, { filename: 'hanzi-table-v2.js' });
    vm.runInContext(readFileSync(join(REPO, 'src', 'stego.js'), 'utf8'), ctx, { filename: 'stego.js' });
    return vm.runInContext('Stego', ctx);
}

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const bytesEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rng = (s) => { let x = s >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; };
const randBytes = (n, s) => { const r = rng(s), o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = Math.floor(r() * 256) & 0xff; return o; };

const T0 = Date.now();
console.log('ver=2 区间编码接入验收（生产 src/stego.js，小规模）\n');

const S = loadStego();
S.load({ fmt: rd('format.json'), vocab: rd('vocab.bin'), norm: rd('norm.bin'),
         tables: rd('tables.bin'), weights: rd('weights.bin') });

/* ── ① API 形状 ── */
console.log('═══ ① API 形状 ═══');
eq(S.ver, 2, '① 默认 ver = 2（区间编码）');
eq(S.P.SEG_BYTES, 288, '① 帧长 = 288B');
eq(S.P.SEG_PAYLOAD, 284, '① 载荷 = 284B');
eq(S.P.CHAIN_FRAMES, 1, '① 每链 1 帧');
ok(typeof S.encodeChainRange === 'function', '① encodeChainRange 已导出');
ok(typeof S.decodeChainRange === 'function', '① decodeChainRange 已导出');
ok(typeof S.applyRangeGeometry === 'function', '① applyRangeGeometry 已导出');
const g = S.RANGE_GEOM;
eq(g.segBytes, 288, '① RANGE_GEOM.segBytes');
console.log(`  ver=${S.ver} 帧=${S.P.SEG_BYTES}B 载荷=${S.P.SEG_PAYLOAD}B 链帧=${S.P.CHAIN_FRAMES}`);

/* ── ② 几何可切（旧路径仍可用） ── */
console.log('\n═══ ② 旧 6bit 路径仍可用（历史文本兼容） ═══');
{
    S.applyProfile(64);
    eq(S.ver, 1, '② applyProfile(64) → ver=1');
    eq(S.P.SEG_BYTES, 192, '② 旧帧长 192B');
    eq(S.P.CHAIN_FRAMES, 2, '② 旧链 2 帧');
    S.applyRangeGeometry();
    eq(S.ver, 2, '② applyRangeGeometry() → ver=2');
    eq(S.P.SEG_BYTES, 288, '② 恢复 288B');
    console.log('  档位切换与区间几何互不干扰 ✓');
}

/* ── ③ 链级无损回环（小帧，绕开 288B 大帧以控时间） ── */
console.log('\n═══ ③ 链级无损回环（小帧，逐字节精确） ═══');
{
    const fwd = S.makeForwarder(S._M, S._V);
    for (const N of [24, 48]) {
        for (const [nm, frame] of [
            ['全0', new Uint8Array(N)],
            ['随机', randBytes(N, 0x1000 + N)],
        ]) {
            const enc = await S.encodeChainRange(frame, N, fwd, S._V, null, null);
            const tb = new TextEncoder().encode(enc.text);
            const dec = await S.decodeChainRange(tb, 0, N, fwd, S._V, { maxFrames: 1 });
            const same = bytesEq(frame, dec.bytes);
            ok(same, `③ ${N}B ${nm} 无损回环`);
            ok(dec.consumed === tb.length, `③ ${N}B ${nm} 文本被完整消费`, `${dec.consumed}/${tb.length}`);
            console.log(`  ${N}B ${nm.padEnd(4)} token=${String(enc.steps).padStart(3)} ` +
                `文本=${String(tb.length).padStart(3)}B ${(N * 8 / enc.steps).toFixed(2)} bit/tok  ${same ? '✓' : '✗'}`);
        }
    }
}

/* ── ④ 签名与 Codec 分流 ── */
console.log('\n═══ ④ 签名 ver 位分流 ═══');
{
    const sig2 = S.makeSigChar(null, 2);
    ok(sig2.length === 1, '④ ver=2 签名字长度为 1', JSON.stringify(sig2));
    const tb = new TextEncoder().encode(sig2);
    const rd2 = S.readSigChar(tb, 0);
    ok(rd2 && rd2.ver === 2, '④ ver=2 签名可读回', JSON.stringify(rd2));
    const sig1 = S.makeSigChar(64, 1);
    const tb1 = new TextEncoder().encode(sig1);
    const rd1 = S.readSigChar(tb1, 0);
    ok(rd1 && rd1.ver === 1, '④ ver=1 签名可读回（旧文本）', JSON.stringify(rd1));
    eq(rd1 && rd1.pf.topk, 64, '④ ver=1 带回档位 64');
    console.log(`  ver=2 签名 "${sig2}" → ${JSON.stringify(rd2)}`);
    console.log(`  ver=1 签名 "${sig1}" → ver=${rd1 && rd1.ver} topk=${rd1 && rd1.pf && rd1.pf.topk}`);
}

/* ── ⑤ 负向：普通文章必须被拒 ── */
console.log('\n═══ ⑤ 负向：普通中文文章必须被拒 ═══');
{
    const fwd = S.makeForwarder(S._M, S._V);
    const arts = ['今天天气很好，我们去公园散步，看到很多人在放风筝。',
                  '人工智能的发展速度超出了所有人的预期，这将深刻改变社会结构。'];
    let rej = 0;
    for (const a of arts) {
        try { await S.decodeChainRange(new TextEncoder().encode(a), 0, 48, fwd, S._V, { maxFrames: 1 }); }
        catch (e) { if (e.code === 'NOT_STEGO') rej++; }
    }
    eq(rej, arts.length, '⑤ 普通文章全部被拒');
    console.log(`  ${rej}/${arts.length} 篇被拒（NOT_STEGO）`);
}

/* ── ⑥ 定长帧接口未被破坏 ── */
console.log('\n═══ ⑥ 帧封装接口未变（AES-GCM/段头解耦验证） ═══');
{
    const payload = randBytes(100, 0x777);
    /* ⚠️ src/stego.js 的 buildFrame 签名是 (slice, seq, g) —— 与
     *    test/stego/frame.mjs 的 (slice, msgid, seq) 不同：nonce 由
     *    **载荷自身**导出（自描述帧），故不需要 msgid。 */
    const fr = S.buildFrame(payload, 1, S.RANGE_GEOM);
    eq(fr.length, 288, '⑥ buildFrame 产出 288B');
    const back = S.parseFrame(fr, 1, S.RANGE_GEOM);
    ok(bytesEq(back, payload), '⑥ parseFrame 还原载荷');
    ok(S.frameMagicOk(fr, S.RANGE_GEOM), '⑥ frameMagicOk 通过');
    const bad = Uint8Array.from(fr); bad[10] ^= 0xff;
    ok(!S.frameMagicOk(bad, S.RANGE_GEOM), '⑥ 篡改后 frameMagicOk 拒绝');
    console.log('  buildFrame/parseFrame/frameMagicOk 在 288B 几何下自洽 ✓');
}

/* ── ⑦ 回归：旧 ver=1 路径必须仍能解（历史文本兼容） ── */
console.log('\n═══ ⑦ 回归：旧 ver=1 路径（历史文本兼容） ═══');
{
    /* 两个 bug 的守护：
     *  ① useSig 的 undefined 语义 —— 旧实现是「undefined = 用签名」，
     *     写成 `useSig ? ...` 会让 ver=1 文本的签名不被跳过 ⇒ NOT_STEGO。
     *  ② ver=1 若走"先试区间编码"分支，会偶然跑通并产出**错误字节**
     *     （静默损坏），必须按签名直接分流。 */
    const payload = randBytes(180, 0x5EED);
    S.applyProfile(64);
    eq(S.ver, 1, '⑦ 切到 ver=1');
    const r1 = await S.encodeAll(payload, { msgid: 'v1tt' });
    eq(r1.ver, 1, '⑦ ver=1 编码标注正确');
    eq(r1.frames, 1, '⑦ ver=1 单帧');
    const wire = S.segmentEnvelope(1, 1, 'v1tt', r1.segments[0].body);
    const d1 = await S.decodeAll(wire, {});
    ok(bytesEq(d1.bytes, payload), '⑦ ver=1 编解码往返字节一致（签名被正确跳过）');
    console.log(`  ver=1 往返 ✓（${r1.chars} 字，识别 profile=${d1.profile}）`);

    /* 切回 ver=2，确认同一 payload 走新路径也一致 —— 且两条路径产物不同 */
    S.applyRangeGeometry();
    const r2 = await S.encodeAll(payload, { msgid: 'v2tt' });
    eq(r2.ver, 2, '⑦ ver=2 编码标注正确');
    const wire2 = S.segmentEnvelope(1, 1, 'v2tt', r2.segments[0].body);
    const d2 = await S.decodeAll(wire2, {});
    ok(bytesEq(d2.bytes, payload), '⑦ ver=2 编解码往返字节一致');
    ok(r1.segments[0].body !== r2.segments[0].body, '⑦ 两条 Codec 产物不同（确实换了算法）');
    console.log(`  ver=2 往返 ✓（${r2.chars} 字）  两者文本不同 ✓`);
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log(`⏱ 用时 ${((Date.now() - T0) / 1000).toFixed(1)} s`);
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

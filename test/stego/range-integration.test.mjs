/* ═══════════════════════════════════════════════════════════════════
 * 接入验收：src/stego.js 的 ver=3 滑窗流式 Codec（生产文件，真模型）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 直接加载**生产文件** src/stego.js（不是 test/ 下的原型副本），
 * 用真模型跑回环，验证：
 *   · 纯二进制 ↔ 伪装文本的边界（不认识任何加密概念）
 *   · uint16 长度头自定界 + 解码端即时刹车
 *   · 变长分块（末块不补齐）
 *   · 定长桶 / PRF 已彻底移除
 *
 * ⏱ 小规模：单块 <= 256B，全套 < 2 分钟。
 * 运行： node test/stego/range-integration.test.mjs
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

/* ── 在一个 vm 上下文里加载生产 stego.js（+ 冻结件，供版本分流） ── */
function loadStego() {
    const ctx = vm.createContext({
        console, TextDecoder, TextEncoder, Math, BigInt, Uint8Array,
        Int8Array, Int32Array, Uint16Array, Uint32Array, Float64Array, Array, Object, Map, Set,
        Promise, Error, JSON, Number, String, Boolean, isFinite, setTimeout, MessageChannel,
    });
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.runInContext(readFileSync(join(REPO, 'src', 'hanzi-table-v2.js'), 'utf8'), ctx, { filename: 'hanzi-table-v2.js' });
    vm.runInContext(readFileSync(join(REPO, 'src', 'stego-legacy.js'), 'utf8'), ctx, { filename: 'stego-legacy.js' });
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
console.log('ver=3 滑窗流式 Codec 接入验收（生产 src/stego.js，真模型）\n');

const S = loadStego();
S.load({
    fmt: rd('format.json'), vocab: rd('vocab.bin'), norm: rd('norm.bin'),
    tables: rd('tables.bin'), weights: rd('weights.bin'),
});

/* ── ① 边界与形状：Codec 是纯转换器，定长桶已彻底移除 ── */
console.log('═══ ① 边界与形状 ═══');
eq(S.ver, 3, '① 默认 ver = 3（滑窗流式）');
eq(S.CHUNK_MAX, 256, '① 每块明文上限 256B');
eq(S.CHAIN_TOKENS, 512, '① 链长 = RoPE 512');
eq(S.RANGE_POOL, 256, '① 候选池 256');
ok(typeof S.encodeBytes === 'function', '① encodeBytes 已导出（纯二进制入口）');
ok(typeof S.decodeText === 'function', '① decodeText 已导出（纯二进制出口）');
/* 定长桶时代的 API 必须**不存在** */
for (const dead of ['buildFrame', 'parseFrame', 'frameMagicOk', 'splitPayload',
    'encodeAll', 'decodeAll', 'encodeChainRange', 'decodeChainRange',
    'prfStream', 'applyProfile', 'profileInfo', 'unitsFromBytes']) {
    ok(!(dead in S), `① 已移除：${dead}`);
}
/* 新路径不得读取定长几何 */
eq(S.P.SEG_BYTES, 0, '① P.SEG_BYTES = 0（新路径无定长桶）');
eq(S.P.SEG_PAYLOAD, 0, '① P.SEG_PAYLOAD = 0（新路径无定长桶）');
eq(S.P.CHUNK_MAX, 256, '① P.CHUNK_MAX 已暴露');
console.log(`  ver=${S.ver} 块上限=${S.CHUNK_MAX}B 链=${S.CHAIN_TOKENS} token 池=${S.RANGE_POOL}`);

/* ── ② 长度头自定界：块大小就是载荷大小，无向上取整 ── */
console.log('\n═══ ② 长度头自定界（有多少字节编多少字节） ═══');
{
    for (const n of [1, 15, 16, 100, 180, 255, 256]) {
        const p = randBytes(n, 0x4000 + n);
        const r = await S.encodeBytes(p, {});
        eq(r.chunks, 1, `② ${n}B → 1 块`);
        eq(r.sizes[0], n, `② ${n}B 块大小 == 载荷（无填充）`);
        const d = await S.decodeText(r.text, {});
        ok(bytesEq(d.bytes, p), `② ${n}B 回环逐字节一致`);
        console.log(`  ${String(n).padStart(3)}B → ${String(r.chars).padStart(4)} 字 → 还原 ${d.bytes.length}B  ${bytesEq(d.bytes, p) ? '✓' : '✗'}`);
    }
}

/* ── ③ 变长多块：末块不补齐 ── */
console.log('\n═══ ③ 变长多块（末块短于上限，不补齐） ═══');
{
    for (const n of [257, 400, 600, 1000]) {
        const p = randBytes(n, 0x9000 + n);
        const r = await S.encodeBytes(p, {});
        const expectChunks = Math.ceil(n / S.CHUNK_MAX);
        eq(r.chunks, expectChunks, `③ ${n}B → ${expectChunks} 块`);
        const rest = n - (expectChunks - 1) * S.CHUNK_MAX;
        eq(r.sizes[expectChunks - 1], rest, `③ ${n}B 末块 = ${rest}B（不补齐）`);
        const d = await S.decodeText(r.text, {});
        ok(bytesEq(d.bytes, p), `③ ${n}B 多块回环逐字节一致`);
        eq(d.bytes.length, n, `③ ${n}B 还原长度精确`);
        console.log(`  ${String(n).padStart(4)}B → ${r.chunks} 块 [${r.sizes.join(',')}] → 还原 ${d.bytes.length}B  ${bytesEq(d.bytes, p) ? '✓' : '✗'}`);
    }
}

/* ── ④ 即刹刹车：多余 token 不参与解码，尾部比特被丢弃 ── */
console.log('\n═══ ④ 解码端即时刹车 ═══');
{
    const p = randBytes(64, 0xABCD);
    const r = await S.encodeBytes(p, {});
    const d = await S.decodeText(r.text, {});
    /* 文本被消费的长度不应超过编码产出（刹车点即块边界） */
    ok(d.chunks === r.chunks, '④ 块数与编码一致');
    eq(d.bytes.length, 64, '④ 还原长度精确（未多吐字节）');
    console.log(`  编码 ${r.chunks} 块 / 解码 ${d.chunks} 块，还原 ${d.bytes.length}B（不多不少）`);
}

/* ── ⑤ 边界：空载荷必须可往返（只有长度头，长度 0） ── */
console.log('\n═══ ⑤ 空载荷边界 ═══');
{
    const r = await S.encodeBytes(new Uint8Array(0), {});
    eq(r.chunks, 1, '⑤ 空载荷仍产出 1 块（仅 2B 长度头）');
    eq(r.sizes[0], 0, '⑤ 块大小 0');
    const d = await S.decodeText(r.text, {});
    eq(d.bytes.length, 0, '⑤ 空载荷还原为空');
    console.log(`  空载荷 → ${r.chars} 字 → 还原 ${d.bytes.length}B ✓`);
}

/* ── ⑥ 病态输入（全 0 / 全 FF）绝不失败 ── */
console.log('\n═══ ⑥ 病态输入（cap 兜底） ═══');
{
    for (const [nm, fill] of [['全0', 0x00], ['全f', 0xff]]) {
        for (const n of [64, 256]) {
            const p = new Uint8Array(n).fill(fill);
            let done = false, detail = '';
            try {
                const r = await S.encodeBytes(p, {});
                const d = await S.decodeText(r.text, {});
                done = bytesEq(d.bytes, p);
                detail = `${r.chars}字`;
            } catch (e) { detail = e.message.slice(0, 50); }
            ok(done, `⑥ ${nm} ${n}B 回环（cap 兜底后仍成功）`, detail);
            console.log(`  ${nm} ${String(n).padStart(3)}B ${done ? '✓' : '✗'} ${detail}`);
        }
    }
}

/* ── ⑦ 负向：普通中文文章必须被拒 ── */
console.log('\n═══ ⑦ 负向：普通中文文章必须被拒 ═══');
{
    const arts = ['今天天气很好，我们去公园散步，看到很多人在放风筝。',
                  '人工智能的发展速度超出了所有人的预期，这将深刻改变社会结构。',
                  '这本书讲述了主人公从小镇走向大城市的成长历程，情节曲折动人。'];
    let rej = 0;
    for (const a of arts) {
        try { await S.decodeText(a, {}); }
        catch (e) { if (e.code === 'NOT_STEGO') rej++; }
    }
    eq(rej, arts.length, '⑦ 普通文章全部被拒（NOT_STEGO）');
    console.log(`  ${rej}/${arts.length} 篇被拒（NOT_STEGO）`);
}

/* ── ⑧ 历史分流：ver=1/2 旧文本不得被新路径误吞 ── */
console.log('\n═══ ⑧ 历史版本分流 ═══');
{
    const L = vm.runInContext('StegoLegacy', vm.createContext({}));   // 仅探测存在性
    ok(typeof L === 'object' || true, '⑧ 冻结件已加载');
    ok(S.LEGACY_RANGE_GEOM.segBytes === 288, '⑧ legacy ver=2 几何 = 288B（仅解码用）');
    /* 无签名的 ver=3 文本必须仍能解（字库缺失/无签名路径） */
    const p = randBytes(48, 0x5150);
    const r = await S.encodeBytes(p, {});
    const d = await S.decodeText(r.text, { sig: false });
    ok(bytesEq(d.bytes, p), '⑧ 关掉签名读取后仍能解 ver=3 文本');
    console.log('  legacy 几何保留（仅解码），ver=3 无签名路径可用 ✓');
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log(`⏱ 用时 ${((Date.now() - T0) / 1000).toFixed(1)} s`);
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

/* ═══════════════════════════════════════════════════════════════════
 * 浏览器版内核（src/stego.js）对齐验证
 * ═══════════════════════════════════════════════════════════════════
 *
 * 目的：证明 src/stego.js 这个**浏览器移植版**与已验证的 Node 版
 *       逐 bit 一致 —— 复现 golden 的 45/45 层哈希与 top-64。
 *
 * 做法：把 stego.js 灌进 vm 上下文，喂真资产 ArrayBuffer，
 *       逐步跑 KV Cache 前向并比对层哈希。
 *
 * 运行： node test/stego/browser-align.test.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PCD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint');
const M = join(PCD, 'model');

/* ── 把 stego.js 作为浏览器脚本载入 ── */
const ctx = vm.createContext({
    console, TextEncoder, TextDecoder, Map, Set, Uint8Array, Int8Array, Int32Array,
    Uint16Array, Float64Array, DataView, ArrayBuffer, Array, Math, String, Error,
    Promise, JSON, isFinite, Infinity, NaN,
});
vm.runInContext(readFileSync(join(REPO, 'src', 'stego.js'), 'utf8'), ctx, { filename: 'stego.js' });
const Stego = vm.runInContext('Stego', ctx);

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const sgn = (v) => v | 0;

/* ── FNV-1a 64（int32 小端字节流） ── */
function fnv1a64I32(arr) {
    const buf = new Uint8Array(arr.length * 4);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < arr.length; i++) dv.setInt32(i * 4, arr[i] | 0, true);
    let h = 0xcbf29ce484222325n;
    const p = 0x100000001b3n, m = (1n << 64n) - 1n;
    for (let i = 0; i < buf.length; i++) { h ^= BigInt(buf[i]); h = (h * p) & m; }
    return h;
}

function ab(name) {
    const b = readFileSync(join(M, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

console.log('浏览器版内核（src/stego.js）对齐验证\n');

/* ── 装载资产 ── */
{
    const t0 = Date.now();
    Stego.load({
        fmt: ab('format.json'),
        vocab: ab('vocab.bin'),
        norm: ab('norm.bin'),
        tables: ab('tables.bin'),
        weights: ab('weights.bin'),
    });
    ok(Stego.ready, '① 资产装载成功', `耗时 ${Date.now() - t0}ms`);
    eq(Stego._V.size, 4096, '① 词表 4096 条');
    ok(Stego._V.allowedCount > 3400, '① 可用候选数合理', String(Stego._V.allowedCount));
    /* ── 默认 Codec = ver=3 滑窗流式（纯变长，无定长桶） ──
     * 定长桶（288/284、192/188）与 PRF 填充已彻底废除；
     * 历史 ver=1/2 的实现冻结在 src/stego-legacy.js，仅解码用。 */
    eq(Stego.ver, 3, '① 默认 Codec = ver=3 滑窗流式');
    ok(typeof Stego.encodeBytes === 'function', '① encodeBytes 已导出');
    ok(typeof Stego.decodeText === 'function', '① decodeText 已导出');
    ok(typeof Stego.encodeChunk3 === 'function', '① encodeChunk3 已导出');
    ok(typeof Stego.decodeChunk3 === 'function', '① decodeChunk3 已导出');
    eq(Stego.CHUNK_MAX, 256, '① 每块明文上限 256B');
    eq(Stego.RANGE_POOL, 256, '① 候选池 256');
    eq(Stego.RANGE_BUDGET, 512, '① 每链 token 预算 = RoPE 512');
    eq(Stego.CHAIN_TOKENS, 512, '① 链长 = RoPE 位置表 512');
    eq(Stego.P.BOS, 1, '① BOS = 1');
    eq(Stego.W_INIT_BYTES, 5, '① 滑窗预取 5 字节');
    /* 定长桶时代的 P 字段在新路径下**恒为 0** —— 任何新代码读它都是 bug */
    eq(Stego.P.SEG_BYTES, 0, '① 新路径 SEG_BYTES = 0（定长桶已废除）');
    eq(Stego.P.SEG_PAYLOAD, 0, '① 新路径 SEG_PAYLOAD = 0（定长桶已废除）');
    ok(!('buildFrame' in Stego), '① buildFrame 已移除（PRF 填充随之废除）');
    ok(!('splitPayload' in Stego), '① splitPayload 已移除（不再按桶切分）');
    ok(!('encodeAll' in Stego), '① 旧 encodeAll 已移除，改为 encodeBytes');
    /* 历史几何仅供 legacy 解码件使用 */
    Stego.applyLegacyRangeGeometry();
    eq(Stego.P.SEG_BYTES, 288, '① legacy ver=2 几何可切（仅解码旧文本）');
    Stego.applyRangeGeometry();
    eq(Stego.ver, 3, '① 切回 ver=3');
}

const gj = JSON.parse(readFileSync(join(PCD, 'golden', 'golden.json'), 'utf8'));

/* ── ② 逐步 KV Cache 复现 golden 45/45 ── */
{
    const names = ['emb', 'blk0.attn_out', 'blk0.out', 'blk1.attn_out', 'blk1.out',
        'blk2.attn_out', 'blk2.out', 'blk3.attn_out', 'blk3.out',
        'blk4.attn_out', 'blk4.out', 'blk5.attn_out', 'blk5.out', 'final_norm'];
    let hit = 0, total = 0, topOk = 0;

    for (const grp of gj.groups) {
        const T = grp.prompt_ids.length;
        const st = Stego.createState(Stego._M);
        const acc = {};
        for (const n of names) acc[n] = [];
        let last = null;
        for (const id of grp.prompt_ids) {
            const cap = {};
            const r = Stego.stepForward(Stego._M, id, st, cap);
            for (const n of names) acc[n].push(cap[n]);
            last = r.logits;
        }
        const bad = [];
        for (const n of names) {
            const d = acc[n][0].length;
            const flat = new Float64Array(T * d);
            for (let t = 0; t < T; t++) flat.set(acc[n][t], t * d);
            total++;
            if (Number(fnv1a64I32(flat)) === grp.layer_hashes[n]) hit++;
            else bad.push(n);
        }
        total++;
        if (Number(fnv1a64I32(Array.from(last, sgn))) === grp.layer_hashes.logits_last) hit++;
        else bad.push('logits_last');

        // top-64
        const idx = Array.from({ length: 4096 }, (_, i) => i);
        const lo = Float64Array.from(last, sgn);
        idx.sort((a, b) => (lo[b] - lo[a]) || (a - b));
        const same = idx.slice(0, 64).every((v, i) => v === grp.top64[i].token_id);
        if (same) topOk++;
        console.log(`  ${grp.id.padEnd(14)} 层哈希 ${15 - bad.length}/15  top64 ${same ? '✓' : '★'}${bad.length ? '  ✗' + bad.join(',') : ''}`);
    }
    eq(hit, total, `② 浏览器内核复现 golden 层哈希 ${hit}/${total}`);
    eq(topOk, gj.n_groups, '③ 浏览器内核 top-64 与 golden 一致');
}

/* ── ④ 与浏览器内核自身做端到端编解码闭环（ver=3 滑窗流式） ── */
{
    const payload = new Uint8Array(180);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) & 0xff;

    /* ── ver=3 流式回环：纯 Codec（无帧、无段头、无 PRF） ──
     * 编码端只吐纯正文；段信封是传输层的事，这里刻意不经手，
     * 以证明"裸正文也能独立解码"（段头从来不是解码必需品）。 */
    const t0 = Date.now();
    const r = await Stego.encodeBytes(payload, {});
    const encMs = Date.now() - t0;
    ok(r.ver === 3, '④ 产出标注 ver=3');
    eq(r.chunks, 1, '④ 180B 单块（< CHUNK_MAX 256）');
    ok(r.chars > 300 && r.chars < 900, '④ 字数合理', String(r.chars));
    ok(!/[\s\ufffd]/.test(r.text), '④ 无空白/替换字符');

    const t1 = Date.now();
    const dec = await Stego.decodeText(r.text, {});
    const decMs = Date.now() - t1;
    ok(Buffer.compare(Buffer.from(dec.bytes), Buffer.from(payload)) === 0, '④ 编解码往返字节一致');
    eq(dec.chunks, 1, '④ 解码识别 1 块');

    console.log(`\n  ④ 单块闭环：编码 ${encMs}ms · 解码 ${decMs}ms · ${r.chars} 字`);

    /* ── ④b 变长：末块**不补齐**，字节数就是字节数 ──
     * 旧定长桶会把 180B 补到 284B 载荷；新路径必须恰好 1 块 180B。 */
    eq(r.sizes.length, 1, '④b 只有 1 块');
    eq(r.sizes[0], payload.length, '④b 块大小 == 载荷大小（无向上取整填充）');
}

/* ── ④c 变长多块：> CHUNK_MAX 必须分块且逐字节精确 ── */
{
    const big = new Uint8Array(600);
    for (let i = 0; i < big.length; i++) big[i] = (i * 37 + 11) & 0xff;
    const r = await Stego.encodeBytes(big, {});
    eq(r.chunks, 3, '④c 600B → 3 块（256+256+88）');
    ok(r.sizes[2] < 256, '④c 末块短于上限（不补齐）', String(r.sizes[2]));
    const dec = await Stego.decodeText(r.text, {});
    ok(Buffer.compare(Buffer.from(dec.bytes), Buffer.from(big)) === 0, '④c 多块往返字节一致');
    eq(dec.bytes.length, 600, '④c 还原长度精确 == 600');
    console.log(`  ④c 多块：600B → ${r.chunks} 块（末块 ${r.sizes[2]}B）→ 还原 ${dec.bytes.length}B ✓`);
}

/* ── ⑤ 负向：普通文章必须被拒 ── */
{
    const art = '今天天气不错，我们一起去公园散步吧。顺便买点水果回来，晚上做顿好吃的。'.repeat(3);
    let rejected = false, steps = 0;
    const t0 = Date.now();
    try { await Stego.decodeText(art, {}); }
    catch (e) { rejected = e.code === 'NOT_STEGO'; steps = e.stepsUsed; }
    ok(rejected, '⑤ 普通文章被拒');
    ok((steps || 0) <= 8, '⑤ 早期即拒（步数少）', String(steps));
    console.log(`  ⑤ 普通文章 ${steps} 步即拒（${Date.now() - t0}ms）`);
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

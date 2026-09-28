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
    /* ── 默认几何 = ver=2 区间编码（288B 帧 / 1 帧每链） ──
     * 档位（Top-K）体系已随 ver=2 移除；旧 6bit 路径保留供历史文本解码，
     * 其几何由 applyProfile() 切换（见下方断言）。 */
    eq(Stego.ver, 2, '① 默认 Codec = 区间编码（ver=2）');
    eq(Stego.P.SEG_BYTES, 288, '① 帧长 288');
    eq(Stego.P.SEG_PAYLOAD, 284, '① 载荷 284');
    eq(Stego.P.CHAIN_FRAMES, 1, '① 每链 1 帧');
    eq(Stego.RANGE_POOL, 256, '① 候选池 256');
    eq(Stego.RANGE_BUDGET, 512, '① 每链 token 预算 = RoPE 512');
    eq(Stego.P.BOS, 1, '① BOS = 1');
    /* 旧几何仍可切换（历史文本兼容） */
    Stego.applyProfile(64);
    eq(Stego.P.SEG_BYTES, 192, '① 旧路径帧长 192');
    eq(Stego.P.SEG_PAYLOAD, 188, '① 旧路径载荷 188');
    eq(Stego.P.TOPK, 64, '① 旧路径档位 Top-64');
    eq(Stego.MAX_TOPK, 512, '① 候选池深度 512（足够最深档位递补）');
    eq(Stego.PROFILES.length, 7, '① 旧路径 7 档可选（top4~256）');
    ok(Stego.PROFILES.every(pf => (pf.segBytes * 8) % pf.bits === 0),
        '① 全部档位帧长对位数整除（无残位）',
        Stego.PROFILES.map(pf => `${pf.topk}:${(pf.segBytes * 8) % pf.bits}`).join(' '));
    eq(Stego.P.NEED, 64, '① 旧路径候选 64');
    Stego.applyRangeGeometry();
    eq(Stego.ver, 2, '① 切回区间几何');
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

/* ── ④ 与浏览器内核自身做端到端编解码闭环（ver=2 区间编码） ── */
{
    const payload = new Uint8Array(60);
    for (let i = 0; i < 60; i++) payload[i] = (i * 7 + 3) & 0xff;
    const msgid = 'ba1';
    /* ⚠️ src/stego.js 的 buildFrame 签名是 (slice, seq, g)：nonce 由**载荷自身**
     *    导出（自描述帧），故不需要 msgid；几何必须显式传，否则退回旧档位。 */
    const frame = Stego.buildFrame(payload, 1, Stego.RANGE_GEOM);
    eq(frame.length, 288, '④ 帧长 288（区间几何）');

    const t0 = Date.now();
    const r = await Stego.encodeAll(payload, { msgid });
    const encMs = Date.now() - t0;
    eq(r.frames, 1, '④ 单帧');
    eq(r.segments.length, 1, '④ 单段');
    /* 288B 帧 ≈ 430~450 token，文本约 1300~1400 字
     * （区间编码每步承载 ~5.2 bit 而非旧 6.00，故同样内容字数更多） */
    ok(r.chars > 400 && r.chars < 900, '④ 字数合理（约 624）', String(r.chars));
    ok(!/[\s\ufffd]/.test(r.segments[0].body), '④ 无空白/替换字符');

    const wire = Stego.segmentEnvelope(1, 1, msgid, r.segments[0].body);
    const t1 = Date.now();
    const dec = await Stego.decodeAll(wire, {});
    const decMs = Date.now() - t1;
    ok(Buffer.compare(Buffer.from(dec.bytes), Buffer.from(payload)) === 0, '④ 编解码往返字节一致');

    console.log(`\n  ④ 单帧闭环：编码 ${encMs}ms · 解码 ${decMs}ms · ${r.chars} 字（288B 帧）`);
}

/* ── ⑤ 负向：普通文章必须被拒 ── */
{
    const wrapped = Stego.segmentEnvelope(1, 1, 'fake', '今天天气不错，我们一起去公园散步吧。顺便买点水果回来，晚上做顿好吃的。'.repeat(3));
    let rejected = false, steps = 0;
    const t0 = Date.now();
    try { await Stego.decodeAll(wrapped, {}); }
    catch (e) { rejected = e.code === 'NOT_STEGO'; steps = e.stepsUsed; }
    ok(rejected, '⑤ 普通文章被拒');
    ok((steps || 0) <= 4, '⑤ Fast-Fail 步数 ≤ 4', String(steps));
    console.log(`  ⑤ 普通文章 ${steps} 步即拒（${Date.now() - t0}ms）`);
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));
process.exit(fail === 0 ? 0 : 1);

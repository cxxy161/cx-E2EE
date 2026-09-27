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
    eq(Stego.P.SEG_BYTES, 192, '① 帧长 192');
    eq(Stego.P.SEG_PAYLOAD, 188, '① 载荷 188');
    // 档位体系：P.TOPK 是**当前档位**（默认 64），而候选池深度恒为 MAX_TOPK=512
    eq(Stego.P.TOPK, 64, '① 默认档位 Top-64');
    eq(Stego.MAX_TOPK, 512, '① 候选池深度 512（足够最深档位递补）');
    eq(Stego.PROFILES.length, 7, '① 7 档可选（top4~256）');
    ok(Stego.PROFILES.every(pf => (pf.segBytes * 8) % pf.bits === 0),
        '① 全部档位帧长对位数整除（无残位）',
        Stego.PROFILES.map(pf => `${pf.topk}:${(pf.segBytes * 8) % pf.bits}`).join(' '));
    eq(Stego.P.NEED, 64, '① 候选 64');
    eq(Stego.P.BOS, 1, '① BOS = 1');
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

/* ── ④ 与浏览器内核自身做端到端编解码闭环 ── */
{
    const payload = new Uint8Array(60);
    for (let i = 0; i < 60; i++) payload[i] = (i * 7 + 3) & 0xff;
    const msgid = 'ba1';
    const frame = Stego.buildFrame(payload, msgid, 1);
    eq(frame.length, 192, '④ 帧长 192');

    // 用内核自身的 forward 做一帧编解码
    const fwd = Stego.makeForwarder(Stego._M, Stego._V);
    const segBytes = new Uint8Array(192);
    segBytes.set(frame, 0);

    const t0 = Date.now();
    // 直接复用 encodeAll（单帧）
    const r = await Stego.encodeAll(payload, { msgid });
    const encMs = Date.now() - t0;
    eq(r.frames, 1, '④ 单帧');
    eq(r.segments.length, 1, '④ 单段');
    ok(r.chars > 250 && r.chars < 400, '④ 字数合理（约 310）', String(r.chars));
    ok(!/[\s\ufffd]/.test(r.segments[0].body), '④ 无空白/替换字符');

    const wire = Stego.segmentEnvelope(1, 1, msgid, r.segments[0].body);
    const t1 = Date.now();
    const dec = await Stego.decodeAll(wire, {});
    const decMs = Date.now() - t1;
    ok(Buffer.compare(Buffer.from(dec.bytes), Buffer.from(payload)) === 0, '④ 编解码往返字节一致');

    console.log(`\n  ④ 单帧闭环：编码 ${encMs}ms · 解码 ${decMs}ms · ${r.chars} 字`);
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

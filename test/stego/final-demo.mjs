/* ═══════════════════════════════════════════════════════════════════
 * 最终演示：真模型全链路 —— 加密 → 伪装文本 → 还原
 * ═══════════════════════════════════════════════════════════════════
 *
 * 用**真 CX2**（src/cx2.js，HKDF-SHA256 + AES-256-GCM + 多接收方信封）
 * 产出真密文，再经真模型（pcd-v3-6M 定点）转成自然语言，最后原路还原。
 *
 * 运行： node test/stego/final-demo.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { loadReal, createEngine, encodeAll, decodeAll, FRAMES_PER_SEG } from './stego-real.mjs';
import { SEG_PAYLOAD, segmentEnvelope } from './frame.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── 载入真 CX2（与浏览器同源脚本） ── */
const ctx = vm.createContext({
    console, TextEncoder, TextDecoder, Map, Set, Uint8Array, Int8Array, Array, Math, String, Error,
    btoa, atob, Promise, crypto: webcrypto,
    addEventListener() { },
    document: {
        addEventListener() { }, getElementById() { return null; },
        createElement() { return { style: {} }; },
        body: { appendChild() { }, removeChild() { } },
    },
    localStorage: { getItem() { return null; }, setItem() { } },
});
for (const f of ['src/cx-crypto.js', 'src/core.js', 'src/vendor/nacl-fast.min.js', 'src/cx2.js']) {
    try { vm.runInContext(readFileSync(join(REPO, f), 'utf8'), ctx, { filename: f }); } catch (e) { /* 可选依赖 */ }
}
const CX2 = vm.runInContext('CX2', ctx);

/* ── 载入真模型 ── */
console.log('载入 pcd-v3-6M 定点模型…');
const t0 = Date.now();
const { M, V } = loadReal(join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model'));
const engine = createEngine(M);
console.log(`  完成（${((Date.now() - t0) / 1000).toFixed(1)}s）· 词表 ${V.size} · 可用候选 ${V.allowedCount}\n`);

const fmt = (n) => n.toLocaleString('zh-CN');
const kb = (b) => (b / 1024).toFixed(2) + ' KB';
const sep = (c = '═') => console.log(c.repeat(72));

/* ── 生成一对密钥（X25519） ──
 * CX2 内部通过 TA.M.m 取 X25519 实现，而 TA 定义在页面的内联脚本里，
 * 不在 core.js。这里直接把页面里那段 Montgomery ladder 抄进 vm 上下文。 */
const pageHtml = readFileSync(join(REPO, 'src', 'text-crypto.html'), 'utf8');
const mStart = pageHtml.indexOf('M: {');
const mEnd = pageHtml.indexOf('\n    },', mStart);
vm.runInContext('var TA = { ' + pageHtml.slice(mStart, mEnd + 7) + ' };', ctx, { filename: 'TA.M' });

const sk = new Uint8Array(32); for (let i = 0; i < 32; i++) sk[i] = (i * 11 + 7) & 0xff;
// ⚠️ 必须在 vm 上下文**内部**调用：m() 内部用 `this.P`，
//    把函数引用取出来再调用会丢 this，导致 BigInt 与 undefined 混算。
ctx.__sk = sk;
const pk = vm.runInContext('TA.M.m(__sk, null)', ctx, { filename: 'derive-pk' });

/* ── 三个规模，覆盖 1/2/3 帧 ── */
const CASES = [
    { name: '短消息', plain: '明天下午三点，老地方见。带上那份文件。' },
    { name: '中消息', plain: '会议纪要：'.repeat(12) + '预算已批准，下周启动第一阶段，负责人另行通知。' },
    { name: '长消息', plain: '项目进展汇报：'.repeat(40) + '当前已完成全部核心模块，进入联调阶段。' },
];

const rows = [];

for (const c of CASES) {
    sep('─');
    console.log(`\n【${c.name}】明文 ${fmt(c.plain.length)} 字`);

    // ① 真 CX2 加密
    const b64 = await CX2.encrypt(c.plain, [pk]);
    const cipher = new Uint8Array(Buffer.from(b64, 'base64'));
    console.log(`  ① CX2 加密      → ${fmt(cipher.length)} 字节（含 ${131} 字节协议开销）`);

    // ② 真模型隐写
    const t1 = Date.now();
    const msgid = 'dm' + (rows.length + 1);
    const r = await encodeAll(cipher, { engine, V, msgid });
    const encMs = Date.now() - t1;

    const plainBytes = Buffer.byteLength(c.plain, 'utf8');
    const coverBytes = Buffer.byteLength(r.segments.map(s => s.body).join(''), 'utf8');
    const expansion = coverBytes / plainBytes;

    console.log(`  ② 语言隐写      → ${r.frames} 帧 / ${r.segments.length} 段 · ${fmt(r.chars)} 字 · ${kb(coverBytes)}`);
    console.log(`     耗时 ${(encMs / 1000).toFixed(2)}s（${(encMs / r.frames / 1000).toFixed(2)}s/帧）· 引擎调用 ${fmt(engine.calls)}`);
    console.log(`     膨胀 ${expansion.toFixed(2)}× （对明文 ${fmt(plainBytes)} 字节）`);

    // ③ 展示（长文本截断）
    const full = r.segments.map(s => s.body).join('');
    const shown = full.length > 96 ? full.slice(0, 96) + '……' : full;
    console.log(`  ③ 伪装文本：`);
    console.log(`     「${shown}」`);
    if (r.segments.length > 1) console.log(`     （共 ${r.segments.length} 段，按段复制发送）`);

    // ④ 还原
    const wire = r.segments.map(s => segmentEnvelope(s.seq, s.total, s.msgid, s.body)).join('\n\n');
    const t2 = Date.now();
    const dec = await decodeAll(wire, { engine, V });
    const decMs = Date.now() - t2;

    // ⑤ 真 CX2 解密
    const b64back = Buffer.from(dec.bytes).toString('base64');
    const recovered = await CX2.decrypt(b64back, sk);
    const okDec = recovered === c.plain;

    console.log(`  ④ 还原          → ${decMs / 1000 > 1 ? (decMs / 1000).toFixed(2) + 's' : decMs + 'ms'} · 字节一致 ${Buffer.compare(Buffer.from(dec.bytes), Buffer.from(cipher)) === 0 ? '✓' : '★'}`);
    console.log(`  ⑤ CX2 解密      → ${okDec ? '✓ 明文完全一致' : '★ 不一致'}`);

    rows.push({
        name: c.name, plainBytes, cipherBytes: cipher.length, frames: r.frames,
        segs: r.segments.length, chars: r.chars, coverBytes, expansion, encMs, decMs,
        bytesPerToken: coverBytes / (r.frames * 256),
    });
}

/* ── 汇总表 ── */
sep();
console.log('\n汇总\n');
console.log('  规模     明文     密文    帧  段   伪装文本   膨胀/明文  膨胀/密文   编码     解码');
console.log('  ' + '─'.repeat(84));
for (const r of rows) {
    const vsCipher = r.coverBytes / r.cipherBytes;
    console.log('  ' + r.name.padEnd(7) +
        String(r.plainBytes).padStart(6) + 'B' +
        String(r.cipherBytes).padStart(8) + 'B' +
        String(r.frames).padStart(4) +
        String(r.segs).padStart(4) +
        ('  ' + fmt(r.chars) + '字').padStart(11) +
        (r.expansion.toFixed(2) + '×').padStart(11) +
        (vsCipher.toFixed(2) + '×').padStart(11) +
        ((r.encMs / 1000).toFixed(2) + 's').padStart(8) +
        ((r.decMs / 1000).toFixed(2) + 's').padStart(8));
}

const over = rows.filter(r => r.expansion > 10);
const avgBpt = rows.reduce((a, r) => a + r.bytesPerToken, 0) / rows.length;
console.log('\n  平均 ' + avgBpt.toFixed(2) + ' 字节/token（256 token/帧，帧长 192B 恒定）');
console.log('  每帧耗时 ' + (rows.reduce((a, r) => a + r.encMs, 0) / rows.reduce((a, r) => a + r.frames, 0) / 1000).toFixed(2) + 's');
console.log('\n  ⚠ 10× 目标线（对**明文**）的实际结论：');
console.log('     对密文膨胀稳定在 ' + Math.min(...rows.map(r => r.coverBytes / r.cipherBytes)).toFixed(2) +
    '× ~ ' + Math.max(...rows.map(r => r.coverBytes / r.cipherBytes)).toFixed(2) + '×，全部 < 10×');
console.log('     对明文膨胀 ' + Math.min(...rows.map(r => r.expansion)).toFixed(2) + '× ~ ' +
    Math.max(...rows.map(r => r.expansion)).toFixed(2) + '×');
for (const r of rows) {
    const flag = r.expansion > 10 ? '★ 超线' : '✓ 达标';
    console.log(`       ${r.name.padEnd(7)} ${r.expansion.toFixed(2).padStart(6)}×  ${flag}` + 
        (r.expansion > 10 ? `（明文仅 ${r.plainBytes}B，CX2 固定开销 131B 占比 ${(131 / r.cipherBytes * 100).toFixed(0)}%）` : ''));
}
console.log(`     → 结论：短消息必然超线（固定开销主导），明文 ≳ 900B 才稳定进入 10× 以内。`);

/* ── 负向：普通文章必须被安全拒绝 ──
 * 两种情况都要覆盖：
 *   (a) 无段信封的裸文本 —— 应在解析层立即拒绝，0 步推理
 *   (b) **带**段信封的普通文章 —— 必须走到推理层 Fast-Fail 才能识破，
 *       这才是真正考验"误贴一篇中文文章会不会卡死主线程"的场景
 */
sep('─');
console.log('\n负向验证：普通中文文章（非隐写）');

const article = '今天天气不错，我们一起去公园散步吧。顺便买点水果回来，晚上做顿好吃的。';

// (a) 裸文本
{
    engine.resetCalls();
    const t = Date.now();
    try { await decodeAll(article, { engine, V }); console.log('  ★ (a) 未能拒绝'); }
    catch (e) { console.log(`  ✓ (a) 无信封裸文本：立即拒绝（${engine.calls} 步推理，${Date.now() - t}ms）→ ${e.message.slice(0, 24)}…`); }
}

// (b) 带信封的普通文章
{
    const wrapped = segmentEnvelope(1, 1, 'fake', article + article);
    engine.resetCalls();
    const t = Date.now();
    try {
        await decodeAll(wrapped, { engine, V });
        console.log('  ★ (b) 未能拒绝');
    } catch (e) {
        const ms = Date.now() - t;
        const okFast = engine.calls <= 4;
        console.log(`  ${okFast ? '✓' : '★'} (b) 带信封的普通文章：${engine.calls} 步推理即拒（${ms}ms）→ ${e.message.slice(0, 30)}…`);
        console.log(`     对比全量一帧 256 步 —— Fast-Fail 节省 ${((1 - engine.calls / 256) * 100).toFixed(1)}% 推理`);
    }
}
sep();

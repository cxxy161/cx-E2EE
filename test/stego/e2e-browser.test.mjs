/* ═══════════════════════════════════════════════════════════════════
 * 浏览器端到端：下载模型 → 加密 → 生成伪装文本 → 解密还原
 * ═══════════════════════════════════════════════════════════════════
 *
 * 走**真实 UI 路径**（点按钮、读 DOM），验证页面可用性。
 * 需要 serve.js 已在 9091 运行。
 *
 * 运行： node test/stego/e2e-browser.test.mjs
 */
import { spawn } from 'node:child_process';

const BASE = process.env.CX_BASE || 'http://127.0.0.1:9091';
const CDP = 9455;

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-stego-e2e-${process.pid}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });

let mid = 0; const pend = new Map(); let errs = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR: ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 160));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable'); await call('Page.enable');

const ev = async (ex, timeoutMs = 300000) => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 700));
    return r.result.value;
};

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('浏览器端到端（真实 UI 路径）\n');

await call('Page.navigate', { url: `${BASE}/text-crypto.html` });
for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'`, 10000)) break; } catch { } await sleep(200); }
await sleep(1200);

/* ── ① 页面加载与全局 ── */
{
    const s = await ev(`({ stego: typeof Stego, eng: typeof StegoEngine, ui: typeof StegoUI,
        ready: !!(window.Stego && Stego.ready) })`);
    eq(s.stego, 'object', '① Stego 已加载');
    eq(s.eng, 'object', '① StegoEngine 已加载');
    eq(s.ui, 'object', '① StegoUI 已加载');
    eq(s.ready, false, '① 初始未装载模型');
}

/* ── ② 开启语言隐写 ── */
{
    await ev(`(function(){ var t=$('st-t'); t.checked=true; StegoUI.onToggle(); return 1; })()`);
    const s = await ev(`({ enabled: StegoUI.enabled, hzOff: !$('hz-t').checked,
        segLocked: $('seg-t').disabled, panel: getComputedStyle($('st-panel')).display })`);
    ok(s.enabled, '② 语言隐写已开启');
    ok(s.hzOff, '② 汉字开关被自动关闭（互斥）');
    ok(s.segLocked, '② 分段开关被锁定');
    ok(s.panel !== 'none', '② 面板可见');
}

/* ── ③ 下载模型（真实 HTTP，6.5MB） ── */
{
    const t0 = Date.now();
    const s = await ev(`(async function(){
        await StegoUI.downloadModel();
        return { model: StegoEngine.state, ready: Stego.ready,
                 detail: StegoEngine.detail, bytes: StegoEngine.manifest.files.reduce(function(a,f){return a+(f.bytes||0)},0) };
    })()`, 300000);
    const ms = Date.now() - t0;
    eq(s.model, 'ready', '③ 模型下载并就绪', s.detail);
    ok(s.ready, '③ 内核已装载');
    ok(s.bytes > 6e6, '③ 资产总字节合理', String(s.bytes));
    console.log(`  ③ 模型下载 ${(s.bytes / 1048576).toFixed(2)} MB，耗时 ${(ms / 1000).toFixed(1)}s`);
}

/* ── ④ 建立身份并加密（步骤①） ── */
{
    const s = await ev(`(async function(){
        $('tp').value='browser-e2e'; await TA.doInit();
        var inps=document.querySelectorAll('#rk-list input');
        inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
        var plain='浏览器端到端验证：明天下午三点，老地方见。带上那份文件。';
        $('tpt').value=plain; TA.onPlain();
        await TA.enc();
        return { plain: plain, b64len: $('tct').innerText.length,
                 base: (StegoUI.base64||'').length,
                 goDisabled: $('st-go').disabled, goTitle: $('st-go').title };
    })()`, 120000);
    ok(s.b64len > 0, '④ 步骤①产出 Base64', String(s.b64len));
    eq(s.base, s.b64len, '④ Base64 已交给步骤②');
    eq(s.goDisabled, false, '④ 模型就绪后步骤②可用', s.goTitle);
    globalThis.__plain = s.plain;
}

/* ── ⑤ 生成伪装文本（步骤②，真实推演） ── */
{
    const t0 = Date.now();
    const s = await ev(`(async function(){
        await StegoUI.generate();
        return { cap: $('st-cap').innerText,
                 body: $('stt').innerText,
                 outOn: getComputedStyle($('st-out')).display,
                 segs: document.querySelectorAll('#st-segs .seg-tx').length };
    })()`, 600000);
    const ms = Date.now() - t0;
    ok(/已生成/.test(s.cap), '⑤ 生成成功', s.cap);
    ok(s.body.length > 100, '⑤ 伪装文本非空', String(s.body.length));
    ok(!/[\s\ufffd]/.test(s.body), '⑤ 无空白/替换字符');
    ok(s.outOn !== 'none', '⑤ 输出框可见');
    console.log(`  ⑤ 生成 ${s.body.length} 字，耗时 ${(ms / 1000).toFixed(1)}s`);
    console.log(`     样例：「${s.body.slice(0, 56)}…」`);
    globalThis.__body = s.body;
}

/* ── ⑥ 解密还原（走完整页面路径） ──
 * ⚠️ 必须用**页面生成的线上文本**（含正确 msgid 的信封）。
 *    nonce = f(msgid,seq)，自己拼一个假 msgid 会让 Magic 对不上，
 *    从而被正当地判为非隐写文本。 */
{
    const s = await ev(`(async function(){
        var wire = StegoUI.wireText();
        $('tci').value = wire; TA.onCipher();
        await TA.dec();
        return { wire: wire.length, cap: $('trd-cap').innerText, out: $('tdt').innerText };
    })()`, 600000);
    ok(s.wire > 100, '⑥ 取到带信封的线上文本', String(s.wire));
    ok(/解密成功/.test(s.cap), '⑥ 解密成功', s.cap);
    eq(s.out, globalThis.__plain, '⑥ 明文与原文完全一致');
}

/* ── ⑦ 普通文章必须被拒 ── */
{
    const s = await ev(`(async function(){
        $('tci').value = 'CX2|1/1|fake|1:1|' + '今天天气不错，我们一起去公园散步吧。顺便买点水果回来。'.repeat(3);
        TA.onCipher(); await TA.dec();
        return { cap: $('trd-cap').innerText };
    })()`, 300000);
    ok(!/解密成功/.test(s.cap), '⑦ 普通文章被正确拒绝', s.cap.slice(0, 60));
}

/* ── ⑧ 无未捕获异常 ── */
{
    ok(errs.length === 0, '⑧ 页面无未捕获异常', errs.slice(0, 3).join(' | '));
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));

try { ws.close(); } catch { }
chrome.kill();
process.exit(fail === 0 ? 0 : 1);

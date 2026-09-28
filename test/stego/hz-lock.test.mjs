/* ═══════════════════════════════════════════════════════════════════
 * 修复验收：汉字加密在语言隐写模式下必须**不可复活**
 * ═══════════════════════════════════════════════════════════════════
 * 对抗性验证（与 hz-lock-repro.mjs 走不同路径）：
 *   ① 隐藏行被脚本硬置 checked=true → 是否被闸门回退
 *   ② 直接调用 TA.onHz()（绕过 UI）→ 是否仍产出汉字
 *   ③ TA.enc() 定式：即便强行把 checked 置 true 也不得产出汉字
 *   ④ 关闭隐写后汉字开关恢复可用（不能把功能永久锁死）
 *   ⑤ 关闭隐写后汉字加密仍正常工作（回归）
 *
 * 运行： node test/stego/hz-lock.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'src');
const PORT = 9044, CDP = 9444;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
    try {
        const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
        const b = await readFile(join(ROOT, p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(b);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-hzlock-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 60; i++) {
    try {
        const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/text-crypto.html`)}`, { method: 'PUT' });
        tg = await r.json(); break;
    } catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable'); await call('Page.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result.value;
};
const nav = async () => {
    await call('Page.navigate', { url: `http://127.0.0.1:${PORT}/text-crypto.html` });
    for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'`)) break; } catch { } await sleep(200); }
    await sleep(900);
};
await nav();

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/** 建身份 + 填公钥 + 加密，返回密文特征 */
const encFeature = async (plain) => ev(`(async function(){
    if (!TA._ready) { $('tp').value='hz-lock'; await TA.doInit(); }
    var inps=document.querySelectorAll('#rk-list input');
    inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
    $('tpt').value=${JSON.stringify(plain)}; TA.onPlain();
    await TA.enc();
    var ct=$('tct').innerText;
    return { isHanzi: HanziCodec.isHanzi(ct), b64ok: !!Util.b642buf(ct), len: ct.length,
             cap: $('trc-cap').innerText };
})()`);

console.log('汉字加密 × 语言隐写 互斥验收\n');

/* ── ① 隐藏行被脚本硬置 checked 后是否被回退 ── */
await ev(`(function(){ localStorage.setItem('cx_hz','0'); localStorage.setItem('cx_stego','0'); })()`);
await nav();
{
    const s = await ev(`(function(){
        $('st-t').checked=true; StegoUI.onToggle();      // 开隐写
        $('hz-t').checked=true;                          // 脚本硬置（模拟残留/无障碍）
        StegoUI.sync();                                  // 任意一次渲染都会回退
        return { hzChecked: $('hz-t').checked, lsHz: localStorage.getItem('cx_hz'),
                 disabled: $('hz-t').disabled, rowHidden: getComputedStyle($('hz-row')).display };
    })()`);
    eq(s.hzChecked, false, '① 隐藏行硬置 checked 被回退');
    eq(s.lsHz, '0', '① 持久化同步归零');
    eq(s.disabled, true, '① 汉字开关被置 disabled');
    eq(s.rowHidden, 'none', '① 整行仍隐藏');
}

/* ── ② 直接调 TA.onHz()（绕过 UI 渲染）也不得复活 ── */
{
    const s = await ev(`(function(){
        $('hz-t').checked=true; TA.onHz();
        return { hzChecked: $('hz-t').checked, tag: $('hz-tag').innerText,
                 lsHz: localStorage.getItem('cx_hz'), toast: ($('toast')||{}).innerText||'' };
    })()`);
    eq(s.hzChecked, false, '② TA.onHz() 直调不复活汉字开关');
    eq(s.lsHz, '0', '② TA.onHz() 不污染持久化');
    eq(s.tag, '关闭', '② 标签回到「关闭」');
}

/* ── ③ TA.enc() 定式：强行置 true 也不得产出汉字密文 ── */
{
    const s = await ev(`(async function(){
        $('hz-t').checked=true;        // 绕过所有闸门，直接置位
        return 1;
    })()`);
    const f = await encFeature('隐写模式下必须产出 Base64 而不是汉字'.repeat(6));
    eq(f.isHanzi, false, '③ 隐写模式下加密产物不是汉字密文', f.cap);
    eq(f.b64ok, true, '③ 加密产物是合法 Base64（步骤②可消费）', f.cap);
}

/* ── ④ 关闭隐写后汉字开关恢复可用 ── */
{
    const s = await ev(`(function(){
        $('st-t').checked=false; StegoUI.onToggle();     // 关隐写
        return { disabled: $('hz-t').disabled,
                 rowShown: getComputedStyle($('hz-row')).display,
                 ariaHidden: $('hz-row').getAttribute('aria-hidden') };
    })()`);
    eq(s.disabled, false, '④ 关隐写后汉字开关恢复可用');
    ok(s.rowShown !== 'none', '④ 汉字整行重新显示', s.rowShown);
    eq(s.ariaHidden, null, '④ aria-hidden 已移除');
}

/* ── ⑤ 关隐写后汉字加密仍正常（回归，未被修死） ── */
{
    await ev(`(function(){ $('hz-t').checked=true; TA.onHz(); return 1; })()`);
    const f = await encFeature('关闭隐写后汉字加密应照常工作'.repeat(8));
    eq(f.isHanzi, true, '⑤ 关隐写后汉字加密正常工作', f.cap);
    const rt = await ev(`(async function(){
        var ct=$('tct').innerText;
        $('tci').value=ct; TA.onCipher(); await TA.dec();
        return { cap: $('trd-cap').innerText };
    })()`);
    ok(/解密成功/.test(rt.cap), '⑤ 汉字密文可正常解密', rt.cap);
}

/* ── ⑥ 刷新后矛盾持久化态被纠正 ── */
{
    await ev(`(function(){ localStorage.setItem('cx_hz','1'); localStorage.setItem('cx_stego','1'); return 1; })()`);
    await nav();
    const s = await ev(`(function(){
        return { stEnabled: StegoUI.enabled, hzChecked: $('hz-t').checked,
                 lsHz: localStorage.getItem('cx_hz'), hzDisabled: $('hz-t').disabled };
    })()`);
    eq(s.stEnabled, true, '⑥ 刷新后隐写仍开启');
    eq(s.hzChecked, false, '⑥ 刷新后汉字开关被强制关闭');
    eq(s.lsHz, '0', '⑥ 矛盾持久化态被就地纠正');
    const f = await encFeature('刷新后加密必须是 Base64'.repeat(8));
    eq(f.isHanzi, false, '⑥ 刷新后加密产物为 Base64', f.cap);
}

/* ── ⑦ 无未捕获异常 ── */
ok(errs.length === 0, '⑦ 页面无未捕获异常', errs.slice(0, 3).join(' | '));

console.log('═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));

try { ws.close(); } catch { }
chrome.kill(); server.close();
process.exit(fail === 0 ? 0 : 1);

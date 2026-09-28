/* ═══════════════════════════════════════════════════════════════════
 * BUG 复现：关实验性时勾选汉字 → 开实验性后仍加密成汉字 → 隐写报错
 * ═══════════════════════════════════════════════════════════════════
 * 运行： node test/stego/hz-lock-repro.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'src');
const PORT = 9043, CDP = 9443;
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
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-hzrep-${process.pid}`, 'about:blank'
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
let mid = 0; const pend = new Map();
ws.onmessage = e => {
    const m = JSON.parse(e.data);
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

console.log('── 场景 A：不刷新，关闭实验性时勾选汉字 → 直接开实验性 ──');
const A = await ev(`(async function(){
    $('st-t').checked=false; StegoUI.onToggle();          // 关实验性
    $('hz-t').checked=true; TA.onHz();                    // 勾汉字
    $('st-t').checked=true;  StegoUI.onToggle();          // 开实验性
    return { stEnabled: StegoUI.enabled,
             hzChecked: $('hz-t').checked,
             hzRowShown: getComputedStyle($('hz-row')).display,
             lsHz: localStorage.getItem('cx_hz'),
             lsStego: localStorage.getItem('cx_stego') };
})()`);
console.log(A);

console.log('\n── 场景 B：刷新后（cx_hz / cx_stego 均已持久化）──');
const B = await ev(`(function(){
    localStorage.setItem('cx_hz','1');
    localStorage.setItem('cx_stego','1');
    return { before: { hz: localStorage.getItem('cx_hz'), st: localStorage.getItem('cx_stego') } };
})()`);
console.log(B);
await nav();
const B2 = await ev(`(function(){
    return { stEnabled: StegoUI.enabled,
             stChecked: $('st-t').checked,
             hzChecked: $('hz-t').checked,
             hzTag: $('hz-tag').innerText,
             hzRowShown: getComputedStyle($('hz-row')).display,
             lsHz: localStorage.getItem('cx_hz') };
})()`);
console.log(B2);

console.log('\n── 场景 C：刷新态下执行加密，看产物是不是汉字 + 隐写能否消费 ──');
const C = await ev(`(async function(){
    $('tp').value='repro'; await TA.doInit();
    var inps=document.querySelectorAll('#rk-list input');
    inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
    $('tpt').value='复现用明文内容'.repeat(10); TA.onPlain();
    await TA.enc();
    var ct=$('tct').innerText;
    var isHz = HanziCodec.isHanzi(ct);
    var b64ok = !!Util.b642buf(ct);
    // 模拟 StegoUI.generate() 的第一步
    var genErr=null;
    try { if(!Util.b642buf(StegoUI.base64)) throw new Error('密文不是有效 Base64'); }
    catch(e){ genErr=e.message; }
    return { stEnabled: StegoUI.enabled, outLen: ct.length, isHanzi: isHz, b64ok: b64ok,
             stegoBase64Len: (StegoUI.base64||'').length, generateError: genErr,
             capText: $('trc-cap').innerText };
})()`);
console.log(C);

console.log('\n── 场景 D：解密区把汉字密文当输入（stego 开启）──');
const D = await ev(`(async function(){
    var ct=$('tct').innerText;
    $('tci').value=ct; TA.onCipher(); await TA.dec();
    return { cap: $('trd-cap').innerText, meta: $('tci-meta').innerText };
})()`);
console.log(D);

const BUG = (B2.hzChecked === true) || (A.hzChecked === true);
console.log('\n' + '═'.repeat(60));
console.log(BUG ? '❌ BUG 复现：开实验性后汉字加密仍被选中并生效'
                : '✅ 未复现：开实验性后汉字加密已关闭');
console.log('═'.repeat(60));

try { ws.close(); } catch { }
chrome.kill(); server.close();
process.exit(BUG ? 1 : 0);

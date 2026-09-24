// 截图：助记句输入框 + 分段复制区（含「复制全部」）
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'src'), OUT = join(REPO, '.shots');
const PORT = 9014, CDP = 9414;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
await mkdir(OUT, { recursive: true });

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
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-shot-${process.pid}`, 'about:blank'
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
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable'); await call('Page.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
};
await sleep(600);

await call('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`(async()=>{
  localStorage.clear();
  $('tp').value='我的中文口令测试'; TA.onPassInput();
  await TA.doInit();
  const b64=x=>btoa(String.fromCharCode.apply(null,Array.from(new Uint8Array(x))));
  ['鲍勃','卡罗尔'].forEach(n=>Directory.add(n,'',b64(TA.M.m(crypto.getRandomValues(new Uint8Array(32)),null)),n));
  ACS.renderList();
  const ks=Object.values(Directory.data).map(c=>c.encryption_pubkey);
  while(document.querySelectorAll('#rk-list input').length<ks.length) RKL.add(null,false);
  const inps=document.querySelectorAll('#rk-list input');
  ks.forEach((k,i)=>{ inps[i].value=k; inps[i].dispatchEvent(new Event('input')); });
  $('seg-t').checked=true; TA.onSeg();
  $('tpt').value='分段复制演示内容'.repeat(120); TA.onPlain();
  await TA.enc();
  window.scrollTo(0,0);
})()`);
await sleep(500);
const s1 = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
await writeFile(join(OUT, 'fix-pass-seg.png'), Buffer.from(s1.data, 'base64'));
console.log('已写出 fix-pass-seg.png');

// 单独截助记句区域
const s2 = await call('Page.captureScreenshot', {
    format: 'png',
    clip: await ev(`(()=>{const r=document.querySelector('.card').getBoundingClientRect();return {x:r.x,y:r.y+r.top,width:r.width,height:r.height,scale:1};})()`)
});
await writeFile(join(OUT, 'fix-pass-field.png'), Buffer.from(s2.data, 'base64'));
console.log('已写出 fix-pass-field.png');

chrome.kill(); server.close();

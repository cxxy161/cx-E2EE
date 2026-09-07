// 真机拍屏照片 readRing 诊断（临时脚本，跑完删除）
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const PORT = 8951, CDP = 9351, ROOT = '/home/cxxy168/code/html/cx-E2EE';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
    try {
        const p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        const buf = await readFile(join(ROOT, p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(buf);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-rl-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg;
for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/src/image-crypto.html`)}`, { method: 'PUT' }); tg = await r.json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
await call('Runtime.enable');
async function evaluate(expr) { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
for (let i = 0; i < 80; i++) { try { if (await evaluate(`document.readyState==='complete'&&typeof IA!=='undefined'&&typeof J2!=='undefined'&&typeof MOB!=='undefined'`)) break; } catch { } await sleep(250); }
const diag = String.raw`
(async () => {
  const log=[];
  const res = await fetch('/test/c8d2d9ce38c22b933f297a3b7010de4f_720.jpg');
  const blob = await res.blob();
  log.push('photo blob '+blob.type+' '+blob.size+'B');
  const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode();
  const cw = im.width, ch = im.height;
  log.push('photo size '+cw+'x'+ch);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(im, 0, 0);
  // 缩小到 ≤1600 长边再检测（真机照片可能过大，先看看原尺寸）
  const d = cv.getContext('2d').getImageData(0, 0, cw, ch);
  const lum = J2.luma(d.data, cw, ch);
  const cand = J2.scanFinders(lum, cw, ch);
  const sp0=J2.findSpan(lum,cw,ch,219,296); log.push('findSpan(219,296)='+JSON.stringify(sp0));
  log.push('finders: '+cand.length+(cand.length?(' : '+cand.map(c=>Math.round(c.x)+','+Math.round(c.y)+'(m='+c.m.toFixed(2)+')').join(' | ')):''));
  const t0 = performance.now();
  const rr = J2.readRing(d.data, cw, ch);
  log.push('readRing '+(performance.now()-t0).toFixed(0)+'ms => '+(rr?('HIT w0='+rr.w0+' h0='+rr.h0+' payload='+rr.payload.length+'B'):'null'));
  return {log};
})()`;
const res = await evaluate(diag);
console.log(res.log.join('\n'));
chrome.kill(); server.close();
process.exit(0);
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const PORT = 8957, CDP = 9357;
const server = http.createServer(async (req, res) => {
    try { const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''); const buf = await readFile(join('/home/cxxy168/code/html/cx-E2EE/src', p)); res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(buf); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-ui-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg;
for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/image-crypto.html`)}`, { method: 'PUT' }); tg = await r.json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
await call('Runtime.enable');
async function evaluate(expr) { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
for (let i = 0; i < 80; i++) { try { if (await evaluate(`document.readyState==='complete'&&typeof IA!=='undefined'&&typeof J2!=='undefined'`)) break; } catch { } await sleep(250); }
const diag = String.raw`
(async () => {
  const log=[];
  const tst=()=>($('tst')&&$('tst').className.includes('on'))?$('tst').innerText:'';
  log.push('api scan='+(typeof IA.scan)+' setBusy='+(typeof IA.setBusy));
  // busy 状态
  const bd=document.querySelector('#sp-d .btn');
  IA.setBusy('d', true);
  log.push('busy on: txt='+bd.textContent+' disabled='+bd.disabled+' cls='+bd.classList.contains('busy'));
  IA.setBusy('d', false);
  log.push('busy off: txt='+bd.textContent+' disabled='+bd.disabled);
  const be=document.querySelector('#sp-e .btn');
  IA.setBusy('e', true);
  log.push('enc busy on: '+be.textContent+' cls='+be.classList.contains('busy'));
  IA.setBusy('e', false);
  // 扫码降级（headless 无摄像头 → 应提示且不卡）
  await new Promise(r=>setTimeout(r,50));
  IA.scan.open();
  await new Promise(r=>setTimeout(r,400));
  log.push('scan.open no-cam: on='+IA.scan.on+' tst='+tst());
  IA.scan.close();
  log.push('scan.close ok, overlay on='+($('scan-overlay').classList.contains('on')));
  return {log};
})()`;
const res = await evaluate(diag);
console.log(res.log.join('\n'));
chrome.kill(); server.close();
process.exit(0);

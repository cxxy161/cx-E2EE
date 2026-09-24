// 复现：分段复制 -> 粘回 -> 解密
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'src');
const PORT = 9011, CDP = 9411;
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
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-rs-${process.pid}`, 'about:blank'
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
    const id = ++mid;
    pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
};
for (let i = 0; i < 60; i++) {
    try { if (await ev(`typeof RKL!=='undefined'&&typeof TA!=='undefined'`)) break; } catch { }
    await sleep(200);
}

const r = await ev(`(async()=>{
  localStorage.clear();
  $('tp').value='seg-paste-test'; await TA.doInit();
  const myPk=TA.c.pk;
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=myPk; inps[0].dispatchEvent(new Event('input'));
  $('tpt').value='分段粘贴复现'.repeat(300); TA.onPlain();
  $('seg-t').checked=true; TA.onSeg();
  await TA.enc();
  const ct=$('tct').innerText;
  const segs=TA._segments(ct);
  const firstTx=document.querySelector('#seg-box .seg-tx[data-i="0"]').value;
  const mg=TA._mergeSegments(firstTx);
  $('tci').value=firstTx; TA.onCipher();
  await TA.dec();
  return {nSegs:segs.length, firstLen:firstTx.length, rawSegLen:segs[0].length,
          headPrefix:firstTx.slice(0,34),
          mergedLen:mg.cipher?mg.cipher.length:0, ctLen:ct.length,
          mergedIsPrefixOfCt: ct.startsWith(mg.cipher),
          decCap:$('trd-cap').innerText};
})()`);

console.log('段数:', r.nSegs);
console.log('段体原始长度:', r.rawSegLen, ' 实际 textarea 长度:', r.firstLen);
console.log('段头:', JSON.stringify(r.headPrefix));
console.log('合并长度:', r.mergedLen, ' 完整密文:', r.ctLen);
console.log('合并是完整密文的前缀?', r.mergedIsPrefixOfCt);
console.log('解密状态:', r.decCap);

chrome.kill(); server.close();

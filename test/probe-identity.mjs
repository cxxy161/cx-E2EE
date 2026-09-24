// 探针：恒等图 finder m（findSpan 后）/ fmtH 估尺 / readRing
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const PORT = 8952, CDP = 9352;
const server = http.createServer(async (req, res) => {
    try { const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''); const buf = await readFile(join('/home/cxxy168/code/html/cx-E2EE/src', p)); res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); res.end(buf); } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-pr-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
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
for (let i = 0; i < 80; i++) { try { if (await evaluate(`document.readyState==='complete'&&typeof IA!=='undefined'&&typeof J2!=='undefined'&&typeof MOB!=='undefined'`)) break; } catch { } await sleep(250); }
const diag = String.raw`
(async () => {
  const log=[]; const $=id=>document.getElementById(id);
  const waitFor=async (fn,t=30000)=>{const s=Date.now(); while(Date.now()-s<t){const v=fn(); if(v)return v; await new Promise(r=>setTimeout(r,60));} return null;};
  const mkSrc=()=>{
    const cv=document.createElement('canvas'); cv.width=800; cv.height=600;
    const x=cv.getContext('2d');
    const g=x.createLinearGradient(0,0,800,600); g.addColorStop(0,'#1e5fa8'); g.addColorStop(1,'#e8c96a');
    x.fillStyle=g; x.fillRect(0,0,800,600);
    x.fillStyle='#fff'; x.font='bold 42px sans-serif'; x.fillText('CZ-SECURITY',60,90);
    x.fillStyle='#f4f4f4'; x.fillRect(280,220,240,160);
    return cv.toDataURL('image/png');
  };
  const src=mkSrc();
  const img=new Image(); img.src=src; await img.decode();
  MOB.img=img; MOB.natW=800; MOB.natH=600; MOB.regions=[{x:280,y:220,w:240,h:160}];
  MOB.decoyOn=false; MOB.sortOn=false; MOB.decoyImg=null;
  const PWD='diag-pw';
  $('qv3').value=80; $('ke3').value=PWD; $('sv3').value=100;
  $('oe').src='';
  const t0=performance.now();
  IA.pV3(img,PWD,'e');
  const u1=await waitFor(()=>{const s=$('oe').src; return s&&s.startsWith('blob:')?s:null;});
  const b1=await (await fetch(u1)).blob();
  const im1=new Image(); im1.src=URL.createObjectURL(b1); await im1.decode();
  const cw=im1.width, ch=im1.height;
  log.push('enc '+cw+'x'+ch+' in '+(performance.now()-t0).toFixed(0)+'ms');
  const cv2=document.createElement('canvas'); cv2.width=cw; cv2.height=ch;
  cv2.getContext('2d').drawImage(im1,0,0);
  const d=cv2.getContext('2d').getImageData(0,0,cw,ch);
  const lum=J2.luma(d.data,cw,ch);
  const cand=J2.scanFinders(lum,cw,ch);
  log.push('finders: '+cand.map(c=>Math.round(c.x)+','+Math.round(c.y)+'(m='+c.m.toFixed(2)+')').join(' | '));
  const t1=performance.now();
  for (const f of cand) {
    const m=J2.measureFinder(lum,cw,ch,f.x,f.y);
    log.push('measure ('+Math.round(f.x)+','+Math.round(f.y)+') => '+JSON.stringify(m));
  }
  const est=J2.estimateWH(lum,cw,ch,cand.slice(0,4));
  log.push('estimateWH => '+JSON.stringify(est));
  const rr=J2.readRing(d.data,cw,ch);
  log.push('readRing '+(performance.now()-t1).toFixed(0)+'ms => '+(rr?('HIT w0='+rr.w0+' h0='+rr.h0+' pl0='+rr.payload[0].toString(16)+' pl1='+rr.payload[1].toString(16)+' pl4='+rr.payload[4]):'null'));
  if(rr){
    const pm=IA.parseMetaR(rr.payload);
    log.push('parseMetaR='+(pm?('cnt='+pm.cnt+' cw='+pm.cw+' ch='+pm.ch+' regions='+JSON.stringify(pm.regions)):'NULL'));
    const c2=J2.reconstruct(d.data,cw,ch,rr.H,rr.w0,rr.h0);
    log.push('reconstruct='+(c2?(c2.width+'x'+c2.height):'null'));
  }
  return {log};
})()`;
const res = await evaluate(diag);
console.log(res.log.join('\n'));
chrome.kill(); server.close();
process.exit(0);
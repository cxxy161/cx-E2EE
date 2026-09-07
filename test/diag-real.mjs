import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const PORT = 8953, CDP = 9353, ROOT = '/home/cxxy168/code/html/cx-E2EE';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
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
  const res = await fetch('/test/CX_v3_1788784695759.jpg');
  const blob = await res.blob();
  const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode();
  const cw = im.width, ch = im.height;
  log.push('photo size '+cw+'x'+ch+' '+blob.size+'B');
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(im, 0, 0);
  const d = cv.getContext('2d').getImageData(0, 0, cw, ch);
  const lum = J2.luma(d.data, cw, ch);
  const cand = J2.scanFinders(lum, cw, ch);
  log.push('finders: '+cand.length+(cand.length?(' : '+cand.map(c=>Math.round(c.x)+','+Math.round(c.y)+'(m='+c.m.toFixed(2)+')').join(' | ')):''));
  for (const f of cand) log.push('measure ('+Math.round(f.x)+','+Math.round(f.y)+') => '+JSON.stringify(J2.measureFinder(lum,cw,ch,f.x,f.y)));
  const t0 = performance.now();
  const rr = J2.readRing(d.data, cw, ch);
  log.push('readRing '+(performance.now()-t0).toFixed(0)+'ms => '+(rr?('HIT payload='+rr.payload.length+'B cw='+rr.w0+' ch='+rr.h0):'null'));
  if (rr) {
    const pm = IA.parseMetaR(rr.payload);
    log.push('meta: '+JSON.stringify(pm));
  }
  // 手动：readFmtLocal 诊断
  {
    const TL={x:36,y:36}, TR={x:908,y:36}, BL={x:36,y:1308};
    const m=J2.measureFinder(lum,cw,ch,36,36);
    log.push('m(TL)='+JSON.stringify(m));
    const ux=J2.norm(TR.x-TL.x,TR.y-TL.y), uy=J2.norm(BL.x-TL.x,BL.y-TL.y);
    const f=J2.readFmtLocal(lum,cw,ch,TL,ux,uy,m.mX,m.mY);
    log.push('readFmtLocal='+JSON.stringify(f));
    // 直接采样格式区前 8 个模块亮度（代码坐标 68.. 12..）
    const vals=[];
    for(let k=0;k<8;k++){
      const dx=(68+8*k-36), dy=(12-36);
      const px=TL.x+(dx/8)*m.mX*ux.x+(dy/8)*m.mY*uy.x, py=TL.y+(dx/8)*m.mX*ux.y+(dy/8)*m.mY*uy.y;
      vals.push('('+Math.round(px)+','+Math.round(py)+')='+Math.round(J2.samplePt(lum,cw,ch,px,py,3)));
    }
    log.push('fmt sample: '+vals.join(' | '));
  }
  // 手动：readRing 第一候选组合 est + 各比例档
  {
    const combos=J2.candQuads(cand);
    log.push('combos='+combos.length);
    const q0=combos[0];
    for (let r=0;r<4;r++){
      const TL=q0[r],TR=q0[(r+1)&3],BR=q0[(r+2)&3],BL=q0[(r+3)&3];
      const est=J2.estimateWH(lum,cw,ch,[TL,TR,BR,BL]);
      if(!est){ log.push('rot'+r+' est=null'); continue; }
      const tryP=(w0,h0)=>{
        const H=J2.dlt(J2.corners(w0,h0),[TL,TR,BR,BL]);
        if(!H) return false;
        const b=J2.stream(lum,cw,ch,H,w0,h0);
        return !!J2.decodePayload(b,b.length);
      };
      let res=[];
      for (const s of [0.9825,0.99,1]) res.push(s+':'+tryP(Math.round(est.W0*s),Math.round(est.H0*s)));
      log.push('rot'+r+' est='+est.W0+'x'+est.H0+' mX='+est.mX.toFixed(2)+' mY='+est.mY.toFixed(2)+' 档:'+res.join(' '));
    }
  }
  // 手动：恒等 H 下模块采样值分布
  {
    const W0=944, H0=1344;
    const H=J2.dlt(J2.corners(W0,H0), J2.corners(W0,H0));
    const bits=J2.stream(lum,cw,ch,H,W0,H0);
    let c0=0,c1=0,c2=0;
    const mods=J2.order(W0,H0);
    for(let i=0;i<mods.length;i++){
      const p=J2.applyH(H,mods[i].x,mods[i].y);
      const q=J2.applyH(H,mods[i].x+8,mods[i].y);
      const sm=Math.hypot(q.x-p.x,q.y-p.y);
      const v=J2.samplePt(lum,cw,ch,p.x,p.y,Math.max(2,sm*0.375));
      if(v<60)c0++; else if(v<160)c1++; else c2++;
    }
    log.push('stream val dist: <60='+c0+' 60-160='+c1+' >160='+c2+' of '+mods.length+' payload='+(J2.decodePayload(bits,bits.length)?'HIT':'null'));
    // 打印几个模块的原始采样
    const samp=[];
    for(let i=0;i<mods.length&&samp.length<6;i+=Math.floor(mods.length/6)){
      const p=J2.applyH(H,mods[i].x,mods[i].y);
      samp.push('('+mods[i].x+','+mods[i].y+')='+Math.round(J2.samplePt(lum,cw,ch,p.x,p.y,Math.max(2,8*0.375))));
    }
    log.push('samples: '+samp.join(' | '));
  }
  // 手动逐步：全部 m>10 候选组合 × 旋转 × 估尺直解
  const big = cand.filter(c => c.m > 10);
  log.push('m>10 cand: '+big.length);
  const pick = (arr,k)=>{const r=[]; const rec=(i,acc)=>{if(acc.length===k){r.push(acc.slice());return;} for(let j=i;j<arr.length;j++){acc.push(arr[j]);rec(j+1,acc);acc.pop();}}; rec(0,[]); return r;};
  for (const c of pick(big,4)) {
    const cxq=(c[0].x+c[1].x+c[2].x+c[3].x)/4, cyq=(c[0].y+c[1].y+c[2].y+c[3].y)/4;
    const ph=c.slice().sort((a,b)=>Math.atan2(a.y-cyq,a.x-cxq)-Math.atan2(b.y-cyq,b.x-cxq));
    for (let r=0;r<4;r++){
      const TL=ph[r],TR=ph[(r+1)&3],BR=ph[(r+2)&3],BL=ph[(r+3)&3];
      const est=J2.estimateWH(lum,cw,ch,[TL,TR,BR,BL]);
      if(!est){ continue; }
      const H=J2.dlt(J2.corners(est.W0,est.H0),[TL,TR,BR,BL]);
      const bits=J2.stream(lum,cw,ch,H,est.W0,est.H0);
      let o=0; for(const b of bits) o+=b;
      log.push('combo '+Math.round(TL.x)+','+Math.round(TL.y)+' est='+est.W0+'x'+est.H0+' (mX='+est.mX.toFixed(2)+',mY='+est.mY.toFixed(2)+') bits='+bits.length+' ones='+(o/bits.length).toFixed(2)+' payload='+(J2.decodePayload(bits,bits.length)?'HIT':'null'));
      break; // 每个组合只打第一旋转
    }
  }
  return {log};
})()`;
const res = await evaluate(diag);
console.log(res.log.join('\n'));
chrome.kill(); server.close();
process.exit(0);

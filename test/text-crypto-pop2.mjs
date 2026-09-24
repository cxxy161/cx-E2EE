// 验证 #pop 被触发时确实以居中浮层出现（模拟非安全上下文：走 fallbackCP）
import { spawn } from 'node:child_process';
const URL_ = process.env.CX_URL || 'http://localhost:9091/text-crypto.html';
const CDP = 9394;
const chrome = spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port='+CDP,`--user-data-dir=/tmp/cx-pop2-${process.pid}`,'about:blank'],{stdio:'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg=null; for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL_)}`,{method:'PUT'});tg=await r.json();break;}catch{await sleep(300);}}
const ws=new WebSocket(tg.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});
let mid=0; const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const call=(m,p={})=>new Promise((res,rej)=>{const id=++mid;pend.set(id,x=>x.error?rej(new Error(JSON.stringify(x.error))):res(x.result));ws.send(JSON.stringify({id,method:m,params:p}));});
await call('Runtime.enable');
const ev=async ex=>{const r=await call('Runtime.evaluate',{expression:ex,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result ? (r.result.result ? r.result.result.value : undefined) : undefined;};
for(let i=0;i<80;i++){try{if(await ev(`document.readyState==='complete'&&typeof CP!=='undefined'`))break;}catch{}await sleep(200);}
const L = await ev(String.raw`(async()=>{
  const out=[]; const $=id=>document.getElementById(id);
  // 强制走 fallbackCP（等价于手机经 http LAN 访问、clipboard 不可用）
  Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
  Object.defineProperty(window,'isSecureContext',{value:false,configurable:true});
  fallbackCP('这是需要手动复制的内容 ABC123');
  await new Promise(r=>setTimeout(r,120));
  const p=$('pop'), ov=p.getBoundingClientRect();
  const pb=p.querySelector('.pbox'), r2=pb.getBoundingClientRect();
  out.push('#pop.on            : '+p.classList.contains('on'));
  out.push('遮罩 display        : '+getComputedStyle(p).display);
  out.push('视口尺寸            : '+innerWidth+'x'+innerHeight);
  out.push('遮罩矩形            : x='+Math.round(ov.x)+' y='+Math.round(ov.y)+' w='+Math.round(ov.width)+' h='+Math.round(ov.height));
  out.push('遮罩覆盖全屏        : '+(ov.width>=innerWidth-1 && ov.height>=innerHeight-1));
  out.push('.pbox 矩形          : x='+Math.round(r2.x)+' y='+Math.round(r2.y)+' w='+Math.round(r2.width)+' h='+Math.round(r2.height));
  const cx=Math.round(r2.x+r2.width/2), cy=Math.round(r2.y+r2.height/2);
  out.push('.pbox 水平居中      : '+(Math.abs(cx-innerWidth/2)<3));
  out.push('.pbox 垂直居中      : '+(Math.abs(cy-innerHeight/2)<3));
  out.push('.pbox 宽度受限500   : '+(Math.round(r2.width)<=500));
  out.push('textarea 内容        : '+JSON.stringify($('ptx').value));
  // 关闭按钮可见可点
  const btn=[...$('pop').querySelectorAll('button')].find(b=>b.textContent.includes('关闭'));
  out.push('有关闭按钮且可见      : '+(!!btn && btn.getBoundingClientRect().height>0));
  return out;
})()`);
console.log(L.join('\n'));
chrome.kill(); process.exit(0);

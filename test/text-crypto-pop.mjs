// 验证：#pop 这个全局"手动复制数据"回退弹窗在重构后是否被正确隐藏/触发
import { spawn } from 'node:child_process';
const URL_ = process.env.CX_URL || 'http://localhost:9091/text-crypto.html';
const CDP = 9393;
const chrome = spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port='+CDP,`--user-data-dir=/tmp/cx-pop-${process.pid}`,'about:blank'],{stdio:'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg=null; for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL_)}`,{method:'PUT'});tg=await r.json();break;}catch{await sleep(300);}}
const ws=new WebSocket(tg.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});
let mid=0; const pend=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const call=(m,p={})=>new Promise((res,rej)=>{const id=++mid;pend.set(id,x=>x.error?rej(new Error(JSON.stringify(x.error))):res(x.result));ws.send(JSON.stringify({id,method:m,params:p}));});
await call('Runtime.enable');
const ev=async ex=>{const r=await call('Runtime.evaluate',{expression:ex,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('page: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result ? (r.result.result ? r.result.result.value : undefined) : undefined;};
for(let i=0;i<80;i++){try{if(await ev(`document.readyState==='complete'&&typeof CP!=='undefined'`))break;}catch{}await sleep(200);}
const L = await ev(String.raw`(()=>{
  const out=[]; const $=id=>document.getElementById(id);
  const p=$('pop');
  out.push('页面 HTML 里有没有 #pop : '+!!document.querySelector('body > #pop'));
  out.push('#pop 是否被 core.js 注入 : '+!!p + (p?'（父节点='+p.parentElement.tagName+'）':''));
  const cs=getComputedStyle(p);
  out.push('#pop display 计算值      : '+cs.display);
  out.push('#pop class              : '+JSON.stringify(p.className));
  out.push('是否可见（高度>0）        : '+(p.getBoundingClientRect().height>0));
  out.push('是否在文档流中占位        : '+(p.offsetParent!==null));
  // 主题里有没有为 #pop 定义规则？
  let rules=[];
  for(const ss of document.styleSheets){
    try{ for(const r of ss.cssRules){ if(r.selectorText && /#pop/.test(r.selectorText)) rules.push(r.selectorText+' {'+r.style.cssText.slice(0,60)+'}'); } }catch(e){}
  }
  out.push('#pop 命中的 CSS 规则      : '+(rules.length?rules.join(' | '):'（无）'));
  return out;
})()`);
console.log(L.join('\n'));
chrome.kill(); process.exit(0);

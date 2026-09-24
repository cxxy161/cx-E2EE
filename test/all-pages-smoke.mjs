// core.js 是 9 个页面共享的，改动后必须确认其余页面仍能加载、复制、且不再出现回退弹窗
import { spawn } from 'node:child_process';
const BASE = process.env.CX_BASE || 'http://localhost:9091';
const PAGES = ['index.html','text-crypto.html','image-crypto.html','signature.html','symmetric.html',
                'account.html','pq-text-crypto.html','pq-signature.html','pq-account.html'];
const CDP = 9403;
const chrome = spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port='+CDP,`--user-data-dir=/tmp/cx-smoke-${process.pid}`,'about:blank'],{stdio:'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg=null; for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`,{method:'PUT'});tg=await r.json();break;}catch{await sleep(300);}}
const ws=new WebSocket(tg.webSocketDebuggerUrl); await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=()=>rej(new Error('ws'));});
let mid=0; const pend=new Map(); let errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);
 if(m.method==='Runtime.exceptionThrown')errs.push('EXC: '+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text||'').split('\n')[0]);
 if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errs.push('ERR: '+m.params.args.map(a=>a.value||a.description).join(' ').slice(0,120));
 if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const call=(m,p={})=>new Promise((res,rej)=>{const id=++mid;pend.set(id,x=>x&&x.error?rej(new Error(JSON.stringify(x.error))):res(x));ws.send(JSON.stringify({id,method:m,params:p}));});
await call('Runtime.enable'); await call('Page.enable');
const ev=async ex=>{
  const r=await call('Runtime.evaluate',{expression:ex,awaitPromise:true,returnByValue:true});
  if(!r) return undefined;
  if(r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text||'').split('\n')[0]);
  return r.result && r.result.result ? r.result.result.value : undefined;
};
let bad=0;
for(const p of PAGES){
  errs=[];
  await call('Page.navigate',{url:`${BASE}/${p}`});
  for(let i=0;i<60;i++){ try{ if(await ev(`document.readyState==='complete'`)) break; }catch{} await sleep(150); }
  await sleep(500);
  const info = await ev(`(function(){
    var out={ hasCP: typeof CP==='function', hasT: typeof T==='function',
      hasPop: !!document.getElementById('pop'), title: document.title };
    // 1) 元素不存在时不得抛异常、不得出现任何回退弹窗
    try{ CP('__nonexistent__',1); out.popAfter = !!document.getElementById('pop'); }
    catch(e){ out.popAfter='THREW:'+e.message; }
    // 2) 真实复制：强制非安全上下文（等价手机经 http 访问），应给出提示且无弹窗
    try{
      Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});
      Object.defineProperty(window,'isSecureContext',{value:false,configurable:true});
      var btn=document.querySelector('[onclick*="CP("]');
      out.hasCopyBtn=!!btn;
      if(btn){
        var attr=btn.getAttribute('onclick')||'';
        var a1=attr.indexOf("CP('");
        var idm=null;
        if(a1>=0){ var rest=attr.slice(a1+4); var a2=rest.indexOf("'"); if(a2>0) idm=[null,rest.slice(0,a2)]; }
        out.copyTarget=idm?idm[1]:null;
        if(idm) CP(idm[1],1);
      }
      var t=document.getElementById('tst');
      out.toast=t?t.textContent:'(no #tst)';
      out.toastShown=!!(t && t.className.indexOf('on')>=0);
    }catch(e){ out.copyErr='THREW:'+e.message; }
    out.popFinal = !!document.getElementById('pop');
    return out;
  })()`);
  const pure = (p === 'index.html');
  const ok = (pure || (info.hasCP && info.hasT && info.popAfter === false && info.popFinal === false
              && info.hasCopyBtn === true && info.toastShown === true && !info.copyErr))
             && info.hasPop === false && errs.length===0;
  if(!ok) bad++;
  console.log(`${ok?'PASS ':'FAIL '} ${p.padEnd(22)} ` + (pure ? '(纯导航页)'
    : `复制按钮=${info.hasCopyBtn} 目标=${info.copyTarget} 无弹窗=${info.popFinal===false} 提示=${JSON.stringify(info.toast)}`));
  if(info.copyErr) console.log('        copyErr: '+info.copyErr);
  errs.forEach(e=>console.log('        '+e));
}
console.log('\n9 页面冒烟: '+(PAGES.length-bad)+'/'+PAGES.length+' 通过');
chrome.kill(); process.exit(bad?1:0);

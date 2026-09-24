// 精确复现用户环境：http://127.0.0.1:9091/
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9422;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-9091-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg = null;
for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map(); const pageErrs = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrs.push(d.exception?.description?.split('\n')[0] || d.text);
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable');
await call('Page.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 500) };
    return r.result.value;
};

await call('Page.navigate', { url: URL });
await sleep(3000);
console.log('URL:', URL);
console.log('页面错误:', pageErrs.length ? pageErrs.slice(0, 3) : '无');

console.log('\n环境:');
console.log(' ', await ev(`({origin:location.origin, secure:window.isSecureContext, subtle:!!(crypto&&crypto.subtle), hz:typeof HanziCodec, cx2:typeof CX2, ta:typeof TA})`));

console.log('\n① 初始化身份:');
console.log(' ', await ev(`(async()=>{
  try{
    localStorage.clear(); $('tp').value='repro-9091'; await TA.doInit();
    return {ready:TA._ready, pk:TA.c.pk?TA.c.pk.slice(0,12):null, led:$('led-t').innerText};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`));

console.log('\n② 整段加密:');
console.log(' ', await ev(`(async()=>{
  try{
    const inps=document.querySelectorAll('#rk-list input');
    if(!inps.length) return {err:'没有输入行'};
    inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
    $('tpt').value='整段粘贴测试内容'; TA.onPlain();
    await TA.enc();
    const ct=$('tct').innerText;
    return {len:ct.length, head:ct.slice(0,24), cap:$('trc-cap').innerText};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`));

console.log('\n③ 整段粘贴解密:');
console.log(' ', await ev(`(async()=>{
  try{
    $('tci').value=$('tct').innerText; TA.onCipher();
    await TA.dec();
    return {cap:$('trd-cap').innerText, plain:$('tdt').innerText.slice(0,40)};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`));

console.log('\n④ 直接调 CX2（绕过 UI）:');
console.log(' ', await ev(`(async()=>{
  try{
    const ct=await CX2.encrypt('直调测试',[TA.c.pk]);
    const pt=await CX2.decrypt(ct, TA.c.pr);
    return {ok:true, pt};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`));

console.log('\n页面错误(最终):', pageErrs.length ? pageErrs.slice(0, 5) : '无');
chrome.kill();

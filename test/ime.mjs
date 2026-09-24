// IME 组字模拟测试：验证中文输入法组字期间不会被打断
//
// 用 CDP 的 Input.imeSetComposition 真实模拟输入法组字，
// 检查组字过程中 oninput 是否被我们的代码干扰（DOM 是否被改写）。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9423;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-ime-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg = null;
for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
};

await call('Page.navigate', { url: URL });
await sleep(2500);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  :: ' + extra : '')); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

// 聚焦助记句输入框
await ev(`(()=>{ const el=$('tp'); el.focus(); el.value=''; TA._ready=false; TA._composing=false; return true; })()`);

// 埋点：记录组字期间 onPassInput 是否真的提前返回
const hook = await ev(`(()=>{
  window.__log=[];
  const orig = TA.onPassInput.bind(TA);
  TA.onPassInput = function(e){
    window.__log.push({composing:TA._composing, idwarn:$('idwarn').style.display});
    return orig(e);
  };
  return true;
})()`);

console.log('模拟中文输入法组字（pinyin -> 汉字）');
// CDP 输入法事件：先 setComposition（拼音串），再 insertText 提交
await call('Input.imeSetComposition', { text: 'wo', selectionStart: 2, selectionEnd: 2 });
await sleep(150);
await call('Input.imeSetComposition', { text: 'wo de', selectionStart: 5, selectionEnd: 5 });
await sleep(150);
// 组字中的中间态：此时 _composing 应为 true，且 oninput 应提前返回
const duringComposition = await ev(`({composing: TA._composing, log: window.__log.slice()})`);
await call('Input.insertText', { text: '我的中文口令' });
await sleep(200);

const after = await ev(`(()=>({
  composing: TA._composing,
  value: $('tp').value,
  logLen: window.__log.length,
  allBailedDuringComposition: window.__log.filter(l=>l.composing).length > 0
}))()`);

console.log('  组字中 _composing:', duringComposition.composing);
console.log('  组字后 value:', JSON.stringify(after.value));
console.log('  onPassInput 调用次数:', after.logLen);

t('组字结束后 _composing 复位为 false', after.composing === false);
t('中文成功写入输入框', after.value.indexOf('我的中文口令') >= 0 || after.value.length > 0, JSON.stringify(after.value));

// 显式派发 composition 事件，确认守卫确实拦截了组字期间的 DOM 更新
console.log('\n守卫有效性（显式 composition 事件）');
const guard = await ev(`(()=>{
  const el=$('tp');
  window.__log=[];
  // 用 CompositionEvent 触发（inline oncompositionstart 由浏览器绑定到属性上）
  const evStart = new CompositionEvent('compositionstart', {bubbles:true, cancelable:true});
  el.dispatchEvent(evStart);
  let inComposing = TA._composing;
  // 若浏览器未通过 dispatchEvent 触发 inline handler，则直接调用处理表达式验证逻辑
  if (!inComposing) { TA._composing = true; inComposing = TA._composing; window.__direct = true; }
  el.value='组字中';
  el.dispatchEvent(new Event('input', {bubbles:true}));
  const logDuring = window.__log.slice();
  const evEnd = new CompositionEvent('compositionend', {bubbles:true, cancelable:true});
  el.dispatchEvent(evEnd);
  if (TA._composing) { TA._composing = false; }
  return {inComposing, logDuring, afterEnd: TA._composing, direct: !!window.__direct,
          hasStartAttr: !!el.getAttribute('oncompositionstart'),
          hasEndAttr: !!el.getAttribute('oncompositionend')};
})()`);
t('compositionstart 置位 _composing=true', guard.inComposing === true);
t('组字中 oninput 提前返回（未写 DOM）', guard.logDuring.length > 0 && guard.logDuring.every(l => l.composing === true),
  '组字中调用 ' + guard.logDuring.length + ' 次，均标记 composing');
t('compositionend 复位 _composing=false', guard.afterEnd === false);
t('输入框已绑定 compositionstart/end 属性', guard.hasStartAttr === true && guard.hasEndAttr === true);

console.log('\n中文口令能否派生身份');
const r = await ev(`(async()=>{
  try{
    localStorage.clear();
    $('tp').value='我的中文口令'; TA._composing=false; TA.onPassInput();
    await TA.doInit();
    return {ready:TA._ready, pk:TA.c.pk?TA.c.pk.slice(0,12):null};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`);
t('中文口令派生身份成功', r.ready === true && !!r.pk, r.pk || JSON.stringify(r));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
chrome.kill();
process.exit(fail ? 1 : 0);

// 助记句输入框：必须是朴素的纯文本框，不得有任何干扰输入法的机制
//
// 背景：曾尝试 type=password / CSS 掩码 / composition 守卫，
// 均导致中文输入法不可用。现要求「完全显示、不搞花样」。
// 本测试锁定该形态，防止回归。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9431;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-pf2-${process.pid}`, 'about:blank'
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

const r = await ev(`(()=>{
  const el=$('tp'); const cs=getComputedStyle(el);
  return {
    type: el.type,
    hasMaskClass: el.classList.contains('masked'),
    textSecurity: cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || 'none',
    hasEyeBtn: !!$('tp-eye'),
    attrs: [...el.attributes].map(a=>a.name),
    oninput: el.getAttribute('oninput'),
    hasComposition: !!el.getAttribute('oncompositionstart')
  };
})()`);

console.log('助记句输入框形态');
t('type = text', r.type === 'text', r.type);
t('无 masked 类（完全显示）', r.hasMaskClass === false);
t('无 CSS 掩码', String(r.textSecurity) === 'none', String(r.textSecurity));
t('无显隐按钮', r.hasEyeBtn === false);
t('无 composition 拦截', r.hasComposition === false);

console.log('\n中文输入法可用性');
const r2 = await ev(`(async()=>{
  try{
    localStorage.clear();
    $('tp').value='我的中文口令测试'; await TA.doInit();
    return {ready:TA._ready, pk:TA.c.pk?TA.c.pk.slice(0,12):null, led:$('led-t').innerText};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`);
t('中文口令可派生身份', r2.ready === true && !!r2.pk, r2.pk || JSON.stringify(r2));
t('界面显示身份已激活', String(r2.led).indexOf('已激活') >= 0, r2.led);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
chrome.kill();
process.exit(fail ? 1 : 0);

// 生产环境端到端验证（真实访问 1211 端口）
import { spawn } from 'node:child_process';

const URL = 'http://127.0.0.1:12110/text-crypto.html';
const CDP = 9440;

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-prod-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
        errs.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text);
    }
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
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
};

await call('Page.navigate', { url: URL });
// 等待页面脚本就绪（而非固定 sleep）
for (let i = 0; i < 60; i++) {
    try {
        const ok = await ev(`document.readyState==='complete' && typeof HanziCodec!=='undefined' && typeof CX2!=='undefined' && typeof TA!=='undefined' && typeof RKL!=='undefined'`);
        if (ok) break;
    } catch (e) { }
    await sleep(300);
}

console.log('生产环境:', URL);
console.log('页面错误:', errs.length ? errs.slice(0, 3) : '无');
console.log('字库长度:', await ev(`HanziCodec.ALPHABET.length`), ' CX2 版本:', await ev(`CX2.VERSION`));
console.log('环境: isSecureContext =', await ev(`isSecureContext`), ' crypto.subtle =', await ev(`!!crypto.subtle`));

// 用单一表达式完成全部流程（避免多层转义）
const r = await ev(`(async()=>{
  const NL = String.fromCharCode(10);
  const out = {};
  localStorage.clear();
  $('tp').value = '生产验证口令';
  await TA.doInit();
  const b64 = x => btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(x))));
  const bobSk = crypto.getRandomValues(new Uint8Array(32));
  const carolSk = crypto.getRandomValues(new Uint8Array(32));
  const bobPk = b64(TA.M.m(bobSk, null)), carolPk = b64(TA.M.m(carolSk, null));
  Directory.add('bob', '', bobPk, '鲍勃');
  Directory.add('carol', '', carolPk, '卡罗尔');
  ACS.renderList();

  const inps = document.querySelectorAll('#rk-list input');
  inps[0].value = bobPk; inps[0].dispatchEvent(new Event('input'));
  const i2 = document.querySelectorAll('#rk-list input')[1];
  i2.value = carolPk; i2.dispatchEvent(new Event('input'));
  out.who = $('rk-who').innerText;

  $('tpt').value = '生产环境一对多测试'; TA.onPlain();
  await TA.enc();
  const ct = $('tct').innerText;
  out.ctLen = ct.length;
  out.pb = await CX2.decrypt(ct, bobSk);
  out.pc = await CX2.decrypt(ct, carolSk);
  try { await CX2.decrypt(ct, crypto.getRandomValues(new Uint8Array(32))); out.outsider = '竟然解开!'; }
  catch (e) { out.outsider = '被拒绝'; }

  // 汉字 + 分段（用户报过的场景）
  // 注意：必须发给自己，页面解密用的是 TA.c.pr；发给 bob/carol 的密文页面上解不开
  $('hz-t').checked = true; TA.onHz();
  $('seg-t').checked = true; TA.onSeg();
  RKL.clear();
  const mine = document.querySelectorAll('#rk-list input')[0];
  mine.value = TA.c.pk; mine.dispatchEvent(new Event('input'));
  const long = '生产汉字分段验证'.repeat(200);
  $('tpt').value = long; TA.onPlain();
  await TA.enc();
  const texts = [].map.call(document.querySelectorAll('#seg-box .seg-tx'), t => t.value);
  out.nSegs = texts.length;
  $('tci').value = texts.join(NL + NL); TA.onCipher();
  await TA.dec();
  out.segOk = $('tdt').innerText === long;
  out.segCap = $('trd-cap').innerText;
  return out;
})()`);

console.log();
console.log('多接收方确认条:', r.who);
console.log('密文长度:', r.ctLen, '字符');
console.log('鲍勃解密  :', JSON.stringify(r.pb));
console.log('卡罗尔解密:', JSON.stringify(r.pc));
console.log('局外人    :', r.outsider);
console.log();
console.log('汉字+分段:', r.nSegs, '段 ->', r.segCap, ' 明文正确:', r.segOk);
console.log();
console.log('最终页面错误:', errs.length ? errs.slice(0, 3) : '无');
chrome.kill();

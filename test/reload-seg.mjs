// 关键差异点：跨页面刷新 / 重新初始化身份后再解密
//
// 用户实际流程：加密（可能已加密了消息）-> 刷新 / 重新输口令 -> 粘贴解密。
// 若两次身份派生不一致（例如口令输入被输入法污染），就会「认证失败」，
// 且短消息因测试时用同一会话而不易暴露。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9428;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-rel-${process.pid}`, 'about:blank'
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
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
};

await call('Page.navigate', { url: URL });
await sleep(2500);

// 第一步：加密一条长消息，记下密文与身份公钥
const step1 = await ev(`(async()=>{
  localStorage.clear();
  $('tp').value='跨刷新测试口令'; await TA.doInit();
  const pk1=TA.c.pk;
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=pk1; inps[0].dispatchEvent(new Event('input'));
  $('seg-t').checked=true; TA.onSeg();
  const plain='跨刷新长消息'.repeat(200);
  $('tpt').value=plain; TA.onPlain();
  await TA.enc();
  const ct=$('tct').innerText;
  const texts=[...document.querySelectorAll('#seg-box .seg-tx')].map(t=>t.value);
  return {pk1, ct, texts, plain, nSegs:texts.length};
})()`);
console.log('加密完成: 公钥', step1.pk1.slice(0,12), ' 段数', step1.nSegs, ' 密文', step1.ct.length);

// 第二步：刷新页面 -> 重新初始化同一口令 -> 粘贴解密
await call('Page.reload');
await sleep(2500);
const step2 = await ev(`(async()=>{
  const out={};
  $('tp').value='跨刷新测试口令'; await TA.doInit();
  out.pk2=TA.c.pk;
  return out;
})()`);
console.log('刷新后重新初始化: 公钥', step2.pk2.slice(0,12), ' 与之前一致?', step2.pk2 === step1.pk1);

const step3 = await ev(`(async()=>{
  const out={};
  // ① 粘完整密文
  $('tci').value=${JSON.stringify(step1.ct)}; TA.onCipher(); await TA.dec();
  out.fullCap=$('trd-cap').innerText; out.fullOk=$('tdt').innerText===${JSON.stringify(step1.plain)};

  // ② 粘全部分段
  $('tci').value=${JSON.stringify(step1.texts.join('\n\n'))}; TA.onCipher(); await TA.dec();
  out.segCap=$('trd-cap').innerText; out.segOk=$('tdt').innerText===${JSON.stringify(step1.plain)};

  return out;
})()`);
console.log();
console.log('① 粘完整密文:', step3.fullCap, ' 明文正确:', step3.fullOk);
console.log('② 粘全部分段:', step3.segCap, ' 明文正确:', step3.segOk);
chrome.kill();

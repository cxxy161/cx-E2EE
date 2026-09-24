// 复现用户真实操作：分段时点「复制密文」-> 粘贴回去解密
//
// 前几轮测试都是「直接取段文本框内容」，而用户实际操作是点复制按钮。
// 本测试走真实按钮路径，捕获按钮真正写进剪贴板的内容。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9427;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-btn-${process.pid}`, 'about:blank'
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

// 拦截 clipboard.writeText，捕获按钮实际复制的内容
await ev(`(()=>{
  window.__copied=[];
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (t)=>{ window.__copied.push(t); return Promise.resolve(); };
  return true;
})()`);

const r = await ev(`(async()=>{
  const out={};
  localStorage.clear();
  $('tp').value='btn-test'; await TA.doInit();
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
  $('seg-t').checked=true; TA.onSeg();
  const plain='分段按钮测试内容'.repeat(200);
  $('tpt').value=plain; TA.onPlain();
  await TA.enc();
  const ct=$('tct').innerText;
  out.nSegs=TA._segments(ct).length;
  out.ctLen=ct.length;

  // ① 点主「复制密文」按钮
  window.__copied=[];
  document.querySelector('#trc .cp').click();
  await new Promise(r=>setTimeout(r,300));
  out.mainCopyLen = window.__copied.length ? window.__copied[0].length : 0;
  out.mainCopyIsFullCt = window.__copied.length ? window.__copied[0]===ct : false;
  out.mainCopyHead = window.__copied.length ? window.__copied[0].slice(0,30) : '';

  // 用主按钮复制的内容粘回解密
  if (window.__copied.length) {
    $('tci').value=window.__copied[0]; TA.onCipher(); await TA.dec();
    out.mainCap=$('trd-cap').innerText;
  }

  // ② 点「复制全部 N 段」
  window.__copied=[];
  const allBtn=document.querySelector('#seg-box [data-all]');
  out.hasAllBtn=!!allBtn;
  if (allBtn) {
    allBtn.click();
    await new Promise(r=>setTimeout(r,300));
    out.allCopyLen = window.__copied.length ? window.__copied[0].length : 0;
    $('tci').value=window.__copied[0]; TA.onCipher(); await TA.dec();
    out.allCap=$('trd-cap').innerText;
    out.allOk=$('tdt').innerText===plain;
  }

  // ③ 只点第 1 段
  window.__copied=[];
  const segBtn=document.querySelector('#seg-box [data-seg="0"]');
  segBtn.click();
  await new Promise(r=>setTimeout(r,300));
  out.segCopyLen = window.__copied.length ? window.__copied[0].length : 0;
  $('tci').value=window.__copied[0]; TA.onCipher(); await TA.dec();
  out.segCap=$('trd-cap').innerText;

  return out;
})()`);

console.log('密文', r.ctLen, '字符 ->', r.nSegs, '段\n');
console.log('① 主「复制密文」按钮');
console.log('   复制长度:', r.mainCopyLen, ' 等于完整密文?', r.mainCopyIsFullCt);
console.log('   头部:', JSON.stringify(r.mainCopyHead));
console.log('   粘回解密:', r.mainCap || '(未执行)');
console.log();
console.log('② 「复制全部 N 段」按钮 (存在:', r.hasAllBtn, ')');
console.log('   复制长度:', r.allCopyLen);
console.log('   粘回解密:', r.allCap || '(未执行)', ' 明文一致:', r.allOk);
console.log();
console.log('③ 「复制本段」（仅第1段）');
console.log('   复制长度:', r.segCopyLen);
console.log('   粘回解密:', r.segCap || '(未执行)');
chrome.kill();

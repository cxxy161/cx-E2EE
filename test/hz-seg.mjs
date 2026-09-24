// 逐一验证「汉字形态 + 分段」这个我尚未覆盖的组合
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9429;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-hz-${process.pid}`, 'about:blank'
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

const r = await ev(`(async()=>{
  const out={};
  localStorage.clear();
  $('tp').value='hz-seg'; await TA.doInit();
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
  // 同时开：汉字密文 + 自动分段
  $('hz-t').checked=true; TA.onHz();
  $('seg-t').checked=true; TA.onSeg();
  const plain='汉字分段组合测试'.repeat(200);
  $('tpt').value=plain; TA.onPlain();
  await TA.enc();
  const ct=$('tct').innerText;
  out.ctLen=ct.length;
  out.isHanzi=HanziCodec.isHanzi(ct);
  const segs=TA._segments(ct);
  out.nSegs=segs.length;
  out.segLens=segs.map(s=>s.length);
  // 段长是否超 2000（用户 QQ 上限的初衷）
  out.segOverLimit=segs.map(s=>s.length>2000);

  // 段文本框内容（含段头），检查段头字符是否混入汉字体
  const texts=[...document.querySelectorAll('#seg-box .seg-tx')].map(t=>t.value);
  out.headSamples=texts.map(t=>t.slice(0,26));
  out.bodyStarts=texts.map(t=>t.slice(t.indexOf('|',t.lastIndexOf('|'))+1, t.indexOf('|',t.lastIndexOf('|'))+10));

  // ① 粘完整密文
  $('tci').value=ct; TA.onCipher(); await TA.dec();
  out.fullCap=$('trd-cap').innerText; out.fullOk=$('tdt').innerText===plain;

  // ② 粘全部段
  $('tci').value=texts.join('\\n\\n'); TA.onCipher(); await TA.dec();
  out.segCap=$('trd-cap').innerText; out.segOk=$('tdt').innerText===plain;

  // ③ 原样调用 _mergeSegments 看合并结果是否是纯汉字
  const mg=TA._mergeSegments(texts.join('\\n\\n'));
  out.mergedIsPureHanzi=! /[^\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]/.test(mg.cipher);
  out.mergedSample=mg.cipher.slice(0,20);
  out.mergedEqCt=mg.cipher===ct;

  return out;
})()`);

console.log('密文', r.ctLen, '字符; isHanzi=', r.isHanzi, '; ', r.nSegs, '段');
console.log('段长:', JSON.stringify(r.segLens), ' 超过2000的段:', JSON.stringify(r.segOverLimit));
console.log('段头样例:', JSON.stringify(r.headSamples[0]));
console.log('段体起始:', JSON.stringify(r.bodyStarts[0]));
console.log();
console.log('① 粘完整密文:', r.fullCap, ' 正确:', r.fullOk);
console.log('② 粘全部分段:', r.segCap, ' 正确:', r.segOk);
console.log();
console.log('合并结果 = 原密文?', r.mergedEqCt);
console.log('合并结果是纯汉字?', r.mergedIsPureHanzi, ' 样例:', JSON.stringify(r.mergedSample));
chrome.kill();

// 精确定位「短消息正常、分段失败」
//
// 用户环境线索：CX2.VERSION=2, 字库=2048（环境正常），短消息 OK，分段必败。
// 本测试用**单收件人**（最简场景）+ 超长明文，走完整 UI 路径，
// 并在每一步打印实际值，找出第一处不一致。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9425;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-sg-${process.pid}`, 'about:blank'
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
  $('tp').value='seg-bug'; await TA.doInit();
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
  out.nKeys=RKL.keys().length;

  // 明文长度逐步加大，找出从哪一段开始出错
  const cases=[];
  for (const repeat of [10, 100, 200, 300]) {
    $('tpt').value='测试'.repeat(repeat); TA.onPlain();
    $('seg-t').checked=true; TA.onSeg();
    await TA.enc();
    const ct=$('tct').innerText;
    const segs=TA._segments(ct);
    // 复原（模拟接收方粘贴全部段）
    const texts=[...document.querySelectorAll('#seg-box .seg-tx')].map(t=>t.value);
    // 未真正分段时，段文本框应为空（不该让用户去粘不存在的段）
    if (segs.length < 2) {
      cases.push({repeat, ctLen:ct.length, nSegs:segs.length, bodyLens:segs.map(s=>s.length),
                  noSegBox: texts.length===0, note:'未分段，直接复制主密文即可'});
      continue;
    }
    const mg=TA._mergeSegments(texts.join('\\n\\n'));
    // 直接比较合并结果与原密文
    const same = mg.cipher === ct;
    // 用合并结果直接解密（绕过 UI）
    let direct=null, directErr=null;
    try { direct = await CX2.decrypt(mg.cipher, TA.c.pr); } catch(e){ directErr=String(e&&e.message?e.message:e); }
    // 走 UI 解密
    $('tci').value=texts.join('\\n\\n'); TA.onCipher(); await TA.dec();
    cases.push({
      repeat, ctLen:ct.length, nSegs:segs.length,
      bodyLens: segs.map(s=>s.length),
      mergedSame: same, mergedLen: mg.cipher.length,
      directOk: direct===$('tpt').value, directErr,
      uiCap: $('trd-cap').innerText
    });
  }
  out.cases=cases;
  return out;
})()`);

console.log('有效公钥数:', r.nKeys);
console.log();
for (const c of r.cases) {
    console.log('明文 repeat=' + c.repeat);
    console.log('  密文', c.ctLen, '字符 ->', c.nSegs, '段，段体长度', JSON.stringify(c.bodyLens));
    console.log('  合并==原密文 :', c.mergedSame, '(合并后', c.mergedLen, ')');
    console.log('  直调解密     :', c.directOk ? 'OK' : ('FAIL ' + c.directErr));
    console.log('  UI 解密      :', c.uiCap || '(空)');
    console.log();
}
chrome.kill();

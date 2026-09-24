// 暴力扫描：找出分段失败的边界条件
//
// 已知：repeat=300（2576 字符，2 段）正常；用户在实际使用中失败。
// 那么失败一定发生在某个特定形态（更多段数 / 特定长度 / 汉字形态）。
// 本测试扫描多种明文长度 × 两种编码形态，逐一定位。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9426;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-sweep-${process.pid}`, 'about:blank'
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
  const out=[];
  localStorage.clear();
  $('tp').value='sweep'; await TA.doInit();
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
  $('seg-t').checked=true; TA.onSeg();

  for (const useHz of [false, true]) {
    $('hz-t').checked=useHz; TA.onHz();
    // 扫明文长度：覆盖 1~6 段
    for (const repeat of [300, 600, 900, 1200, 1500, 2000, 3000]) {
      const plain='测'.repeat(repeat);
      $('tpt').value=plain; TA.onPlain();
      await TA.enc();
      const ct=$('tct').innerText;
      const texts=[...document.querySelectorAll('#seg-box .seg-tx')].map(t=>t.value);
      const segs=TA._segments(ct);
      if (segs.length<2) { out.push({useHz, repeat, nSegs:segs.length, skip:'未分段'}); continue; }
      // 模拟接收方：粘贴全部段
      $('tci').value=texts.join('\\n\\n'); TA.onCipher(); await TA.dec();
      const cap=$('trd-cap').innerText;
      out.push({
        useHz, repeat, ctLen:ct.length, nSegs:segs.length,
        segLens: segs.map(s=>s.length),
        ok: cap.indexOf('✓')===0,
        cap: cap.slice(0,60),
        plainOk: $('tdt').innerText===plain
      });
    }
  }
  return out;
})()`);

console.log('Base64 形态:');
for (const c of r.filter(x=>!x.useHz)) {
    console.log('  ' + (c.skip ? 'SKIP ' : (c.ok && c.plainOk ? 'PASS ' : 'FAIL ')) +
        'repeat=' + String(c.repeat).padStart(4) + ' 密文' + String(c.ctLen).padStart(5) +
        ' ' + c.nSegs + '段 段长' + JSON.stringify(c.segLens || []) +
        (c.cap ? '  ' + c.cap : '') + (c.skip ? '  (' + c.skip + ')' : ''));
}
console.log('\n汉字形态:');
for (const c of r.filter(x=>x.useHz)) {
    console.log('  ' + (c.skip ? 'SKIP ' : (c.ok && c.plainOk ? 'PASS ' : 'FAIL ')) +
        'repeat=' + String(c.repeat).padStart(4) + ' 密文' + String(c.ctLen).padStart(5) +
        ' ' + c.nSegs + '段 段长' + JSON.stringify(c.segLens || []) +
        (c.cap ? '  ' + c.cap : '') + (c.skip ? '  (' + c.skip + ')' : ''));
}
chrome.kill();

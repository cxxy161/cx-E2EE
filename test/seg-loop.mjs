// 分段复制 -> 粘贴 的完整闭环验证
//
// 覆盖用户实际动作：
//   ① 多段全粘（顺序打乱、含换行、含段间空白）-> 解密成功
//   ② 单段粘贴 -> 明确提示还缺哪些段（而不是「认证失败」）
//   ③ 无段头的短密文（未分段）-> 直接解密成功
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'src');
const PORT = 9012, CDP = 9412;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
    try {
        const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
        const b = await readFile(join(ROOT, p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(b);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-seg2-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 60; i++) {
    try {
        const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/text-crypto.html`)}`, { method: 'PUT' });
        tg = await r.json(); break;
    } catch { await sleep(300); }
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
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
};
for (let i = 0; i < 60; i++) {
    try { if (await ev(`typeof RKL!=='undefined'&&typeof TA!=='undefined'`)) break; } catch { }
    await sleep(200);
}

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  :: ' + extra : '')); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

// 准备：初始化 + 发给自己的公钥（这样页面能自解）
const setup = await ev(`(async()=>{
  localStorage.clear();
  $('tp').value='seg-loop-test'; await TA.doInit();
  const inps=document.querySelectorAll('#rk-list input');
  inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
  $('seg-t').checked=true; TA.onSeg();
  // 长文 -> 多段
  $('tpt').value='分段闭环验证内容🔐'.repeat(300); TA.onPlain();
  await TA.enc();
  const ct=$('tct').innerText;
  const segs=[...document.querySelectorAll('#seg-box .seg-tx')].map(t=>t.value);
  return {ctLen:ct.length, nSegs:segs.length, segs};
})()`);
console.log('准备：密文 ' + setup.ctLen + ' 字符，切为 ' + setup.nSegs + ' 段');

console.log('\n① 多段全粘（打乱顺序 + 加换行空白）');
const r1 = await ev(`(async()=>{
  const segs=${JSON.stringify(setup.segs)};
  const shuffled=segs.slice().reverse().join('\\n\\n  \\n');
  $('tci').value=shuffled; TA.onCipher(); await TA.dec();
  return {cap:$('trd-cap').innerText, plain:$('tdt').innerText.length};
})()`);
t('打乱顺序粘贴仍解密成功', r1.cap.indexOf('✓') === 0, r1.cap);

console.log('\n② 单段粘贴 -> 精确缺口提示');
const r2 = await ev(`(async()=>{
  const segs=${JSON.stringify(setup.segs)};
  $('tci').value=segs[0]; TA.onCipher(); await TA.dec();
  return $('trd-cap').innerText;
})()`);
t('提示还缺哪些段（非"认证失败"）', r2.indexOf('还缺第') >= 0, r2);
t('不再误报认证失败', r2.indexOf('认证失败') < 0);

console.log('\n③ 缺一段 -> 精确指出缺哪段');
const r3 = await ev(`(async()=>{
  const segs=${JSON.stringify(setup.segs)};
  const partial=segs.filter((_,i)=>i!==1).join('\\n');
  $('tci').value=partial; TA.onCipher(); await TA.dec();
  return $('trd-cap').innerText;
})()`);
t('指出缺少第 2 段', r3.indexOf('第 2') >= 0, r3);

console.log('\n④ 未分段短密文 -> 直接解密');
const r4 = await ev(`(async()=>{
  $('tpt').value='短消息'; TA.onPlain();
  await TA.enc();
  const ct=$('tct').innerText;
  const nSegs=document.querySelectorAll('#seg-box .seg-tx').length;
  $('tci').value=ct; TA.onCipher(); await TA.dec();
  return {cap:$('trd-cap').innerText, nSegs, plain:$('tdt').innerText};
})()`);
t('短密文不分段', r4.nSegs === 0, '分段区无内容');
t('短密文解密成功', r4.plain === '短消息', r4.cap);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
chrome.kill(); server.close();
process.exit(fail ? 1 : 0);

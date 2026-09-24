// 助记句输入框：改为 type="text" 后仍应默认遮蔽，且可切换显示
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'src');
const PORT = 9013, CDP = 9413;
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
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-pw-${process.pid}`, 'about:blank'
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
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
};
for (let i = 0; i < 60; i++) {
    try { if (await ev(`typeof TA!=='undefined'`)) break; } catch { }
    await sleep(200);
}

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  :: ' + extra : '')); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

console.log('助记句输入框');
const r = await ev(`(()=>{
  const el=$('tp');
  const cs=getComputedStyle(el);
  return {
    type: el.type,
    maskedClass: el.classList.contains('masked'),
    textSecurity: cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security'),
    btn: $('tp-eye').textContent.trim()
  };
})()`);
t('type = text（中文输入法可用）', r.type === 'text', r.type);
t('默认带 masked 类（遮蔽）', r.maskedClass === true);
t('CSS 掩码生效', String(r.textSecurity).indexOf('disc') >= 0, String(r.textSecurity));
t('按钮初始显示「显示」', r.btn.indexOf('显示') >= 0, r.btn);

console.log('\n显隐切换');
const r2 = await ev(`(()=>{
  TA.togglePass();
  const el=$('tp');
  const a={masked:el.classList.contains('masked'), btn:$('tp-eye').textContent.trim(), type:el.type};
  TA.togglePass();
  const b={masked:el.classList.contains('masked'), btn:$('tp-eye').textContent.trim()};
  return {a,b};
})()`);
t('点击后取消遮蔽、按钮变「隐藏」', r2.a.masked === false && r2.a.btn.indexOf('隐藏') >= 0, JSON.stringify(r2.a));
t('再次点击恢复遮蔽', r2.b.masked === true && r2.b.btn.indexOf('显示') >= 0, JSON.stringify(r2.b));
t('切换过程 type 恒为 text', r2.a.type === 'text');

console.log('\n中文助记句可正常输入并派生身份');
const r3 = await ev(`(async()=>{
  $('tp').value='';
  $('tp').value='我的中文口令测试';
  $('tp').dispatchEvent(new Event('input'));
  await TA.doInit();
  return {pk: TA.c.pk ? TA.c.pk.slice(0,16) : null, ready: TA._ready};
})()`);
t('中文口令能派生出身份', r3.ready === true && !!r3.pk, r3.pk || '未激活');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
chrome.kill(); server.close();
process.exit(fail ? 1 : 0);

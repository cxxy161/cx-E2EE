// 视觉验证：明/暗 × 移动/桌面 截图 + 对比度抽样
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/home/cxxy168/code/html/cx-E2EE/src';
const OUT = '/home/cxxy168/code/html/cx-E2EE/.shots';
const PORT = 8981, CDP = 9381;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

await mkdir(OUT, { recursive: true });
const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
        const b = await readFile(join(ROOT, p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(b);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--remote-debugging-port=' + CDP,
    `--user-data-dir=/tmp/cx-shot-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/text-crypto.html`)}`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
await call('Runtime.enable');
await call('Page.enable');
async function ev(ex) {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? (r.result.result ? r.result.result.value : undefined) : undefined;
}
for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'&&typeof TA!=='undefined'`)) break; } catch { } await sleep(200); }

// 造出"已初始化 + 有联系人 + 有结果"的真实状态，避免截到空页面
await ev(`(async()=>{
  localStorage.clear();
  $('tp').value='demo-passphrase-2026'; await TA.doInit();
  const pk=TA.c.pk;
  // 造一个假联系人（用真实格式的 32 字节 Base64）
  const other=btoa(String.fromCharCode.apply(null,Array.from({length:32},(_,i)=>(i*7+11)%256)));
  Directory.add('alice', '', other, '爱丽丝');
  Directory.add('bob', '', btoa(String.fromCharCode.apply(null,Array.from({length:32},(_,i)=>(i*13+29)%256))), '鲍勃');
  ACS.renderList();
  $('trk').value=other; ACS.valTrk();
  $('tpt').value='这是一条端到端加密的测试消息，用于检查版式与配色。'; TA.onPlain();
  $('hz-t').checked=true; TA.onHzSilent();
  document.querySelector('.mtb').style.display='none';
  $('sp-d').classList.add('on');
  await TA.enc();
  $('tci').value=$('tct').textContent.trim(); TA.onCipher();
  await TA.dec();
})()`);
await sleep(500);

const viewports = [
    { name: 'desktop', w: 1280, h: 900, mobile: false },
    { name: 'mobile', w: 390, h: 844, mobile: true }
];
const shots = [];
for (const theme of ['light', 'dark']) {
    await ev(`UI.setTheme('${theme}'); document.querySelector('.mtb').style.display=''; $('sp-d').classList.remove('on'); $('sp-e').classList.add('on');`);
    await sleep(350);
    for (const vp of viewports) {
        await call('Emulation.setDeviceMetricsOverride', {
            width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile
        });
        await sleep(300);
        // 整页截图
        const m = await call('Page.getLayoutMetrics');
        const h = Math.min(Math.ceil(m.cssContentSize.height), 12000);
        const r = await call('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: vp.w, height: h, scale: 1 }
        });
        const file = join(OUT, `${theme}-${vp.name}.png`);
        await writeFile(file, Buffer.from(r.data, 'base64'));
        shots.push({ file, theme, vp: vp.name, height: h });
        // 对比度抽样
        const cc = await ev(`(()=>{
          const g=(el,p)=>{ if(!el) return null; const s=getComputedStyle(el); return { [p]: s[p] }; };
          const cs=getComputedStyle(document.body);
          const card=document.querySelector('.card');
          const btn=document.querySelector('.btn');
          const dim=document.querySelector('.meta');
          return {
            theme: document.documentElement.getAttribute('data-theme'),
            bodyBg: cs.backgroundColor, bodyFg: cs.color,
            cardBg: getComputedStyle(card).backgroundColor,
            btnBg: getComputedStyle(btn).backgroundImage.slice(0,60), btnFg: getComputedStyle(btn).color,
            dimFg: dim?getComputedStyle(dim).color:null,
            inputFontSize: getComputedStyle($('trk')).fontSize,
            btnMinH: btn.getBoundingClientRect().height
          };
        })()`);
        console.log(`${theme}/${vp.name}: bg=${cc.bodyBg} fg=${cc.bodyFg} card=${cc.cardBg} dim=${cc.dimFg} inputFont=${cc.inputFontSize} btnH=${Math.round(cc.btnMinH)}`);
    }
}
await call('Emulation.clearDeviceMetricsOverride');
console.log('\n截图:');
shots.forEach(s => console.log('  ' + s.file + '  (' + s.height + 'px 高)'));
chrome.kill(); server.close();
process.exit(0);

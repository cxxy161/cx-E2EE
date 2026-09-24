// 跨版本线格式互通验证：HEAD 版 text-crypto.html ↔ 重构版
// 目的：证明本次重构没有改动密文格式（k/i/c 结构 + PBKDF2 参数 + X25519），
//       重构前后可以互相解密对方的密文。
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const REPO = '/home/cxxy168/code/html/cx-E2EE';
const TMP = '/tmp/cx-wire';
const PORT = 8979, CDP = 9379;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// 准备旧版快照
await mkdir(TMP, { recursive: true });
const oldHtml = execSync(`git -C ${REPO} show HEAD:src/text-crypto.html`, { encoding: 'utf8' });
await writeFile(join(TMP, 'old.html'), oldHtml);
for (const f of ['core.js', 'theme.css']) {
    await writeFile(join(TMP, f), await readFile(join(REPO, 'src', f)));
}

const DIRS = { '/old/': TMP, '/new/': join(REPO, 'src') };
const server = http.createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    for (const [pre, dir] of Object.entries(DIRS)) {
        if (!u.startsWith(pre)) continue;
        let p = u.slice(pre.length) || 'text-crypto.html';
        if (p === 'text-crypto.html' && dir === TMP) p = 'old.html';
        try {
            const b = await readFile(join(dir, p));
            res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
            res.end(b);
        } catch { res.writeHead(404); res.end('nf'); }
        return;
    }
    res.writeHead(404); res.end('nf');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-wire-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function page(url) {
    let tg = null;
    for (let i = 0; i < 80; i++) {
        try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }); tg = await r.json(); break; }
        catch { await sleep(300); }
    }
    if (!tg) throw new Error('chrome not ready');
    const ws = new WebSocket(tg.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    let mid = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const call = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
    await call('Runtime.enable');
    const ev = async ex => {
        const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result ? (r.result.result ? r.result.result.value : undefined) : undefined;
    };
    for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'&&typeof TA!=='undefined'`)) break; } catch { } await sleep(200); }
    return { ev, ws };
}

const PW = 'cross-version-shared-pass';
const PLAIN_A = '跨版本互通测试 ⚡';
const PLAIN_B = '反向：新加密 → 旧解密';

// 说明：直接调用两侧的加密引擎（TA.c.run / TA.c.init），
// 绕开各版本 UI 的异步与事件路径差异，只验证线格式本身。

const o = await page(`http://127.0.0.1:${PORT}/old/text-crypto.html`);
const oldPk = await o.ev(`(async()=>{ await TA.c.init(${JSON.stringify(PW)}); return TA.c.pk; })()`);
const oldB64 = await o.ev(`(async()=>{ return await TA.c.run(${JSON.stringify(oldPk)}, ${JSON.stringify(PLAIN_A)}, false); })()`);
o.ws.close();

// ② 新版：相同口令 → 相同身份；解密旧版密文；再为新版加密
const n = await page(`http://127.0.0.1:${PORT}/new/text-crypto.html`);
const newPk = await n.ev(`(async()=>{ $('tp').value=${JSON.stringify(PW)}; await TA.doInit(); return TA.c.pk; })()`);
const newPlain = await n.ev(`(async()=>{ return await TA.c.run(null, ${JSON.stringify(oldB64)}, true); })()`);
const newB64 = await n.ev(`(async()=>{ return await TA.c.run(${JSON.stringify(oldPk)}, ${JSON.stringify(PLAIN_B)}, false); })()`);
n.ws.close();

// ③ 旧版：解密新版密文
const o2 = await page(`http://127.0.0.1:${PORT}/old/text-crypto.html`);
const oldPlain = await o2.ev(`(async()=>{ await TA.c.init(${JSON.stringify(PW)}); return await TA.c.run(null, ${JSON.stringify(newB64)}, true); })()`);
o2.ws.close();

const rows = [
    ['身份公钥一致（同口令→同身份）', oldPk === newPk, oldPk.slice(0, 10) + '…'],
    ['旧版加密 → 重构版解密', newPlain === PLAIN_A, JSON.stringify(newPlain)],
    ['重构版加密 → 旧版解密', oldPlain === PLAIN_B, JSON.stringify(oldPlain)]
];
rows.forEach(([n2, ok, x]) => console.log((ok ? 'PASS ' : 'FAIL ') + n2.padEnd(30) + ' :: ' + x));
const bad = rows.filter(r => !r[1]).length;
console.log('\n线格式互通: ' + (rows.length - bad) + ' 通过 / ' + bad + ' 失败');
chrome.kill(); server.close();
process.exit(bad ? 1 : 0);

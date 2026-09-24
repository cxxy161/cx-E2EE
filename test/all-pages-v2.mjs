// 全页冒烟：确认 core.js 改动未打断任何页面脚本
//
// 为什么需要它：core.js 被全部 9 个页面共享，而字库改为外部依赖后，
// 未引入 hanzi-table-v2.js 的页面曾因 HanziCodec.INIT() 抛错而整体中断。
// 本测试对每个页面收集未捕获异常，任何非 favicon 错误即判失败。
//
// 运行： node test/all-pages-v2.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'src');
const PORT = 9010, CDP = 9410;
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
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-smoke-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每个页面期望的 HanziCodec 状态：
//   table-ok  = 引入了字库（做汉字密文的页面）
//   no-table  = 未引入字库，应优雅降级而非报错
//   missing   = 页面不使用 core.js
const PAGES = [
    ['index.html', 'missing'],
    ['text-crypto.html', 'table-ok'],
    ['symmetric.html', 'table-ok'],
    ['signature.html', 'no-table'],
    ['account.html', 'no-table'],
    ['image-crypto.html', 'no-table'],
    ['pq-text-crypto.html', 'no-table'],
    ['pq-signature.html', 'no-table'],
    ['pq-account.html', 'no-table']
];

let fails = 0;
for (const [pg, want] of PAGES) {
    let tg = null;
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/${pg}`)}`, { method: 'PUT' });
            tg = await r.json(); break;
        } catch { await sleep(300); }
    }
    const ws = new WebSocket(tg.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    let mid = 0; const pend = new Map(); const errs = [];
    ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errs.push(d.exception?.description?.split('\n')[0] || d.text || 'unknown');
        }
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const call = (mm, p = {}) => new Promise((res, rej) => {
        const id = ++mid;
        pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
        ws.send(JSON.stringify({ id, method: mm, params: p }));
    });
    await call('Runtime.enable');
    await sleep(1200);
    const r = await call('Runtime.evaluate', {
        expression: `typeof HanziCodec!=='undefined' ? (HanziCodec._ok?'table-ok':'no-table') : 'missing'`,
        returnByValue: true
    });
    const got = r.result.value;
    const bad = errs.filter(e => !/favicon|net::ERR/.test(e));
    const ok = bad.length === 0 && got === want;
    if (!ok) fails++;
    console.log((ok ? 'PASS ' : 'FAIL ') + pg.padEnd(22) + ' HanziCodec=' + got +
        (got !== want ? ' (期望 ' + want + ')' : '') +
        (bad.length ? '  ERR: ' + bad.slice(0, 2).join(' | ') : ''));
    ws.close();
}
console.log(`\n汇总: ${PAGES.length - fails}/${PAGES.length} 页面通过`);
chrome.kill(); server.close();
process.exit(fails ? 1 : 0);

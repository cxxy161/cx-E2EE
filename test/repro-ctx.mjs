// 关键复现：用「非安全上下文」访问（局域网 IP，非 localhost）
//
// 用户的实际情况很可能就是：通过 http://<局域网IP>:3000 访问，
// 此时 window.isSecureContext=false，WebCrypto 的 crypto.subtle 不存在。
//
// 这个测试就是要区分：
//   A) localhost 访问  -> isSecureContext=true  -> 一切正常
//   B) 局域网 IP 访问  -> isSecureContext=false -> 复现用户的两个问题
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9420;

// 取本机局域网 IP
function lanIP() {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const a of ifs[name]) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return null;
}
const ip = lanIP();
console.log('本机局域网 IP:', ip);

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-ctx-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg = null;
for (let i = 0; i < 60; i++) {
    try {
        const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' });
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

async function probe(url) {
    await call('Page.navigate', { url });
    await sleep(2500);
    const r = await call('Runtime.evaluate', {
        expression: `({
          origin: location.origin,
          secure: window.isSecureContext,
          subtle: !!(window.crypto && window.crypto.subtle),
          clipboard: !!(navigator.clipboard),
          hasTA: typeof TA !== 'undefined'
        })`,
        returnByValue: true
    });
    return r.result.value;
}

// A) localhost
const a = await probe('http://127.0.0.1:3000/text-crypto.html');
console.log('\nA) http://127.0.0.1:3000');
console.log('   origin:', a.origin, '| isSecureContext:', a.secure, '| crypto.subtle:', a.subtle, '| clipboard:', a.clipboard);

// B) 局域网 IP
if (ip) {
    const b = await probe(`http://${ip}:3000/text-crypto.html`);
    console.log('\nB) http://' + ip + ':3000');
    console.log('   origin:', b.origin, '| isSecureContext:', b.secure, '| crypto.subtle:', b.subtle, '| clipboard:', b.clipboard);
    console.log('   TA 已加载:', b.hasTA);
}

chrome.kill();

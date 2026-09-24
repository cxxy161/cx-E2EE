// 精确复现：整段粘贴也失败（在非安全上下文 / 局域网 IP 下）
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9421;

function lanIP() {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const a of ifs[name]) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
}
const ip = lanIP();

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-wc-${process.pid}`, 'about:blank'
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
    return r.exceptionDetails ? { __err: JSON.stringify(r.exceptionDetails).slice(0, 400) } : r.result.value;
};

for (const [label, url] of [['localhost', 'http://127.0.0.1:3000/text-crypto.html'],
                            ['LAN IP', `http://${ip}:3000/text-crypto.html`]]) {
    await call('Page.navigate', { url });
    await sleep(2500);
    console.log('### ' + label + ' (' + url + ')');
    const ctx = await ev(`({secure:window.isSecureContext, subtle:!!(crypto&&crypto.subtle)})`);
    console.log('   isSecureContext:', ctx.secure, ' crypto.subtle:', ctx.subtle);

    // 初始化身份
    const init = await ev(`(async()=>{
      try{
        localStorage.clear();
        $('tp').value='ctx-test-2026'; await TA.doInit();
        return {ok:true, pk:TA.c.pk?TA.c.pk.slice(0,12):null, ready:TA._ready};
      }catch(e){ return {ok:false, err:String(e&&e.message?e.message:e)}; }
    })()`);
    console.log('   初始化身份:', JSON.stringify(init));

    if (init && init.ok) {
        const enc = await ev(`(async()=>{
          try{
            const inps=document.querySelectorAll('#rk-list input');
            inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
            $('tpt').value='整段粘贴测试'; TA.onPlain();
            await TA.enc();
            const ct=$('tct').innerText;
            return {ok:!!ct, len:ct.length, head:ct.slice(0,20)};
          }catch(e){ return {ok:false, err:String(e&&e.message?e.message:e)}; }
        })()`);
        console.log('   加密:', JSON.stringify(enc));

        const dec = await ev(`(async()=>{
          try{
            $('tci').value=$('tct').innerText; TA.onCipher();
            await TA.dec();
            return {cap:$('trd-cap').innerText, plain:$('tdt').innerText};
          }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
        })()`);
        console.log('   解密:', JSON.stringify(dec));
    }
    console.log('');
}
chrome.kill();

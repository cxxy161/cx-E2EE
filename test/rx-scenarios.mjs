// 复现用户的真实场景：B 收到 A 发的密文 -> 粘贴 -> 解密
//
// 关键差异：此前测试都是「自己加密给自己」，而这测的是
// 「他人加密 -> 我解密」，且密文可能来自聊天软件（含换行/空格）。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9424;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-rx-${process.pid}`, 'about:blank'
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
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
};
await call('Page.navigate', { url: URL });
await sleep(2500);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  :: ' + extra : '')); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

// 场景：A（发送方）用 B 的公钥加密 -> B 粘贴解密
const r = await ev(`(async()=>{
  const out={};
  localStorage.clear();
  // B 的身份
  $('tp').value='B-的-中文口令'; TA._composing=false; await TA.doInit();
  const bSk=TA.c.pr, bPk=TA.c.pk;
  out.bPk=bPk.slice(0,12);

  // A 的身份（模拟对方）：独立随机私钥
  const aSk=crypto.getRandomValues(new Uint8Array(32));

  // A 加密给 B
  const ct = await CX2.encrypt('来自 A 的消息', [bPk]);
  out.ctLen=ct.length;

  // ① 整段粘贴（干净）
  $('tci').value=ct; TA.onCipher();
  await TA.dec();
  out.clean={cap:$('trd-cap').innerText, plain:$('tdt').innerText};

  // ② 整段粘贴（模拟 QQ 复制：含换行与首尾空白）
  const wrapped = '  ' + ct.slice(0,50) + '\\n' + ct.slice(50,120) + '\\r\\n' + ct.slice(120) + '  \\n';
  $('tci').value=wrapped; TA.onCipher();
  await TA.dec();
  out.wrapped={cap:$('trd-cap').innerText, plain:$('tdt').innerText};

  // ③ 汉字密文形态（A 也开了汉字开关）
  const hz = HanziCodec.encode(Uint8Array.from(atob(ct),c=>c.charCodeAt(0)));
  $('tci').value=hz; TA.onCipher();
  await TA.dec();
  out.hanzi={cap:$('trd-cap').innerText, plain:$('tdt').innerText, isHz:HanziCodec.isHanzi(hz)};

  // ④ 汉字密文 + 换行（聊天软件常见换行）
  const hzWrapped = hz.slice(0,40)+'\\n'+hz.slice(40);
  $('tci').value=hzWrapped; TA.onCipher();
  await TA.dec();
  out.hanziWrapped={cap:$('trd-cap').innerText, plain:$('tdt').innerText};

  return out;
})()`);

console.log('B 公钥:', r.bPk, ' A 加密得到', r.ctLen, '字符\n');
console.log('① 整段粘贴（干净）      :', r.clean.cap, '|', JSON.stringify(r.clean.plain));
console.log('② 整段粘贴（含换行空白）:', r.wrapped.cap, '|', JSON.stringify(r.wrapped.plain));
console.log('③ 汉字密文形态          :', r.hanzi.cap, '|', JSON.stringify(r.hanzi.plain), '(isHanzi=' + r.hanzi.isHz + ')');
console.log('④ 汉字密文+换行         :', r.hanziWrapped.cap, '|', JSON.stringify(r.hanziWrapped.plain));
console.log('');

t('① 干净整段解密成功', r.clean.plain === '来自 A 的消息', r.clean.cap);
t('② 含换行/空白仍成功', r.wrapped.plain === '来自 A 的消息', r.wrapped.cap);
t('③ 汉字密文解密成功', r.hanzi.plain === '来自 A 的消息', r.hanzi.cap);
t('④ 汉字密文+换行仍成功', r.hanziWrapped.plain === '来自 A 的消息', r.hanziWrapped.cap);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
chrome.kill();
process.exit(fail ? 1 : 0);

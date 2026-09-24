// 对"正在运行的本地服务"做实时验证（默认 localhost:9091，可用 URL= 覆盖）
import { spawn } from 'node:child_process';
const URL_ = process.env.CX_URL || 'http://localhost:9091/text-crypto.html';
const CDP = 9391;
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-live-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tg = null;
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' }); tg = await r.json(); break; } catch { await sleep(300); } }
if (!tg) { console.log('FAIL 无法连接本地服务: ' + URL_); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR: ' + m.params.args.map(a => a.value || a.description).join(' '));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result)); ws.send(JSON.stringify({ id, method, params })); });
await call('Runtime.enable');
const ev = async ex => { const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result ? (r.result.result ? r.result.result.value : undefined) : undefined; };
for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'&&typeof TA!=='undefined'&&typeof UI!=='undefined'`)) break; } catch { } await sleep(200); }
const out = await ev(String.raw`(async()=>{
  const L=[], F=[];
  const ck=(n,c,x)=>{(c?L:F).push((c?'PASS ':'FAIL ')+n+(x?' :: '+x:''));};
  const $=id=>document.getElementById(id);
  localStorage.clear();
  L.push('URL: '+location.href);
  ck('theme.css 已加载', /rgb\((244|7),/.test(getComputedStyle(document.body).backgroundColor), getComputedStyle(document.body).backgroundColor);
  // 助记句显隐
  $('tp').type='password'; TA.togglePass();
  ck('助记句可切明文', $('tp').type==='text' && $('tp-eye').textContent.includes('隐藏'));
  TA.togglePass();
  ck('助记句可切回', $('tp').type==='password');
  // 身份 + 公钥明文
  $('tp').value='live-verify-pw'; await TA.doInit();
  ck('身份派生', TA._ready===true);
  ck('公钥明文展示', $('tpk').textContent.trim()===TA.c.pk);
  ck('已移除公钥显隐/指纹/存入通讯录', !$('tpk-eye') && !$('fp-t') && document.body.innerHTML.indexOf('存入通讯录')<0);
  // 复制内容正确
  const cp = await new Promise(res=>{ Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{res(t);return Promise.resolve();}},configurable:true}); try{CP('tpk',1);}catch(e){res('THREW');} setTimeout(()=>{const x=$('ptx'); res(($('pop')&&$('pop').classList.contains('on'))?'POP:'+x.value:'NONE');},80); });
  ck('复制公钥复制的是内容而非 id', String(cp).replace('POP:','')===TA.c.pk, 'len='+String(cp).replace('POP:','').length);
  // 加解密回环（汉字密文）
  $('trk').value=TA.c.pk; ACS.valTrk(); $('tpt').value='实时服务回环 ✓'; TA.onPlain();
  $('hz-t').checked=true; TA.onHzSilent(); await TA.enc();
  const hz=$('tct').textContent.trim();
  ck('汉字密文生成', HanziCodec.isHanzi(hz), hz.length+' 字');
  $('tci').value=hz; TA.onCipher(); await TA.dec();
  ck('解密回环', $('tdt').textContent==='实时服务回环 ✓', JSON.stringify($('tdt').textContent));
  const cp2 = await new Promise(res=>{ Object.defineProperty(navigator,'clipboard',{value:{writeText:t=>{res(t);return Promise.resolve();}},configurable:true}); CP('tct',1); setTimeout(()=>{const x=$('ptx'); res(($('pop')&&$('pop').classList.contains('on'))?'POP:'+x.value:'NONE');},80); });
  ck('复制密文复制的是内容', String(cp2).replace('POP:','')===hz, 'len='+String(cp2).replace('POP:','').length);
  return {L,F};
})()`);
console.log(out.L.join('\n'));
if (out.F.length) { console.log('--- FAILURES ---'); console.log(out.F.join('\n')); }
console.log(errs.length ? ('--- 浏览器报错 ---\n' + errs.join('\n')) : '\n无 console 报错 ✓');
console.log('\n实时服务验证: ' + out.L.filter(x => x.startsWith('PASS')).length + ' 通过 / ' + out.F.length + ' 失败');
chrome.kill();
process.exit(out.F.length || errs.length ? 1 : 0);

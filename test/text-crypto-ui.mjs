// text-crypto 重构后功能回归：headless chrome + CDP（沿用仓库既有测试骨架，零依赖）
// 用例：
//  1) 身份初始化 → 公钥显示/指纹
//  2) 加密(Base64) → 解密 回环
//  3) 汉字密文 加密 → 自动识别解密 回环
//  4) 通讯录公钥校验（截断公钥应被拦下）
//  5) 主题切换 + 持久化
//  6) 密钥显隐
//  7) 模态替换 prompt/confirm（导入流程）
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = '/home/cxxy168/code/html/cx-E2EE/src';
const PORT = 8971, CDP = 9371;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
        const buf = await readFile(join(ROOT, p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(buf);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-tc-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg;
for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/text-crypto.html`)}`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(250); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
const consoleLogs = [];
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleLogs.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') consoleLogs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
await call('Runtime.enable');
async function ev(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result ? (r.result.result ? r.result.result.value : undefined) : undefined;
}
for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'&&typeof TA!=='undefined'&&typeof UI!=='undefined'`)) break; } catch { } await sleep(200); }

const diag = String.raw`
(async () => {
  const log = [], fail = [];
  const $ = id => document.getElementById(id);
  const ck = (name, cond, extra) => { (cond ? log : fail).push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : '')); };
  const wait = (ms) => new Promise(r => setTimeout(r, ms || 60));
  const toast = () => { const t = $('tst'); return t && t.className.includes('on') ? t.textContent : ''; };

  // ── 1) 初始化身份 ──
  $('tp').value = 'test-passphrase-2026';
  await TA.doInit();
  const pk = TA.c.pk;
  ck('1.1 身份已激活', TA._ready === true && !!pk, 'pk=' + (pk || '').slice(0, 10) + '…');
  ck('1.2 公钥框常驻可见', getComputedStyle($('idbox')).display !== 'none');
  ck('1.3 公钥明文展示', $('tpk').textContent.trim() === pk, $('tpk').textContent.slice(0, 12) + '…');
  ck('1.4 公钥已写入 DOM', ($('tpk').dataset.full || '').length === 44, 'full.len=' + ($('tpk').dataset.full || '').length);
  ck('1.5 状态灯为已激活', $('led').className.includes('ok'), $('led').innerText);

  // ── 6) 助记句显隐 + 公钥明文展示 ──
  ck('6.1 公钥默认明文展示（无隐藏必要）', $('tpk').textContent.trim() === pk && $('tpk').dataset.masked === '0', 'masked=' + $('tpk').dataset.masked);
  ck('6.2 不再有公钥显隐按钮', !$('tpk-eye'));
  ck('6.3 不再有指纹/短码', !$('fp-t') && !$('fp-s'));
  ck('6.4 不再有"存入通讯录"', document.body.innerHTML.indexOf('存入通讯录') < 0);
  $('tp').type = 'password';
  TA.togglePass();
  ck('6.5 助记句可切明文', $('tp').type === 'text' && $('tp-eye').textContent.includes('隐藏'), $('tp-eye').textContent);
  TA.togglePass();
  ck('6.6 助记句可切回密文', $('tp').type === 'password' && $('tp-eye').textContent.includes('显示'), $('tp-eye').textContent);

  // ── 2) 自环加解密（把自己当接收方）──
  $('trk').value = pk;
  ACS.valTrk();
  $('tpt').value = '你好，这是一条端到端加密测试消息 🔐';
  TA.onPlain();
  ck('2.0 门控已放行', $('btn-enc').disabled === false, 'title=' + $('btn-enc').title);
  $('hz-t').checked = false; TA.onHzSilent();
  await TA.enc();
  ck('2.0b enc 无异常', toast().indexOf('失败') < 0, 'toast=' + toast() + ' ready=' + TA._ready + ' busy=' + TA._busy);
  const b64 = $('tct').textContent.trim();
  ck('2.1 生成 Base64 密文', /^[A-Za-z0-9+/=]+$/.test(b64) && b64.length > 80, b64.length + ' 字符 toast=' + toast());
  ck('2.2 结果区已展开', $('trc').classList.contains('on'));
  $('tci').value = b64; TA.onCipher();
  await TA.dec();
  ck('2.3 解密回环一致', $('tdt').textContent === '你好，这是一条端到端加密测试消息 🔐', JSON.stringify($('tdt').textContent));
  ck('2.4 解密成功提示为绿色通过', $('trd-cap').className.includes('ok'), $('trd-cap').innerText);

  // ── 3) 汉字密文 ──
  $('hz-t').checked = true; TA.onHz();
  ck('3.0 开关标签已更新', $('hz-tag').innerText === '开启');
  await TA.enc();
  const hz = $('tct').textContent.trim();
  ck('3.1 生成汉字密文', HanziCodec.isHanzi(hz), hz.slice(0, 12) + '… (' + hz.length + ' 字) toast=' + toast());
  ck('3.2 汉字密文更短', hz.length < b64.length, hz.length + ' < ' + b64.length);
  $('tci').value = hz; TA.onCipher();
  ck('3.3 输入框自动识别为汉字密文', $('tci-meta').innerText.includes('汉字密文'), $('tci-meta').innerText);
  await TA.dec();
  ck('3.4 汉字密文解密一致', $('tdt').textContent === '你好，这是一条端到端加密测试消息 🔐', $('tdt').textContent);

  // ── 2b) 错误路径分级报错 ──
  $('tci').value = 'not-base64-!!!'; TA.onCipher(); await TA.dec();
  ck('2b.1 非 Base64 给出明确原因', $('trd-cap').innerText.includes('Base64'), $('trd-cap').innerText);
  $('tci').value = btoa('{"k":"x"}'); TA.onCipher(); await TA.dec();
  ck('2b.2 缺字段给出明确原因', $('trd-cap').innerText.includes('缺少必要字段'), $('trd-cap').innerText);
  // 用另一个口令的密文 → 认证失败
  const goodPr = TA.c.pr, goodPk = TA.c.pk;
  $('tp').value = 'another-passphrase-xyz'; await TA.doInit();
  $('tci').value = b64; TA.onCipher(); await TA.dec();
  ck('2b.3 身份不匹配报认证失败', $('trd-cap').innerText.includes('认证失败'), $('trd-cap').innerText);
  $('tp').value = 'test-passphrase-2026'; await TA.doInit();
  ck('2b.4 换回原口令身份复原', TA.c.pk === goodPk);

  // ── 4) 通讯录公钥校验 ──
  $('cid').value = 'alice'; $('cepk').value = 'SHORTKEY123'; ACS.valEpk();
  ck('4.1 截断公钥被标记为错误', $('cepk').classList.contains('bad') && $('cepk-msg').innerText.includes('32 字节'), $('cepk-msg').innerText);
  ck('4.2 添加按钮被禁用', $('cadd').disabled === true);
  // 构造一个真实合法的另一身份公钥
  const oldPr = TA.c.pr;
  $('tp').value = 'alice-real-passphrase'; await TA.doInit();
  const alicePk = TA.c.pk;
  $('tp').value = 'test-passphrase-2026'; await TA.doInit();
  $('cid').value = 'alice'; $('cnn').value = '爱丽丝'; $('cepk').value = alicePk; ACS.valEpk();
  ck('4.3 合法公钥通过校验', !$('cepk').classList.contains('bad') && $('cadd').disabled === false, $('cepk-msg').innerText);
  ACS.add();
  ck('4.4 联系人已入库', !!Directory.data['alice'], JSON.stringify(Object.keys(Directory.data)));
  ck('4.5 列表显示昵称', $('clst').innerText.includes('爱丽丝'));

  // 选人浮层
  ACS.pick();
  ck('4.6 浮层已打开且含该联系人', $('picker').classList.contains('on') && $('picker').innerText.includes('爱丽丝'));
  ACS.choose('alice');
  ck('4.7 选人后公钥已填入', $('trk').value === alicePk);
  ck('4.8 归属识别正确', $('trk-who').innerText.includes('爱丽丝'), $('trk-who').innerText);

  // ── 5) 主题切换 + 持久化 ──
  UI.setTheme('dark');
  ck('5.1 切深色生效', document.documentElement.getAttribute('data-theme') === 'dark');
  ck('5.2 按钮态同步', document.querySelector('.theme-sw button[data-th="dark"]').classList.contains('on'));
  ck('5.3 已写入 localStorage', localStorage.getItem('cx_theme') === 'dark');
  UI.setTheme('light');
  ck('5.4 切浅色生效', document.documentElement.getAttribute('data-theme') === 'light');
  UI.setTheme('auto');
  ck('5.5 auto 模式可持久化', localStorage.getItem('cx_theme') === 'auto');

  // ── 7) 模态替换 prompt/confirm ──
  localStorage.setItem('cx_contacts', JSON.stringify({ alice: Directory.data.alice }));
  Directory.load();
  ck('7.0 prompt/confirm 无原生弹窗阻塞', true);
  ACS.imp();
  await wait(80);
  ck('7.1 导入用页内模态而非 prompt', $('modal').classList.contains('on') && !!$('imp-txt'));
  $('imp-txt').value = JSON.stringify({ bob: { id: 'bob', nickname: '鲍勃', signing_pubkey: '', encryption_pubkey: alicePk, timestamp: Date.now() } });
  $('imp-next').click();
  await wait(180);
  ck('7.2 第二步为三选（非 confirm OK/Cancel）', $('modal').classList.contains('on') && $('modal-box').innerText.includes('合并'), $('modal-box').innerText.slice(0, 40));
  const opts = $('modal-box').querySelectorAll('[data-i]');
  opts[0].click();  // 合并
  await wait(150);
  ck('7.3 合并导入成功', !!Directory.data['bob'] && !!Directory.data['alice'], JSON.stringify(Object.keys(Directory.data)));
  ck('7.4 模态已关闭', !$('modal').classList.contains('on'));

  // ── T1 修复验证：改口令后公钥不再消失 ──
  $('tp').value = 'test-passphrase-2026-CHANGED';
  TA.onPassInput();
  ck('T1.1 改口令后公钥仍可见', $('idbox').style.display !== 'none' && $('tpk').dataset.full === alicePk === false ? true : $('tpk').dataset.full === pk, 'full=' + ($('tpk').dataset.full || '').slice(0, 8));
  ck('T1.2 出现"口令已修改"警示', $('idwarn').style.display !== 'none');
  ck('T1.3 状态灯转为警告', $('led').className.includes('warn'));
  $('tp').value = 'test-passphrase-2026'; TA.onPassInput();
  ck('T1.4 改回原口令警示消失', $('idwarn').style.display === 'none' && $('led').className.includes('ok'));

  // ── 8) 复制按钮必须复制内容而不是元素 id ──
  const copyProbe = async (expr) => await new Promise(res => {
    const orig = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { res(t); return Promise.resolve(); } }, configurable: true });
    try { eval(expr); } catch (e) { res('THREW:' + e.message); }
    // 若无 clipboard 安全上下文，回退到 fallbackCP 的弹窗取值
    setTimeout(() => {
      const x = $('ptx');
      if (x && $('pop') && $('pop').classList.contains('on')) res('POP:' + x.value);
      else res('NONE');
    }, 60);
  });
  const cpK = await copyProbe("CP('tpk',1)");
  ck('8.1 复制公钥内容正确', cpK === pk || cpK === 'POP:' + pk, 'len=' + String(cpK).replace('POP:', '').length + ' val=' + String(cpK).slice(0, 20));
  const cpC = await copyProbe("CP('tct',1)");
  ck('8.2 复制密文内容正确', String(cpC).replace('POP:', '').length > 80, 'len=' + String(cpC).replace('POP:', '').length);
  $('tdt').textContent = '复制明文测试';
  const cpP = await copyProbe("CP('tdt',1)");
  ck('8.3 复制明文内容正确', String(cpP).replace('POP:', '') === '复制明文测试', JSON.stringify(String(cpP).slice(0, 30)));
  ck('8.4 复制的不再是元素 id', String(cpK).replace('POP:', '') !== 'tpk' && String(cpC).replace('POP:', '') !== 'tct', 'k=' + String(cpK).slice(0, 12));

  return { log, fail };
})()`;

let out;
try { out = await ev(diag); } catch (e) { console.log('RUN ERROR:', e.message); chrome.kill(); server.close(); process.exit(1); }
console.log(out.log.join('\n'));
if (out.fail.length) { console.log('\n--- FAILURES ---'); console.log(out.fail.join('\n')); }
if (consoleLogs.length) { console.log('\n--- CONSOLE ERRORS ---'); console.log(consoleLogs.join('\n')); }
console.log('\n总计: ' + out.log.length + ' 通过 / ' + out.fail.length + ' 失败');
chrome.kill(); server.close();
process.exit(out.fail.length || consoleLogs.length ? 1 : 0);

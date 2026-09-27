// 助记句输入框：必须是朴素的纯文本框，不得有任何干扰输入法的机制
//
// 背景：曾尝试 type=password / CSS 掩码 / composition 守卫，
// 均导致中文输入法不可用。现要求「完全显示、不搞花样」。
// 本测试锁定该形态，防止回归。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = 9431;
const URL = 'http://127.0.0.1:9091/text-crypto.html';

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-pf2-${process.pid}`, 'about:blank'
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

const r = await ev(`(()=>{
  const el=$('tp'); const cs=getComputedStyle(el);
  return {
    type: el.type,
    hasMaskClass: el.classList.contains('masked'),
    textSecurity: cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || 'none',
    color: cs.color,
    hasVeilBtn: !!$('tp-veil-btn'),
    hasVeilLayer: !!$('tp-veil'),
    veilHidden: $('tp-veil') ? $('tp-veil').hidden : null,
    // ⚠️ 关键：只看 hidden 属性会漏掉「CSS 覆盖 [hidden]」这一类 bug，
    //    必须查 computed display 与命中测试（下面初始状态断言即为此）
    veilDisplay: $('tp-veil') ? getComputedStyle($('tp-veil')).display : null,
    attrs: [...el.attributes].map(a=>a.name),
    oninput: el.getAttribute('oninput'),
    hasComposition: !!el.getAttribute('oncompositionstart') || !!el.getAttribute('oncompositionend'),
    hasReadonly: el.hasAttribute('readonly')
  };
})()`);

console.log('助记句输入框形态');
t('type = text', r.type === 'text', r.type);
t('无 masked 类（完全显示）', r.hasMaskClass === false);
t('无 CSS 掩码', String(r.textSecurity) === 'none', String(r.textSecurity));
t('无 composition 拦截', r.hasComposition === false);
t('初始未 readonly（可直接输入）', r.hasReadonly === false);
t('初始遮罩层隐藏（属性）', r.hasVeilLayer === true && r.veilHidden === true,
  'layer=' + r.hasVeilLayer + ' hidden=' + r.veilHidden);
t('初始遮罩层确实不可见（computed display=none）', r.veilDisplay === 'none',
  'display=' + r.veilDisplay + '（若为 flex 说明作者样式压过了 [hidden]）');
t('有手动遮蔽按钮', r.hasVeilBtn === true);
t('输入过程中不监听输入事件（只有 oninput 原生回调）',
  r.oninput === 'TA.onPassInput()', String(r.oninput));

console.log('\n初始可用性（遮罩不得挡住输入框）');
const r5 = await ev(`(()=>{
  const inp=$('tp'), ri=inp.getBoundingClientRect();
  const cx=ri.left+ri.width/2, cy=ri.top+ri.height/2;
  const hit=document.elementFromPoint(cx,cy);
  inp.focus();
  return {
    hitId: hit ? (hit.id || hit.tagName) : null,
    focused: document.activeElement===inp,
    caret: inp.selectionStart,
    readOnly: inp.hasAttribute('readonly'),
    rect: [Math.round(ri.width), Math.round(ri.height)]
  };
})()`);
t('输入框中心可命中（未被遮罩覆盖）', r5.hitId === 'tp', '命中=' + r5.hitId);
t('输入框可获得焦点', r5.focused === true, 'activeElement=' + (r5.focused ? 'tp' : '其他'));
t('初始非只读（可输入）', r5.readOnly === false);
t('输入框有实际尺寸', r5.rect[0] > 50 && r5.rect[1] > 20, r5.rect.join('x'));

console.log('\n中文输入法可用性');
const r2 = await ev(`(async()=>{
  try{
    localStorage.clear();
    $('tp').value='我的中文口令测试'; await TA.doInit();
    return {ready:TA._ready, pk:TA.c.pk?TA.c.pk.slice(0,12):null, led:$('led-t').innerText};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`);
t('中文口令可派生身份', r2.ready === true && !!r2.pk, r2.pk || JSON.stringify(r2));
t('界面显示身份已激活', String(r2.led).indexOf('已激活') >= 0, r2.led);

console.log('\n遮罩（防肩窥）行为');
const r3 = await ev(`(()=>{
  const el=$('tp'), veil=$('tp-veil'), btn=$('tp-veil-btn');
  el.value='我的中文口令测试';
  const before={ hidden:veil.hidden, readonly:el.hasAttribute('readonly'), val:el.value };
  btn.click();                                    // 遮蔽
  const on={ hidden:veil.hidden, readonly:el.hasAttribute('readonly'),
             text:veil.textContent, btn:btn.textContent, val:el.value,
             type:el.type, masked:el.classList.contains('masked'),
             textSecurity:getComputedStyle(el).webkitTextSecurity };
  veil.click();                                   // 点遮罩恢复
  const off={ hidden:veil.hidden, readonly:el.hasAttribute('readonly'), val:el.value,
              btn:btn.textContent, display:getComputedStyle(veil).display };
  return {before,on,off};
})()`);

t('点击按钮后遮罩显示', r3.on.hidden === false, 'hidden=' + r3.on.hidden);
t('遮蔽期间 readonly（输入法不激活，无 composition 可打断）', r3.on.readonly === true);
t('遮蔽文案含字数', /\d+ 字/.test(r3.on.text), r3.on.text);
t('遮蔽不改输入值', r3.on.val === '我的中文口令测试' && r3.off.val === '我的中文口令测试', r3.off.val);
t('遮蔽不动 type / 不加 masked 类', r3.on.type === 'text' && r3.on.masked === false, r3.on.type);
t('遮蔽不用 CSS 文字掩码', String(r3.on.textSecurity) === 'none', String(r3.on.textSecurity));
t('按钮文案切换为「显示」', r3.on.btn.indexOf('显示') >= 0, r3.on.btn);
t('点遮罩可恢复', r3.off.hidden === true && r3.off.readonly === false && r3.off.display === 'none',
  'hidden=' + r3.off.hidden + ' readonly=' + r3.off.readonly + ' display=' + r3.off.display);

console.log('\n输入法链路（遮蔽 → 恢复 → 中文输入仍可用）');
const r4 = await ev(`(async()=>{
  try{
    const el=$('tp');
    // 模拟真实流程：先遮蔽，恢复后再输入并派生
    Veil.show('tp');
    Veil.hide('tp');
    el.value='恢复后输入的中文口令';
    el.dispatchEvent(new Event('input',{bubbles:true}));
    await TA.doInit();
    return {ready:TA._ready, pk:TA.c.pk?TA.c.pk.slice(0,10):null,
            readonly:el.hasAttribute('readonly'), hidden:$('tp-veil').hidden};
  }catch(e){ return {err:String(e&&e.message?e.message:e)}; }
})()`);
t('恢复后输入框可写', r4.readonly === false && r4.hidden === true);
t('恢复后中文口令仍能派生身份', r4.ready === true && !!r4.pk, r4.pk || JSON.stringify(r4));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
chrome.kill();
process.exit(fail ? 1 : 0);

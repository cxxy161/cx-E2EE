// 语言隐写 UI 与基础交互验证（无算法依赖 —— 模型未交付，只验 UI 状态机）
//
// 覆盖：
//   ① 模式互斥：开语言隐写 → 汉字**强制关闭且置 disabled**（隐写模式下不得复活）
//   ② 分段开关**不因隐写锁定**（分段只是发送排版，与是否用模型无关）
//   ③ 实验横幅与面板显隐
//   ④ 模型状态机：未部署 → missing/error，按钮可用（重试），不伪造进度
//   ⑤ 容量预估：纯线性单调、字数/段数（短消息虚高告警已删除）
//   ⑥ 两步流程：语言模式下「执行加密」后出现步骤②按钮；汉字/Base64 模式不出现
//   ⑦ 步骤②在模型未就绪时禁用且给出原因
//   ⑧ 既有汉字模式路径未被破坏（回归）
//
// 运行： node test/stego/ui.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'src');
const PORT = 9042, CDP = 9442;
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
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-stui-${process.pid}`, 'about:blank'
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
let mid = 0; const pend = new Map(); let errs = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR: ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 160));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result.value;
};
for (let i = 0; i < 60; i++) {
    try { if (await ev(`typeof StegoUI!=='undefined'&&typeof TA!=='undefined'&&typeof RKL!=='undefined'`)) break; } catch { }
    await sleep(200);
}

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('语言隐写 UI 测试（无算法依赖）\n');

/* ═══ T1 初始状态 ═══ */
{
    const s = await ev(`(function(){
        return { enabled: StegoUI.enabled,
                 panel: getComputedStyle(document.getElementById('st-panel')).display,
                 step2: getComputedStyle(document.getElementById('st-step2')).display,
                 segDisabled: document.getElementById('seg-t').disabled,
                 hasBanner: !!document.querySelector('.st-banner'),
                 bannerText: (document.querySelector('.st-banner')||{}).innerText||'' };
    })()`);
    eq(s.enabled, false, 'T1 默认未启用');
    eq(s.panel, 'none', 'T1 面板默认隐藏');
    eq(s.step2, 'none', 'T1 步骤②默认隐藏');
    eq(s.segDisabled, false, 'T1 分段开关默认可用');
    ok(s.hasBanner, 'T1 实验性横幅存在');
    ok(/实验性/.test(s.bannerText) && /不提供额外保密性/.test(s.bannerText), 'T1 横幅明示实验性与无保密性');
}

/* ═══ T2 开启语言隐写 ═══ */
{
    const s = await ev(`(function(){
        document.getElementById('st-t').checked = true; StegoUI.onToggle();
        return { enabled: StegoUI.enabled,
                 panel: getComputedStyle(document.getElementById('st-panel')).display,
                 step2: getComputedStyle(document.getElementById('st-step2')).display,
                 segChecked: document.getElementById('seg-t').checked,
                 segDisabled: document.getElementById('seg-t').disabled,
                 hzChecked: document.getElementById('hz-t').checked,
                 hzDisabled: document.getElementById('hz-t').disabled,
                 tag: document.getElementById('st-tag').innerText };
    })()`);
    eq(s.enabled, true, 'T2 已启用');
    ok(s.panel !== 'none', 'T2 面板显示', s.panel);
    ok(s.step2 !== 'none', 'T2 步骤②出现', s.step2);
    eq(s.segDisabled, false, 'T2 分段开关不被隐写锁定（尊重用户选择）');
    eq(s.hzChecked, false, 'T2 汉字密文被强制关闭');
    eq(s.hzDisabled, true, 'T2 汉字开关被置 disabled（隐藏≠禁用）');
    eq(s.tag, '实验', 'T2 标签显示「实验」');
}

/* ═══ T3 模型状态机（未部署） ═══ */
{
    await sleep(900);
    const s = await ev(`(function(){
        const st=document.getElementById('st-model-state'), dl=document.getElementById('st-dl');
        return { model: StegoUI.model, stateText: st.innerText, stateCls: st.className,
                 dlText: dl.innerText, dlDisabled: dl.disabled,
                 dlBar: getComputedStyle(document.getElementById('st-dl-bar')).display };
    })()`);
    ok(['missing', 'error', 'checking'].includes(s.model), 'T3 状态为未就绪类', s.model);
    ok(/未下载|尚未部署|错误|检查中/.test(s.stateText), 'T3 状态文案如实', s.stateText);
    eq(s.dlDisabled, false, 'T3 未就绪时下载按钮可点（可重试）');
    eq(s.dlBar, 'none', 'T3 非下载中不显示进度条');
    ok(!/已就绪/.test(s.stateText), 'T3 未部署时绝不谎报就绪');
}

/* ═══ T4 容量预估（纯线性，无阶梯） ═══ */
{
    const s = await ev(`(function(){
        const t=document.getElementById('tpt');
        // 短消息与长消息都必须给出**平滑线性**的字数（不再有硬阈值告警）
        t.value='测试'.repeat(20); TA.onPlain(); StegoUI.sync();
        const small=document.getElementById('st-est').innerText;
        t.value='测试内容'.repeat(400); TA.onPlain(); StegoUI.sync();
        const big=document.getElementById('st-est').innerText;
        return { small, big, consts: {
            LIM: StegoConst.SEG_CHAR_LIMIT,
            CHUNK: Stego.CHUNK_MAX,
            SEGB: Stego.P.SEG_BYTES, PAY: Stego.P.SEG_PAYLOAD } };
    })()`);
    eq(s.consts.LIM, 2000, 'T4 单段 2000 字上限');
    eq(s.consts.CHUNK, 256, 'T4 每块明文上限 256B');
    // 新路径不再有定长几何：这两个字段恒为 0（任何新代码读它都是 bug）
    eq(s.consts.SEGB, 0, 'T4 新路径 SEG_BYTES = 0（定长桶已废除）');
    eq(s.consts.PAY, 0, 'T4 新路径 SEG_PAYLOAD = 0（定长桶已废除）');
    ok(/伪装文本约/.test(s.big), 'T4 预估给出字数', s.big.slice(0, 80));
    ok(!/帧/.test(s.big), 'T4 预估不再出现"帧"', s.big.slice(0, 80));
    ok(!/不足 200 字节/.test(s.small), 'T4 短消息不再有虚高告警（已删除）');

    /* ── 线性单调：字数随载荷单调不减，且无阶梯跳变 ── */
    const mono = await ev(`(function(){
        const out=[];
        for (const n of [0,1,2,100,255,256,257,258,512,513,1000,2000]) out.push(StegoUI.estimate(n).chars);
        return out;
    })()`);
    let monotone = true;
    for (let i = 1; i < mono.length; i++) if (mono[i] < mono[i-1]) monotone = false;
    ok(monotone, 'T4 预估随载荷单调不减（无阶梯回退）', mono.join(','));

    /* 同一块内严格线性：字数增量 == 载荷增量 × 2.15 */
    const a = JSON.parse(await ev(`JSON.stringify(StegoUI.estimate(100))`));
    const b = JSON.parse(await ev(`JSON.stringify(StegoUI.estimate(200))`));
    const slope = (b.chars - a.chars) / 100;
    ok(Math.abs(slope - 2.15) < 0.02, 'T4 块内斜率 == 2.15 字符/字节', slope.toFixed(3));

    ok(a.segs >= 1, 'T4 段数 ≥1');
    console.log(`  预估线性：${mono.join(' → ')} 字`);
}

/* ═══ T5 步骤②门禁 ═══ */
{
    const before = await ev(`document.getElementById('st-go').disabled`);
    eq(before, true, 'T5 无密文时步骤②禁用');
    const why = await ev(`document.getElementById('st-go').title`);
    ok(/执行加密/.test(why), 'T5 禁用原因指向步骤①', why);
}

/* ═══ T6 两步流程：语言模式 ═══ */
{
    // 建身份 + 填公钥
    await ev(`(async function(){ $('tp').value='ui-test'; await TA.doInit(); return 1; })()`);
    await ev(`(function(){
        const inps=document.querySelectorAll('#rk-list input');
        inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input')); return 1;
    })()`);
    const s = await ev(`(async function(){
        $('tpt').value='语言隐写两步流程验证'.repeat(20); TA.onPlain();
        await TA.enc();
        return { b64: $('tct').innerText.length,
                 stBase: (StegoUI.base64||'').length,
                 goDisabled: $('st-go').disabled,
                 goTitle: $('st-go').title,
                 stOut: getComputedStyle($('st-out')).display,
                 model: StegoUI.model };
    })()`);
    ok(s.b64 > 0, 'T6 步骤①产出 Base64', String(s.b64));
    eq(s.stBase, s.b64, 'T6 Base64 已交给步骤②');
    ok(!/执行加密/.test(s.goTitle || ''), 'T6 步骤②不再提示缺少密文', s.goTitle);
    eq(s.goDisabled, true, 'T6 模型未就绪时步骤②仍禁用');
    ok(/模型/.test(s.goTitle || ''), 'T6 禁用原因指向模型', s.goTitle);
    eq(s.stOut, 'none', 'T6 未生成时第二输出框隐藏');
}

/* ═══ T7 互斥：隐写开启时汉字不得复活（本 bug 的看门测试） ═══ */
{
    // 前置：隐写处于开启态，且尝试在隐藏行上硬置 checked
    const s = await ev(`(function(){
        document.getElementById('st-t').checked = true; StegoUI.onToggle();
        var hz = document.getElementById('hz-t');
        hz.checked = true;                       // 隐藏状态下被脚本/残留置位
        StegoUI.sync();                          // 任意一次渲染都应把闸门落下
        var s1 = { stEnabled: StegoUI.enabled,
                   hzChecked: hz.checked,
                   hzDisabled: hz.disabled,
                   lsHz: localStorage.getItem('cx_hz'),
                   step2: getComputedStyle($('st-step2')).display };
        // 再走一次 TA.onHz 直调（绕过渲染）
        hz.checked = true; TA.onHz();
        return Object.assign(s1, { hzChecked2: hz.checked, tag: document.getElementById('hz-tag').innerText });
    })()`);
    eq(s.stEnabled, true, 'T7 隐写仍开启');
    eq(s.hzChecked, false, 'T7 硬置的汉字开关被闸门回退');
    eq(s.hzDisabled, true, 'T7 汉字开关被置 disabled');
    eq(s.lsHz, '0', 'T7 持久化不残留汉字开启态');
    eq(s.hzChecked2, false, 'T7 TA.onHz 直调同样不复活');
    eq(s.tag, '关闭', 'T7 标签显示「关闭」');
    ok(s.step2 !== 'none', 'T7 步骤②可见（隐写模式）', s.step2);
}

/** 退出隐写模式，回到汉字/Base64 可选状态（供 T8/T9/T10 用） */
const stegoOff = () => ev(`(function(){
    document.getElementById('st-t').checked = false; StegoUI.onToggle(); return StegoUI.enabled;
})()`);

/* ═══ T8 回归：关掉隐写后汉字模式仍是一步出结果 ═══ */
{
    eq(await stegoOff(), false, 'T8 隐写已关闭');
    const s = await ev(`(async function(){
        $('hz-t').checked = true; TA.onHz();
        $('tpt').value='汉字回归验证'.repeat(30); TA.onPlain();
        await TA.enc();
        const ct=$('tct').innerText;
        return { len: ct.length, isHanzi: HanziCodec.isHanzi(ct),
                 roundTrip: (function(){ try{ return HanziCodec.decode(ct).length>0; }catch(e){ return false; } })(),
                 step2: getComputedStyle($('st-step2')).display };
    })()`);
    ok(s.len > 0, 'T8 汉字模式一步出密文');
    eq(s.isHanzi, true, 'T8 输出确为汉字密文');
    eq(s.roundTrip, true, 'T8 汉字密文可解码');
    eq(s.step2, 'none', 'T8 汉字模式不出现步骤②');
}

/* ═══ T9 回归：Base64 模式 ═══ */
{
    const s = await ev(`(async function(){
        $('hz-t').checked = false; TA.onHz();
        $('tpt').value='Base64回归'.repeat(20); TA.onPlain();
        await TA.enc();
        const ct=$('tct').innerText;
        return { len: ct.length, isHanzi: HanziCodec.isHanzi(ct), b64ok: /^[A-Za-z0-9+/]+={0,2}$/.test(ct) };
    })()`);
    ok(s.len > 0 && s.b64ok, 'T9 Base64 模式正常');
    eq(s.isHanzi, false, 'T9 不被误判为汉字密文');
}

/* ═══ T10 解密路径未被破坏 ═══ */
{
    const s = await ev(`(async function(){
        $('hz-t').checked = false; TA.onHz();
        const plain='解密回归验证内容'.repeat(10);
        $('tpt').value=plain; TA.onPlain(); await TA.enc();
        const ct=$('tct').innerText;
        $('tci').value=ct; TA.onCipher(); await TA.dec();
        return { cap: $('trd-cap').innerText, ok: $('tdt').innerText===plain };
    })()`);
    ok(s.ok, 'T10 加解密闭环仍然成立', s.cap);
}

/* ═══ T11 无未捕获异常 ═══ */
{
    ok(errs.length === 0, 'T11 页面无未捕获异常', errs.slice(0, 3).join(' | '));
}

console.log('═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));

try { ws.close(); } catch { }
chrome.kill(); server.close();
process.exit(fail === 0 ? 0 : 1);

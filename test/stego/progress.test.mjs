/* ═══════════════════════════════════════════════════════════════════
 * 进度条行为验证
 * ═══════════════════════════════════════════════════════════════════
 *
 * 关键点：进度条必须在**生成过程中**真的动，而不是 0% → 100% 直跳。
 * 做法：不 await generate()，而是并行轮询 DOM 采样进度值，
 *       最后检查采样序列是否单调递增且出现多个中间值。
 *
 * 需 serve.js 在 9091 运行。
 * 运行： node test/stego/progress.test.mjs
 */
import { spawn } from 'node:child_process';

const BASE = process.env.CX_BASE || 'http://127.0.0.1:9091';
const CDP = 9457;

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-stego-prog-${process.pid}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' }); tg = await r.json(); break; }
    catch { await sleep(300); }
}
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable'); await call('Page.enable');
const ev = async (ex, t = 600000) => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true, timeout: t });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 700));
    return r.result.value;
};

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };

console.log('进度条行为验证\n');

await call('Page.navigate', { url: `${BASE}/text-crypto.html` });
for (let i = 0; i < 80; i++) { try { if (await ev(`document.readyState==='complete'`, 10000)) break; } catch { } await sleep(200); }
await sleep(1000);

/* ── 准备：开模式、下模型、建身份、加密 ── */
await ev(`(async function(){
    $('st-t').checked = true; StegoUI.onToggle();
    await StegoUI.downloadModel();
    $('tp').value='prog-test'; await TA.doInit();
    var inps=document.querySelectorAll('#rk-list input');
    inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
    // 明文选长一点，保证生成过程有足够时长可采样
    $('tpt').value='进度条采样验证内容。'.repeat(60); TA.onPlain();
    await TA.enc();
    return 1;
})()`, 300000);

const prep = await ev(`({ ready: Stego.ready, base: (StegoUI.base64||'').length })`);
ok(prep.ready, '前置：模型已就绪');
ok(prep.base > 0, '前置：已有 Base64');

/* ── 关键：并行采样。不 await，先启动，再轮询 DOM ── */
{
    // 启动生成（不等待）
    await ev(`(function(){ window.__done=false; window.__err=null;
        StegoUI.generate().then(function(){window.__done=true;},function(e){window.__err=String(e);});
        return 1; })()`);

    const samples = [];
    const t0 = Date.now();
    // 在生成过程中高频采样进度条的宽度与百分比
    while (Date.now() - t0 < 120000) {
        const s = await ev(`(function(){
            var f=$('st-prog-fill'), p=$('st-prog-pct'), m=$('st-prog-meta');
            return { w: f ? f.style.width : null, pct: p ? p.innerText : null,
                     meta: m ? m.innerText : null, done: window.__done, err: window.__err,
                     box: $('st-prog') ? getComputedStyle($('st-prog')).display : null };
        })()`);
        samples.push(s);
        if (s.done || s.err) break;
        await sleep(120);
    }

    const elapsed = Date.now() - t0;
    const seenPct = samples.map(s => s.pct).filter(Boolean);
    const uniqPct = [...new Set(seenPct)];
    const numeric = uniqPct.map(x => parseFloat(x)).filter(v => !isNaN(v));
    const mid = numeric.filter(v => v > 0 && v < 100);

    console.log(`  采样 ${samples.length} 次 / ${(elapsed / 1000).toFixed(1)}s`);
    console.log(`  观察到的百分比：${uniqPct.slice(0, 14).join(' → ')}${uniqPct.length > 14 ? ' …' : ''}`);

    const last = samples[samples.length - 1];
    ok(!last.err, '① 生成过程中无异常', last.err || '');
    ok(last.done, '② 生成最终完成');

    // 核心断言：必须出现中间态，而不是 0 → 100 直跳
    ok(mid.length >= 3, '③ 进度条在生成过程中真的在动（出现多个中间百分比）',
        `中间态 ${mid.length} 个：${mid.slice(0, 8).join(',')}`);
    ok(uniqPct.length >= 4, '④ 百分比至少有 4 个不同取值', String(uniqPct.length));

    // 单调不减
    let mono = true;
    for (let i = 1; i < numeric.length; i++) if (numeric[i] < numeric[i - 1]) { mono = false; break; }
    ok(mono, '⑤ 百分比单调不减');

    // meta 里应出现 token 进度与速度
    const metas = samples.map(s => s.meta).filter(Boolean);
    const withTok = metas.filter(m => /token/.test(m));
    ok(withTok.length >= 2, '⑥ meta 显示 token 进度', withTok[0] || '(无)');
    const withSpeed = metas.filter(m => /tok\/s/.test(m));
    ok(withSpeed.length >= 1, '⑦ meta 显示速度', withSpeed[0] || '(无)');

    // 进度条容器在生成期间可见
    const visible = samples.filter(s => s.box && s.box !== 'none');
    ok(visible.length >= 2, '⑧ 进度条容器在生成期间可见', String(visible.length));

    if (metas.length) console.log(`  末次 meta：${metas[metas.length - 1]}`);
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));

try { ws.close(); } catch { }
chrome.kill();
process.exit(fail === 0 ? 0 : 1);

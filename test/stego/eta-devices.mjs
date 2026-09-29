/* ═══════════════════════════════════════════════════════════════════
 * 跨设备实测：倒计时/速度是否会随设备快慢自适应？
 * ═══════════════════════════════════════════════════════════════════
 *
 * 用 Chrome DevTools Protocol 的 Emulation.setCPUThrottlingRate 模拟
 * 「慢设备」：1x（本机）vs 4x 降速，跑**同一份载荷**，对比：
 *   · stepsTotal（估算的 token 总量）—— 应与设备无关（它是压缩比问题）
 *   · rate / etaMs（实测速率与倒计时）—— 应随设备变慢而**自适应**
 *   · 前几次 eta 是否被预热污染（首次 forward 的 JIT 代价）
 *
 * 若 rate 是硬编码的，4x 降速下 eta 会几乎不变 → 那就是 bug。
 * 若 rate 是实测的，4x 降速下 eta 应显著变大（约 4 倍量级）。
 *
 * 运行： node test/stego/eta-devices.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'src');
const MODEL_ROOT = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model');
const PORT = 9081, CDP = 9481;
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.bin': 'application/octet-stream', '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
        let base = ROOT;
        if (p.startsWith('stego-model/')) { base = MODEL_ROOT; p = p.slice('stego-model/'.length); }
        const b = await readFile(join(base, p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(b);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-eta-${process.pid}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg = null;
for (let i = 0; i < 80; i++) {
    try {
        const r = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/text-crypto.html`)}`, { method: 'PUT' });
        tg = await r.json(); break;
    } catch { await sleep(300); }
}
if (!tg) { console.error('无法连接 Chrome CDP'); process.exit(1); }
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let mid = 0; const pend = new Map();
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 700));
    return r.result.value;
};

for (let i = 0; i < 100; i++) {
    try { if (await ev(`typeof StegoUI!=='undefined'&&typeof TA!=='undefined'`)) break; } catch { }
    await sleep(200);
}

/* ── 准备：身份 + 模型 + 一段会产生多块回调的载荷 ── */
await ev(`(async function(){
    $('tp').value='eta-test'; await TA.doInit();
    const inps=document.querySelectorAll('#rk-list input');
    inps[0].value=TA.c.pk; inps[0].dispatchEvent(new Event('input'));
    $('st-t').checked=true; StegoUI.onToggle();
    if (StegoUI.model!=='ready') { await StegoEngine.fetchModel({});
        StegoUI.model = StegoEngine.state==='ready'?'ready':StegoEngine.state; StegoUI.sync(); }
    /* ⚠️ 必须真的写明文：否则 TA.enc() 直接"请输入明文内容"返回，
     *    密文长度 0，测的就成了空载荷（等于什么都没测）。 */
    $('tpt').value = '这是一段用于跨设备倒计时实测的较长明文，'.repeat(12);
    TA.onPlain();
    return 1;
})()`);

/* ⚠️ 密文只能加密**一次**：CX2 每次都用新的随机 content key / IV / 临时密钥，
 *    重复 TA.enc() 会得到**字节不同**的密文（长度相同）。若两次降速各加密一次，
 *    比的就成了两份不同输入，token 数当然不同 —— 那是假警报，不是不确定性。
 *    这里固定一份密文，两次测量共用。 */
const CIPHER_B64 = await ev(`(async function(){ await TA.enc(); return $('tct').innerText; })()`);
const CIPHER = JSON.parse(await ev(
    `JSON.stringify(Array.from(new Uint8Array(Util.b642buf(${JSON.stringify(CIPHER_B64)}))))`));

/** 在指定 CPU 降速下跑一次编码，记录完整进度轨迹 */
async function measure(rate) {
    await call('Emulation.setCPUThrottlingRate', { rate });
    /* 直接调 Codec（绕开 UI 节流），拿全量进度回调 */
    const r = await ev(`(async function(){
        const bytes = new Uint8Array(${JSON.stringify(CIPHER)});
        const trace = [];
        const t0 = performance.now();
        const res = await Stego.encodeBytes(bytes, {
            onProgress: (p) => trace.push({
                t: Math.round(performance.now()-t0),
                step: p.step, total: p.stepsTotal,
                bps: Math.round(p.bps*10)/10,
                eta: p.etaMs==null?null:Math.round(p.etaMs),
            })
        });
        const wall = Math.round(performance.now()-t0);
        return { cipherBytes: bytes.length, chunks: res.chunks, steps: res.steps,
                 chars: res.chars, wall, trace };
    })()`);
    return r;
}

console.log('跨设备实测：倒计时/速度是否随设备自适应\n');
console.log('（同一份载荷，仅改变 CPU 降速；Chrome Emulation.setCPUThrottlingRate）\n');

const fast = await measure(1);
const slow = await measure(4);

const fmtTrace = (r, n = 6) => r.trace.slice(0, n).map(x =>
    `t=${String(x.t).padStart(5)}ms ${String(x.step).padStart(4)}/${x.total} ${String(x.bps).padStart(7)} tok/s eta=${x.eta==null?'—':x.eta+'ms'}`
).join('\n    ');

console.log('═══ 1x（本机全速） ═══');
console.log(`  密文 ${fast.cipherBytes}B → ${fast.chunks} 块 · 实测 ${fast.steps} token · ${fast.chars} 字 · 墙钟 ${fast.wall}ms`);
console.log(`  stepsTotal（估算）= ${fast.trace[0] && fast.trace[0].total}`);
console.log('  前 6 次进度回调：');
console.log('    ' + fmtTrace(fast));

console.log('\n═══ 4x CPU 降速（模拟慢设备） ═══');
console.log(`  密文 ${slow.cipherBytes}B → ${slow.chunks} 块 · 实测 ${slow.steps} token · ${slow.chars} 字 · 墙钟 ${slow.wall}ms`);
console.log(`  stepsTotal（估算）= ${slow.trace[0] && slow.trace[0].total}`);
console.log('  前 6 次进度回调：');
console.log('    ' + fmtTrace(slow));

/* ── 结论性对比 ── */
const fastMid = fast.trace[Math.floor(fast.trace.length / 2)];
const slowMid = slow.trace[Math.floor(slow.trace.length / 2)];
const rateRatio = (slowMid.bps > 0) ? (fastMid.bps / slowMid.bps) : NaN;
const etaRatio = (slowMid.eta > 0 && fastMid.eta > 0) ? (slowMid.eta / fastMid.eta) : NaN;
const wallRatio = slow.wall / fast.wall;

console.log('\n' + '═'.repeat(64));
console.log('结论');
console.log('═'.repeat(64));
console.log(`  墙钟时间比（4x / 1x）        : ${wallRatio.toFixed(2)}x   ← 慢设备确实慢这么多`);
console.log(`  中段 bps 比（1x / 4x）       : ${rateRatio.toFixed(2)}x   ← >1 说明速率是实测的`);
console.log(`  中段 eta 比（4x / 1x）       : ${etaRatio.toFixed(2)}x   ← 应接近墙钟比`);
console.log(`  stepsTotal 是否与设备无关     :`);
console.log(`      1x=${fast.trace[0].total}  4x=${slow.trace[0].total}  ` +
    `${fast.trace[0].total === slow.trace[0].total ? '相同 ✓（压缩比问题，与设备无关）' : '不同 ✗'}`);
console.log(`  实测 token 数（同一密文）     : 1x=${fast.steps} 4x=${slow.steps} ` +
    `${fast.steps === slow.steps ? '相同 ✓（编码确定性，与设备无关）' : '不同 ✗（编码结果不确定！）'}`);

/* ── eta 精度：把每条回调的预测剩余时间与实际剩余时间对比 ──
 * ⚠️ 不能用"首次 eta vs 末次 eta"来评判 —— 临近结束 eta 本就该变小，
 *    那个比值恒为巨大数字，是个无意义的指标（本脚本初版就犯了这个错）。
 *    正确做法：|预测剩余 − 实际剩余| / 实际剩余。 */
function etaErr(trace, wall) {
    let worst = 0, first = null, mid = null;
    for (const x of trace) {
        if (x.eta == null) continue;
        const actualLeft = wall - x.t;
        if (actualLeft <= 0) continue;
        const err = Math.abs(x.eta - actualLeft) / actualLeft;
        if (first === null) first = err;
        if (err > worst) worst = err;
        /* 中段（进度 30%~70%）的误差最能代表用户观感 */
        const frac = x.total ? x.step / x.total : 0;
        if (frac >= 0.3 && frac <= 0.7) mid = err;
    }
    return { worst, first, mid };
}
const fe = etaErr(fast.trace, fast.wall);
const se = etaErr(slow.trace, slow.wall);
const pct = (x) => x == null ? 'n/a' : (x * 100).toFixed(1) + '%';
console.log(`\n  eta 精度（|预测剩余 − 实际剩余| ÷ 实际剩余）：`);
console.log(`      1x：首次 ${pct(fe.first)} · 中段 ${pct(fe.mid)} · 最差 ${pct(fe.worst)}`);
console.log(`      4x：首次 ${pct(se.first)} · 中段 ${pct(se.mid)} · 最差 ${pct(se.worst)}`);
console.log(`  （首次偏高 = 首个时间片含 JIT 预热，属正常；中段误差才是用户实际观感）`);

try { ws.close(); } catch { }
try { chrome.kill(); } catch { }
server.close();
process.exit(0);

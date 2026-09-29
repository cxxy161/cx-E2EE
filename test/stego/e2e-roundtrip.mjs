/* ═══════════════════════════════════════════════════════════════════
 * 端到端实测：加密 → 伪装文本 → 还原 → 解密（真实页面 + 真模型 + 真 CX2）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 走的是**用户实际点击的路径**，不是内部函数直调：
 *   ① 初始化身份 + 填公钥
 *   ② TA.enc()            → 真 CX2 加密（X25519 + HKDF + AES-GCM）
 *   ③ StegoUI.generate()  → 真模型把 Base64 密文变成伪装文本
 *   ④ 把伪装文本填进解密框 → StegoUI.decode()（还原为 Base64）
 *   ⑤ TA.dec()            → 真 CX2 解密
 *   ⑥ 断言明文逐字相同
 *
 * 特别验证两个刚修的 bug：
 *   · 长度头不得混进还原结果（否则首字节 0x00 → 「版本不支持(0x0)」）
 *   · 进度回调必须真的发生（encode/decode 都要有）
 *
 * 运行： node test/stego/e2e-roundtrip.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'src');
const MODEL_ROOT = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model');
const PORT = 9077, CDP = 9477;
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.bin': 'application/octet-stream', '.png': 'image/png', '.mjs': 'text/javascript; charset=utf-8',
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
    '--remote-debugging-port=' + CDP, `--user-data-dir=/tmp/cx-e2e-${process.pid}`, 'about:blank',
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
let mid = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('ERR: ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 200));
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const call = (mm, p = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, x => x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result));
    ws.send(JSON.stringify({ id, method: mm, params: p }));
});
await call('Runtime.enable');
const ev = async ex => {
    const r = await call('Runtime.evaluate', { expression: ex, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 900));
    return r.result.value;
};

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };
const eq = (a, b, n) => ok(a === b, n, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* ── 等页面脚本就绪 ── */
for (let i = 0; i < 100; i++) {
    try { if (await ev(`typeof StegoUI!=='undefined'&&typeof TA!=='undefined'&&typeof RKL!=='undefined'&&typeof CX2!=='undefined'`)) break; } catch { }
    await sleep(200);
}

console.log('端到端实测：加密 → 伪装文本 → 还原 → 解密\n');

/* ── 准备：初始化身份 + 装载模型 + 填入 10 字明文 ── */
const PLAIN = '这是一段十个字的明文';   // 恰好 10 个汉字
console.log(`  明文（${Array.from(PLAIN).length} 字）: ${PLAIN}`);

{
    const r = await ev(`(async function(){
        // ① 初始化身份（生成本机密钥对）
        $('tp').value = 'e2e-test';
        await TA.doInit();
        // ② 把自己当接收方：填公钥
        const inps = document.querySelectorAll('#rk-list input');
        inps[0].value = TA.c.pk;
        inps[0].dispatchEvent(new Event('input'));
        // ③ 开启语言隐写模式
        $('st-t').checked = true;
        StegoUI.onToggle();
        // ④ 写明文
        $('tpt').value = ${JSON.stringify(PLAIN)};
        TA.onPlain();
        return { pk: (TA.c.pk||'').slice(0,8), enabled: StegoUI.enabled, model: StegoUI.model };
    })()`);
    ok(r.enabled === true, '① 语言隐写模式已开启');
    console.log(`  身份公钥前缀 ${r.pk}… · 模型状态 ${r.model}`);
}

/* ── 模型装载（下载进 IndexedDB；已缓存则很快） ── */
{
    console.log('\n⏳ 装载模型（首次需下载 6.5MB）…');
    const t0 = Date.now();
    const r = await ev(`(async function(){
        if (StegoUI.model !== 'ready') {
            await StegoEngine.fetchModel({});
            StegoUI.model = StegoEngine.state === 'ready' ? 'ready' : StegoEngine.state;
            StegoUI.modelMsg = StegoEngine.detail || '';
            StegoUI.sync();
        }
        return { model: StegoUI.model, detail: StegoUI.modelMsg, stegoReady: !!(Stego&&Stego.ready), ver: Stego&&Stego.ver };
    })()`);
    console.log(`  模型 ${r.model} ${r.detail||''} · Stego.ready=${r.stegoReady} · ver=${r.ver}（${((Date.now()-t0)/1000).toFixed(1)}s）`);
    eq(r.model, 'ready', '② 模型已就绪');
    ok(r.stegoReady === true, '② Stego 内核已装载');
    eq(r.ver, 3, '② Codec 版本 = ver=3');
}

/* ── 步骤①：真 CX2 加密 ── */
let cipherB64 = '';
{
    console.log('\n═══ ① 执行加密（真 CX2：X25519 + HKDF + AES-256-GCM） ═══');
    const r = await ev(`(async function(){
        await TA.enc();
        const tct = $('tct').innerText;
        return { len: tct.length, head: tct.slice(0, 24),
                 stBase: (StegoUI.base64||'').length,
                 cap: $('trc-cap').innerText };
    })()`);
    cipherB64 = await ev(`$('tct').innerText`);
    ok(r.len > 0, '① 产出 Base64 密文', String(r.len));
    eq(r.stBase, r.len, '① Base64 已交给步骤②');
    console.log(`  密文 ${r.len} 字符 · Base64 头 "${r.head}…"`);
    console.log(`  ${r.cap}`);

    /* 密文首字节必须是 0x02（CX2 v2 版本号）—— 这是回归点：
     * 若长度头混进输出，首字节会变成 0x00。 */
    const firstByte = await ev(`(function(){ const b=new Uint8Array(Util.b642buf($('tct').innerText)); return b[0]; })()`);
    eq(firstByte, 2, '① 密文首字节 = 0x02（CX2 v2 版本）');
}

/* ── 步骤②：真模型序列化为伪装文本 ── */
let bodyText = '';
{
    console.log('\n═══ ② 生成伪装文本（真模型 ver=3 滑窗区间编码） ═══');
    const t0 = Date.now();
    const r = await ev(`(async function(){
        // 装进度探针，验证 onProgress 真的被调用
        window.__encProg = [];
        const orig = StegoUI._renderProgress.bind(StegoUI);
        StegoUI._renderProgress = function(p, t){ window.__encProg.push({step:p.step, total:p.stepsTotal, bps:p.bps, eta:p.etaMs}); return orig(p,t); };
        await StegoUI.generate();
        return { body: $('stt').innerText, chars: $('stt').innerText.length,
                 cap: $('st-cap').innerText,
                 progCount: window.__encProg.length,
                 progLast: window.__encProg[window.__encProg.length-1] || null,
                 hasTotal: window.__encProg.some(x=>x.total>0),
                 hasEta: window.__encProg.some(x=>x.eta!=null&&isFinite(x.eta)) };
    })()`);
    bodyText = r.body;
    const secs = ((Date.now()-t0)/1000).toFixed(1);
    ok(r.chars > 0, '② 产出伪装文本', String(r.chars));
    ok(!/版本不支持|执行加密/.test(r.cap), '② 生成未报错', r.cap);
    console.log(`  伪装文本 ${r.chars} 字（${secs}s）`);
    console.log(`  开头 40 字: ${r.body.slice(0,40)}`);
    console.log(`  ${r.cap}`);

    /* ── Bug2 回归：进度回调必须发生且带 total/eta ── */
    ok(r.progCount > 0, '② 编码进度回调确实发生', String(r.progCount) + ' 次');
    ok(r.hasTotal === true, '② 进度回调带 stepsTotal（进度条能算百分比）');
    ok(r.hasEta === true, '② 进度回调带 etaMs（倒计时可显示）');
    console.log(`  进度回调 ${r.progCount} 次 · 末次 ${JSON.stringify(r.progLast)}`);
}

/* ── 步骤③：把伪装文本粘回解密框 → 还原为 Base64 ── */
{
    console.log('\n═══ ③ 还原为 Base64（真模型解码 + 即时刹车） ═══');
    const t0 = Date.now();
    const r = await ev(`(async function(){
        $('tci').value = ${JSON.stringify(bodyText)};
        window.__decProg = [];
        const orig = StegoUI._renderDecProgress.bind(StegoUI);
        StegoUI._renderDecProgress = function(p){ window.__decProg.push({pct:p.pct, chunks:p.chunks}); return orig(p); };
        await StegoUI.decode();
        const v = $('tci').value;
        return { b64: v, len: v.length, msg: $('st-dec-msg').innerText,
                 progCount: window.__decProg.length,
                 maxPct: window.__decProg.reduce((a,x)=>Math.max(a, x.pct||0), 0) };
    })()`);
    const secs = ((Date.now()-t0)/1000).toFixed(1);
    const origB64 = cipherB64.replace(/\s+/g, '');
    const gotB64 = (r.b64 || '').replace(/\s+/g, '');
    ok(r.len > 0, '③ 还原出 Base64', String(r.len));
    console.log(`  还原 ${r.len} 字符（${secs}s）`);
    console.log(`  ${r.msg}`);

    /* ── Bug1 回归：还原的 Base64 必须与原始**逐字符相同** ── */
    ok(gotB64 === origB64, '③ 还原的 Base64 与原文完全一致（长度头未混入）',
        `orig ${origB64.length} vs got ${gotB64.length}`);
    if (gotB64 !== origB64) {
        let i = 0; while (i < Math.min(origB64.length, gotB64.length) && origB64[i] === gotB64[i]) i++;
        console.log(`  ⚠ 首个差异在第 ${i} 字符: orig="${origB64.slice(i,i+16)}" got="${gotB64.slice(i,i+16)}"`);
    }
    /* 首字节必须是 0x02 */
    const fb = await ev(`(function(){ const a=Util.b642buf($('tci').value); return a?new Uint8Array(a)[0]:-1; })()`);
    eq(fb, 2, '③ 还原密文首字节 = 0x02（不是 0x00）');

    /* ── Bug2 回归：解码进度回调 ── */
    ok(r.progCount > 0, '③ 解码进度回调确实发生', String(r.progCount) + ' 次');
    ok(r.maxPct > 0, '③ 解码进度不再是 0%', String(r.maxPct));
    console.log(`  进度回调 ${r.progCount} 次 · 最高 pct=${r.maxPct}`);
}

/* ── 步骤④：真 CX2 解密 ── */
{
    console.log('\n═══ ④ 执行解密（真 CX2 认证解密） ═══');
    const r = await ev(`(async function(){
        await TA.dec();
        return { plain: $('tdt').innerText, cap: $('trd-cap').innerText };
    })()`);
    ok(r.plain === PLAIN, '④ 解密得到的明文与原文逐字相同', JSON.stringify(r.plain));
    eq(r.cap, '✓ 解密成功', '④ CX2 认证解密成功');
    console.log(`  ${r.cap}`);
    console.log(`  明文: "${r.plain}"`);
    console.log(`  ${r.plain === PLAIN ? '✅ 明文完全一致' : '❌ 明文不一致'}`);
}

/* ── 页面错误汇总 ── */
{
    const real = errs.filter(e => !/favicon|net::ERR_/i.test(e));
    ok(real.length === 0, '⑤ 全程无页面级 JS 异常', real.slice(0, 3).join(' | '));
    if (real.length) real.slice(0, 6).forEach(e => console.log('  ⚠ ' + e));
}

console.log('\n' + '═'.repeat(64));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败 / 共 ${pass + fail} 项`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(64));

try { ws.close(); } catch { }
try { chrome.kill(); } catch { }
server.close();
process.exit(fail === 0 ? 0 : 1);

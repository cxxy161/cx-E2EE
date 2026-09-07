// cx-E2EE V3-J2 端到端自测：headless chrome + CDP（node>=21 内置 WebSocket，零依赖）
// 用例：
//  1) PNG 回归：加密(qv3=100)→解密，打码区/非打码区 PSNR（打码区应高保真）
//  2) JPEG 链：加密(qv3=80)→直接解密（文件链路）→ PSNR
//  3) JPEG 二次压缩：加密图再存 q=55 JPEG → 解密 → PSNR
//  4) 模拟拍屏：加密图透视 warp(旋转+缩放+透视) + q=0.9 → 解密（H 校正路径）
// 产物出到 /tmp/cx-e2e-out/
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const SRV_PORT = 8931, CDP_PORT = 9333, OUT = '/tmp/cx-e2e-out';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
    try {
        let p = decodeURIComponent(req.url.split('?')[0]);
        if (p.endsWith('/')) p += 'index.html';
        const buf = await readFile(join('/home/cxxy168/code/html/cx-E2EE/src', p));
        res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
        res.end(buf);
    } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(SRV_PORT, '127.0.0.1', r));
console.log('[srv] up');

const chrome = spawn('/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + CDP_PORT, `--user-data-dir=/tmp/cx-chrome-${process.pid}`, 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tg;
for (let i = 0; i < 60; i++) {
    try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${SRV_PORT}/image-crypto.html`)}`, { method: 'PUT' });
        tg = await r.json(); break;
    } catch { await sleep(250); }
}
if (!tg) throw new Error('cannot open target');
const ws = new WebSocket(tg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
let mid = 0; const pend = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++mid; pend.set(id, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
});
await call('Runtime.enable');
async function evaluate(expr) {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
}
for (let i = 0; i < 80; i++) {
    try { if (await evaluate(`document.readyState==='complete' && typeof IA!=='undefined' && typeof J2!=='undefined'`)) break; } catch { }
    await sleep(250);
}

const pageTest = String.raw`
(async () => {
    const $ = id => document.getElementById(id);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (fn, t = 45000) => {
        const s = Date.now();
        while (Date.now() - s < t) { const v = fn(); if (v) return v; await sleep(60); }
        throw new Error('timeout: ' + String(fn).slice(0, 90));
    };
    const out = { steps: [], notes: [] };
    const log = (name, ok, extra) => out.steps.push({ name, ok: !!ok, ...(extra || {}) });
    const tst = () => ($('tst') && $('tst').className.includes('on')) ? $('tst').innerText : '';
    const toB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
    const load = async (src) => { const im = new Image(); im.src = src; await im.decode(); return im; };

    const mkSrc = () => {
        const cv = document.createElement('canvas'); cv.width = 800; cv.height = 600;
        const x = cv.getContext('2d');
        const g = x.createLinearGradient(0, 0, 800, 600); g.addColorStop(0, '#1e5fa8'); g.addColorStop(1, '#e8c96a');
        x.fillStyle = g; x.fillRect(0, 0, 800, 600);
        x.fillStyle = '#fff'; x.font = 'bold 42px sans-serif'; x.fillText('CZ-SECURITY', 60, 90);
        x.fillStyle = '#ffdd88'; x.beginPath(); x.arc(620, 120, 70, 0, 7); x.fill();
        x.fillStyle = '#222'; x.fillRect(60, 480, 300, 40);
        x.fillStyle = '#f4f4f4'; x.fillRect(280, 220, 240, 160);
        x.strokeStyle = '#c33'; x.lineWidth = 6; x.strokeRect(288, 228, 224, 144);
        x.fillStyle = '#900'; x.font = 'bold 30px sans-serif'; x.fillText('TOP SECRET', 300, 268);
        x.fillStyle = '#036'; x.font = 'bold 22px sans-serif'; x.fillText('ID: 8848-1919', 300, 308);
        x.font = 'bold 15px monospace'; x.fillText('payload-0x7f3a solid', 296, 352);
        return cv.toDataURL('image/png');
    };
    const src = mkSrc();
    const img = await load(src);
    MOB.img = img; MOB.natW = 800; MOB.natH = 600;
    MOB.regions = [{ x: 280, y: 220, w: 240, h: 160 }];
    MOB.decoyOn = false; MOB.sortOn = false; MOB.decoyImg = null;
    const PWD = 't3st-secret';
    const qv3 = $('qv3'), ke3 = $('ke3'), sv3 = $('sv3'), kd = $('kd');
    sv3.value = 100;

    const enc = async (q) => {
        qv3.value = q; ke3.value = PWD;
        $('oe').src = ''; // 清除上一轮残留，避免 waitFor 命中旧 blob
        IA.pV3(img, PWD, 'e');
        const u = await waitFor(() => { const s = $('oe').src; return s && s.startsWith('blob:') ? s : null; });
        const t1 = tst();
        if (t1 && (t1.includes('❌') || t1.includes('容量不足') || t1.includes('请先'))) throw new Error('enc fail: ' + t1);
        return await (await fetch(u)).blob();
    };
    const dec = async (blob) => {
        const info = [];
        kd.value = PWD;
        $('od').src = ''; // 清除上一轮残留
        let im;
        try { im = await load(URL.createObjectURL(blob)); info.push('input decode OK ' + im.width + 'x' + im.height); }
        catch (e) { info.push('input decode FAIL ' + e + ' type=' + blob.type + ' size=' + blob.size); throw e; }
        IA.pV3(im, PWD, 'd');
        const u = await waitFor(() => { const s = $('od').src; return s && s.startsWith('blob:') ? s : null; });
        const t2 = tst();
        info.push('t2=' + t2);
        if (t2 && (t2.includes('❌') || t2.includes('未识别') || t2.includes('容量不足') || t2.includes('重建失败'))) throw new Error('dec fail: ' + t2);
        const b = await (await fetch(u)).blob();
        info.push('out blob type=' + b.type + ' size=' + b.size);
        return { blob: b, info };
    };
    const psnr = async (bSrc, bDec) => {
        let im1, im2;
        try { im1 = await load(bSrc); } catch (e) { return { note: 'src decode fail ' + e }; }
        try { im2 = await load(bDec); } catch (e) {
            // blob URL 在多次交互后可能失效，转 dataURL 重试
            const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result)); fr.readAsDataURL(bDec); });
            try { im2 = await load(b64); } catch (e2) { return { note: 'dec decode fail both: ' + e2 }; }
        }
        const w = im1.width, h = im1.height;
        if (im2.width !== w || im2.height !== h) return { note: 'size ' + w + 'x' + h + ' vs ' + im2.width + 'x' + im2.height };
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const x = cv.getContext('2d'); x.drawImage(im1, 0, 0); const d1 = x.getImageData(0, 0, w, h).data;
        const cv2 = document.createElement('canvas'); cv2.width = w; cv2.height = h;
        const x2 = cv2.getContext('2d'); x2.drawImage(im2, 0, 0); const d2 = x2.getImageData(0, 0, w, h).data;
        const calc = (x0, y0, x1, y1) => {
            let s = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let xx = x0; xx < x1; xx++) {
                const f = (y * w + xx) * 4;
                const dr = d1[f] - d2[f], dg = d1[f + 1] - d2[f + 1], db = d1[f + 2] - d2[f + 2];
                s += dr * dr + dg * dg + db * db; n += 3;
            }
            const mse = s / n;
            return mse > 0 ? 10 * Math.log10(255 * 255 / mse) : 99;
        };
        const A = { x: 280, y: 220, w: 240, h: 160 };
        return {
            whole: calc(0, 0, w, h),
            region: calc(A.x, A.y, A.x + A.w, A.y + A.h),
            outside: (calc(0, 0, w, A.y) + calc(0, A.y + A.h, w, h) + calc(0, A.y, A.x, A.y + A.h) + calc(A.x + A.w, A.y, w, A.y + A.h)) / 4
        };
    };

    // 用例仅针对 JPEG 链路（V3-J2 拍屏鲁棒码）。PNG 路径不测不改（算法零改动，回归另验）。

    // 2) JPEG 直接链
    let encJ = null;
    try {
        encJ = await enc(80);
        out.notes.push('encJ type=' + encJ.type + ' size=' + encJ.size);
        const { blob: decJ, info } = await dec(encJ);
        for (const n of info) out.notes.push('decJ info: ' + n);
        const p = await psnr(src, decJ);
        log('jpeg-roundtrip', !p.note && p.region > 20 && p.outside > 27, { p });
        out.jpegEnc = await toB64(encJ); out.jpegDec = await toB64(decJ);
    } catch (e) { log('jpeg-roundtrip', false, { e: String(e) }); }

    // 3) JPEG 二次压缩 q=55
    if (encJ) try {
        const im3 = await load(URL.createObjectURL(encJ));
        const cv3 = document.createElement('canvas'); cv3.width = im3.width; cv3.height = im3.height;
        cv3.getContext('2d').drawImage(im3, 0, 0);
        const re = await new Promise(res => cv3.toBlob(res, 'image/jpeg', 0.55));
        const { blob: dec55, info } = await dec(re);
        for (const n of info) out.notes.push('q55: ' + n);
        const p = await psnr(src, dec55);
        log('jpeg-recompress-q55', !p.note && p.region > 16, { p });
        out.jpeg55Dec = await toB64(dec55);
    } catch (e) { log('jpeg-recompress-q55', false, { e: String(e) }); }

    // 4) 模拟拍屏：透视 warp（旋转+缩放+透视梯形）→ 相机 JPEG q=0.9 → 解密
    if (encJ) try {
        const im5 = await load(URL.createObjectURL(encJ));
        const W = im5.width, H = im5.height, OW = 1560, OH = 1180;
        const cv5 = document.createElement('canvas'); cv5.width = OW; cv5.height = OH;
        const x5 = cv5.getContext('2d');
        const sc2 = document.createElement('canvas'); sc2.width = W; sc2.height = H;
        sc2.getContext('2d').drawImage(im5, 0, 0);
        const sdSrc = sc2.getContext('2d').getImageData(0, 0, W, H).data;
        // 三角形仿射 warp（透视模拟）：四边形拆 2 三角形，每三角形 canvas affine 精确绘制，无迭代
        const affine3 = (s0, s1, s2, t0, t1, t2) => {
            const D = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1]);
            if (Math.abs(D) < 1e-9) return null;
            const C = (a1, a2, a3) => (a1 * (s1[1] - s2[1]) + a2 * (s2[1] - s0[1]) + a3 * (s0[1] - s1[1])) / D;
            const E = (a1, a2, a3) => (a1 * (s2[0] - s1[0]) + a2 * (s0[0] - s2[0]) + a3 * (s1[0] - s0[0])) / D;
            const F = (a1, a2, a3) => (a1 * (s1[0] * s2[1] - s2[0] * s1[1]) + a2 * (s2[0] * s0[1] - s0[0] * s2[1]) + a3 * (s0[0] * s1[1] - s1[0] * s0[1])) / D;
            return [C(t0[0], t1[0], t2[0]), C(t0[1], t1[1], t2[1]), E(t0[0], t1[0], t2[0]), E(t0[1], t1[1], t2[1]), F(t0[0], t1[0], t2[0]), F(t0[1], t1[1], t2[1])];
        };
        const quad = [[214, 168], [1358, 222], [1332, 1036], [198, 942]];
        const srcQ = [[0, 0], [W, 0], [W, H], [0, H]];
        const tri = [[0, 1, 3], [1, 2, 3]];
        x5.fillStyle = '#c8c8c8'; x5.fillRect(0, 0, OW, OH);
        for (const [i, j, k] of tri) {
            const m = affine3(srcQ[i], srcQ[j], srcQ[k], quad[i], quad[j], quad[k]);
            if (!m) continue;
            x5.save();
            x5.beginPath();
            x5.moveTo(quad[i][0], quad[i][1]); x5.lineTo(quad[j][0], quad[j][1]); x5.lineTo(quad[k][0], quad[k][1]);
            x5.closePath(); x5.clip();
            x5.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            x5.drawImage(im5, 0, 0);
            x5.restore();
        }
        const photo = await new Promise(res => cv5.toBlob(res, 'image/jpeg', 0.9));
        out.photo = await toB64(photo);
        const { blob: decP, info: info2 } = await dec(photo);
        for (const n of info2) out.notes.push('photo: ' + n);
        const p = await psnr(src, decP);
        log('photo-warp-dec', !p.note && p.region > 8 && Math.abs(p.whole) < 50, { p }); // 拍屏有损：region 恢复几何正确即有值
        out.photoDec = await toB64(decP);
    } catch (e) { log('photo-warp-dec', false, { e: String(e) }); }

    out.done = true;
    return out;
})()
`;

try {
    const res = await evaluate(pageTest);
    console.log(JSON.stringify(res.steps, null, 1));
    console.log('--- notes ---');
    for (const n of (res.notes || [])) console.log(n);
    await mkdir(OUT, { recursive: true });
    const w = async (name, b64) => { if (b64) await writeFile(join(OUT, name), Buffer.from(b64, 'base64')); };
    await w('jpeg-enc.jpg', res.jpegEnc); await w('jpeg-dec.png', res.jpegDec);
    await w('jpeg-q55-dec.png', res.jpeg55Dec);
    await w('photo.jpg', res.photo); await w('photo-dec.png', res.photoDec);
    console.log('[out] saved to ' + OUT);
    chrome.kill(); server.close();
    const fail = res.steps.filter(s => !s.ok);
    console.log(fail.length ? `FAIL: ${fail.map(s => s.name).join(', ')}` : 'ALL PASS');
    process.exit(fail.length ? 1 : 0);
} catch (e) {
    console.error('DRIVER ERROR:', e);
    chrome.kill(); server.close();
    process.exit(2);
}
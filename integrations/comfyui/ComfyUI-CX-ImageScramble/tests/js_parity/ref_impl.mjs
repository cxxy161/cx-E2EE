// 自动生成 by make_ref_impl.py —— 内容原样抽取自 cx-E2EE/src/image-crypto.js
// 抽取源: src/image-crypto.js
export const IA = {

    hash(s) {
        let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
        for (let i = 0; i < s.length; i++) {
            let k = s.charCodeAt(i); h1 = h2 ^ Math.imul(h1 ^ k, 597399067); h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
            h3 = h4 ^ Math.imul(h3 ^ k, 951274213); h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
        }
        return h1 + h2 + h3 + h4;
    },

    rng(a) { return function() { var t = a += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; } },

    perm(len, seed) { const r = this.rng(seed), p = new Uint32Array(len); for (let i = 0; i < len; i++) p[i] = i; for (let i = len - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; },

    regionEnc(d, w, h, reg, seed, E, sort, soft, unit) {
        unit = unit || 8;
        let x0 = Math.floor(reg.x / unit) * unit, y0 = Math.floor(reg.y / unit) * unit;
        // 右/下边界：先钳到画布内，再回退到完整块边界——
        // 若尾巴不足 unit px 直接丢弃（保持 bx/by 整数，避免非整数块数导致
        // 置换表长度截断与循环越界 → 全图打码时整体错位乱码）
        let x1 = Math.min(w, Math.ceil((reg.x + reg.w) / unit) * unit);
        let y1 = Math.min(h, Math.ceil((reg.y + reg.h) / unit) * unit);
        x1 = x0 + Math.floor((x1 - x0) / unit) * unit;
        y1 = y0 + Math.floor((y1 - y0) / unit) * unit;
        if (x1 <= x0 || y1 <= y0) return;
        const bx = (x1 - x0) / unit, by = (y1 - y0) / unit, bl = bx * by;
        const r = this.rng(seed), p = this.perm(bl, seed), cm = new Int32Array(bl), nr = this.rng(seed + 999);
        for (let i = 0; i < bl; i++) cm[i] = Math.floor(nr() * 1e6);
        if (!E && sort) this.sortRegion(d, w, h, x0, y0, bx, by, bl, false); // 先逆排再逆变换
        const out = new Uint8ClampedArray(d);
        // soft(JPEG 友好)：亮度映射动态范围加宽(EX增益 1.645→1.186)、扰动减半，
        // 显著减小 JPEG 逐块量化误差经逆变换放大后在区域内形成的"拼图块"色差
        const CM = soft ? (v => 20 + (v / 255) * 215) : (v => 50 + (v / 255) * 155);
        const EX = soft ? (v => { let n = (v - 20) / 215; if (n < 0) n = 0; if (n > 1) n = 1; return n * 255; }) : (v => { let n = (v - 50) / 155; if (n < 0) n = 0; if (n > 1) n = 1; return n * 255; });
        for (let i = 0; i < bl; i++) {
            let si, di; if (E) { si = i; di = p[i]; } else { si = p[i]; di = i; }
            const sCol = si % bx, sRow = Math.floor(si / bx), dCol = di % bx, dRow = Math.floor(di / bx);
            const sx = x0 + sCol * unit, sy = y0 + sRow * unit, dx = x0 + dCol * unit, dy = y0 + dRow * unit;
            const rw = cm[E ? di : si], ns = soft ? ((rw % 33) - 16) : ((rw % 81) - 40), fU = rw & 0x100, fV = rw & 0x200, sw = rw & 0x400;
            for (let y = 0; y < unit; y++) for (let l = 0; l < unit; l++) {
                const sI = ((sy + y) * w + (sx + l)) * 4, dI = ((dy + y) * w + (dx + l)) * 4;
                let R = d[sI], G = d[sI + 1], B = d[sI + 2];
                let Y = .299 * R + .587 * G + .114 * B, U = -.147 * R - .289 * G + .436 * B, V = .615 * R - .515 * G - .1 * B;
                if (E) { Y = CM(Y) + ns; if (sw) [U, V] = [V, U]; if (fU) U = -U; if (fV) V = -V; }
                else { if (fV) V = -V; if (fU) U = -U; if (sw) [U, V] = [V, U]; Y -= ns; Y = EX(Y); }
                out[dI] = Y + 1.14 * V; out[dI + 1] = Y - .395 * U - .581 * V; out[dI + 2] = Y + 2.032 * U; out[dI + 3] = 255;
            }
        }
        d.set(out);
        if (E && sort) this.sortRegion(d, w, h, x0, y0, bx, by, bl, true); // 加密末尾按亮度排序
    },

    metaBytes(count, regions, k, flag, dataLen) {
        const bs = [count];
        for (const r of regions) bs.push(r.x >> 8 & 255, r.x & 255, r.y >> 8 & 255, r.y & 255, r.w >> 8 & 255, r.w & 255, r.h >> 8 & 255, r.h & 255);
        bs.push(67, 88); // "CX"
        const sig = (this.hash('V3|' + count + '|' + regions.map(r => r.x + ',' + r.y + ',' + r.w + ',' + r.h).join('&') + '|' + k) >>> 0) & 0xFFFFFF;
        bs.push(sig >> 16 & 255, sig >> 8 & 255, sig & 255);
        bs.push(flag & 255, dataLen >>> 24 & 255, dataLen >>> 16 & 255, dataLen >>> 8 & 255, dataLen & 255);
        return bs;
    },

    parseMeta(bs) {
        if (!bs || bs.length < 5) return null;
        const cnt = bs[0]; if (cnt < 1 || cnt > 12) return null;
        if (bs[1 + cnt * 8] !== 67 || bs[2 + cnt * 8] !== 88) return null;
        const regions = [];
        for (let i = 0; i < cnt; i++) { const o = 1 + i * 8; regions.push({ x: bs[o] * 256 + bs[o + 1], y: bs[o + 2] * 256 + bs[o + 3], w: bs[o + 4] * 256 + bs[o + 5], h: bs[o + 6] * 256 + bs[o + 7] }); }
        const so = 1 + cnt * 8 + 2;
        const stored = (bs[so] << 16) | (bs[so + 1] << 8) | bs[so + 2];
        const flag = bs[so + 3] & 255, dataLen = bs.length > so + 7 ? (bs[so + 4] << 24 | bs[so + 5] << 16 | bs[so + 6] << 8 | bs[so + 7]) : 0;
        return { cnt, regions, stored, flag, dataLen };
    },

    borderOrd(cw, ch, B) {
        const pts = [];
        for (let x = 0; x < cw; x++) for (let y = 0; y < B; y++) pts.push(y * cw + x);          // 顶
        for (let y = B; y < ch - B; y++) for (let x = cw - B; x < cw; x++) pts.push(y * cw + x); // 右
        for (let x = cw - 1; x >= 0; x--) for (let y = ch - B; y < ch; y++) pts.push(y * cw + x); // 底
        for (let y = ch - B - 1; y >= B; y--) for (let x = 0; x < B; x++) pts.push(y * cw + x);   // 左
        return pts;
    },

    wMetaPng(bs, d, ord) {
        let bi = 0;
        for (const b of bs) for (let i = 7; i >= 0; i--) {
            const p = ord[bi++], f = p * 4; d[f] = (d[f] & 254) | (b >> i & 1);
        }
        return true;
    },

    rMetaPng(d, ord, maxB) {
        const bits = []; for (let i = 0; i < Math.min(ord.length, maxB * 8); i++) bits.push(d[ord[i] * 4] & 1);
        const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = b * 2 + bits[i + j]; bytes.push(b); }
        return bytes;
    },
};

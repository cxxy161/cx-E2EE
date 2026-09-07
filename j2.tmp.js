/* ================================================================
   J2 · V3 拍屏鲁棒 JPEG 边框码（QR 化重构，替代旧 V3-J 时序条方案）
   布局（模块 8px，边框 B=64px=8 模块，画布 cw×ch=内容+128）：
     最外 8px：白色 quiet 环（抗边缘裁切/JPEG 振铃）
     内侧 8..64px：四角各一个 56×56 QR 式回字 Finder（1:1:3:1:1），
     其余整环 = 二值数据模块（黑=1 白=0，1bit/模块）
   格式区 ×2（近左上/右下 Finder 的固定模块偏移处，各 192 模块）：
     RS(24,8) np=16，内容 'J2'+画布宽高 → 先于载荷解码以自举网格尺寸
   载荷：payload ≤127B → RS(255,127) k=127 固定，np∈{128,64,32}
     按容量自适应（50%/25%/12.5% 纠错），位级互质步长交错抗突发损伤
   载荷 = metaBytesR 同款（含区域表/签名），区域内容不入边框（16px 置换+扰动密码反推）
   ================================================================ */
const J2 = {
    B: 64,
    /* --- 布局生成（写/读共用，必须逐位一致） --- */
    // 数据模块中心流：顶(外→内7层,左→右) → 右(外→内,上→下) → 底(外→内,左→右) → 左(外→内,上→下)
    order(cw, ch) {
        const pts = [], col = (a, b) => { const r = []; for (let x = a; x <= b; x += 8) r.push(x + 4); return r; };
        const topY = [12, 20, 28, 36, 44, 52, 60], rightX = [], botY = [], leftX = [];
        for (let k = 0; k < 7; k++) { rightX.push(cw - 60 + 8 * k); botY.push(ch - 60 + 8 * k); leftX.push(12 + 8 * k); }
        for (const yc of topY) for (const xc of col(68, cw - 68)) pts.push({ x: xc, y: yc });
        for (const xc of rightX) for (const yc of col(68, ch - 68)) pts.push({ x: xc, y: yc });
        for (const yc of botY) for (const xc of col(68, cw - 68)) pts.push({ x: xc, y: yc });
        for (const xc of leftX) for (const yc of col(68, ch - 68)) pts.push({ x: xc, y: yc });
        return pts;
    },
    // 格式区模块中心（代码空间）：TL 份 = 顶带 x68..284×y12..60；BR 份 = 底带 x=cw-284..cw-68×y=ch-60..ch-12
    fmtSet(cw, ch) {
        const out = [], col = (a, b) => { const r = []; for (let x = a; x <= b; x += 8) r.push(x + 4); return r; };
        const topY = [12, 20, 28, 36, 44, 52, 60], botY = [];
        for (let k = 0; k < 7; k++) botY.push(ch - 60 + 8 * k);
        for (const yc of topY) for (const xc of col(68, 284)) out.push({ x: xc, y: yc });
        for (const yc of botY) for (const xc of col(cw - 284, cw - 68)) out.push({ x: xc, y: yc });
        return out;
    },
    // 四角 Finder 中心（代码空间，左上起顺时针）
    corners(cw, ch) { return [{ x: 36, y: 36 }, { x: cw - 36, y: 36 }, { x: cw - 36, y: ch - 36 }, { x: 36, y: ch - 36 }]; },
    /* --- 写入侧（直接改 d.data；d 为含边框画布像素） --- */
    paintFinder(d, cw, ch, cx, cy) {
        const fill = (x0, y0, x1, y1, v) => {
            x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(cw, x1); y1 = Math.min(ch, y1);
            for (let y = y0; y < y1; y++) { const o = y * cw * 4; for (let x = x0; x < x1; x++) { const f = o + x * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; } }
        };
        fill(cx - 28, cy - 28, cx + 28, cy - 20, 0); fill(cx - 28, cy + 20, cx + 28, cy + 28, 0);
        fill(cx - 28, cy - 20, cx - 20, cy + 20, 0); fill(cx + 20, cy - 20, cx + 28, cy + 20, 0);
        fill(cx - 20, cy - 20, cx + 20, cy - 12, 255); fill(cx - 20, cy + 12, cx + 20, cy + 20, 255);
        fill(cx - 20, cy - 12, cx - 12, cy + 12, 255); fill(cx + 12, cy - 12, cx + 20, cy + 12, 255);
        fill(cx - 12, cy - 12, cx + 12, cy + 12, 0);
    },
    paintMod(d, cw, p, bit) {
        const x0 = p.x - 4, y0 = p.y - 4, v = bit ? 0 : 255;
        for (let y = y0; y < y0 + 8; y++) { const o = y * cw * 4; for (let x = x0; x < x0 + 8; x++) { const f = o + x * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; } }
    },
    whiteBand(d, cw, ch) {
        for (let y = 0; y < ch; y++) { const o = y * cw * 4; for (let x = 0; x < cw; x++) {
            if (x >= 64 && x < cw - 64 && y >= 64 && y < ch - 64) continue;
            const f = o + x * 4; d[f] = 255; d[f + 1] = 255; d[f + 2] = 255; d[f + 3] = 255;
        } }
    },
    gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; },
    stride(L) { let s = 131; while (this.gcd(s, L) > 1) s++; return s; },
    // 编码 payload（≤127B）画入边框。返回 true/false（容量不足）
    writeRing(d, cw, ch, payload) {
        const mods = this.order(cw, ch), fmt = this.fmtSet(cw, ch);
        const fmtK = new Set(fmt.map(p => p.x + ',' + p.y));
        let freeN = 0;
        for (const p of mods) if (!fmtK.has(p.x + ',' + p.y)) freeN++;
        if (payload.length > 127) return false;
        const np = freeN >= 2040 ? 128 : freeN >= 1528 ? 64 : freeN >= 1272 ? 32 : 0;
        if (!np) return false;
        this.whiteBand(d, cw, ch);
        for (const c of this.corners(cw, ch)) this.paintFinder(d, cw, ch, c.x, c.y);
        const fmtB = [0x4A, 0x32, cw >> 8 & 255, cw & 255, ch >> 8 & 255, ch & 255, 1, 0];
        const fCod = RS255.encode(fmtB, 16); // 24B → 192bit
        const paintFmt = (set) => {
            const S = this.stride(192);
            for (let i = 0; i < 192; i++) { const b = (fCod[i >> 3] >> (7 - (i & 7))) & 1; this.paintMod(d, cw, set[(i * S) % 192], b); }
        };
        paintFmt(fmt.slice(0, 192));
        paintFmt(fmt.slice(192, 384));
        const buf = new Uint8Array(127); buf.set(payload, 0);
        const cod = RS255.encode(buf, np), L = cod.length * 8, S = this.stride(L);
        let qi = 0;
        for (const p of mods) {
            if (fmtK.has(p.x + ',' + p.y) || qi >= L) continue;
            const idx = (qi * S) % L;
            const b = (cod[idx >> 3] >> (7 - (idx & 7))) & 1;
            this.paintMod(d, cw, p, b); qi++;
        }
        return qi >= L;
    },
    /* --- 读取侧 --- */
    luma(d, cw, ch) {
        const L = new Uint8Array(cw * ch);
        for (let i = 0; i < L.length; i++) L[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
        return L;
    },
    // 行/列游程扫描 1:1:3:1:1 回字，双向确认 + 亚像素中心 + 模块尺度估计
    scanFinders(luma, cw, ch) {
        const hits = [];
        for (let y = 0; y < ch; y += 2) {
            const o = y * cw;
            let mn = 255, mx = 0;
            for (let x = 0; x < cw; x++) { const v = luma[o + x]; if (v < mn) mn = v; if (v > mx) mx = v; }
            if (mx - mn < 60) continue;
            const th = (mn + mx) / 2;
            const runs = []; let s = 0, cur = luma[o] < th;
            for (let x = 1; x <= cw; x++) {
                const v = x < cw ? (luma[o + x] < th) : !cur;
                if (x === cw || v !== cur) { runs.push({ d: cur, len: x - s, x0: s }); s = x; cur = v; }
            }
            for (let i = 0; i + 4 < runs.length; i++) {
                const r = runs;
                if (!r[i].d || r[i + 1].d || !r[i + 2].d || r[i + 3].d || !r[i + 4].d) continue;
                const base = r[i + 2].len / 3;
                if (base < 2.5 || base > 60) continue;
                let ok = true;
                for (const j of [0, 1, 3, 4]) { const l = r[i + j].len; if (Math.abs(l - base) > base * 2 || l < base * 0.5) { ok = false; break; } }
                if (!ok || r[i + 2].len < base * 2) continue;
                hits.push({ x: r[i + 2].x0 + r[i + 2].len / 2, y: y, m: base });
            }
        }
        const out = [];
        for (const h of hits) {
            const xci = Math.round(h.x); if (xci < 0 || xci >= cw) continue;
            let mn2 = 255, mx2 = 0;
            for (let yy = 0; yy < ch; yy++) { const v = luma[yy * cw + xci]; if (v < mn2) mn2 = v; if (v > mx2) mx2 = v; }
            if (mx2 - mn2 < 60) continue;
            const th2 = (mn2 + mx2) / 2;
            const runs2 = []; let s2 = 0, cur2 = luma[xci] < th2;
            for (let yy = 1; yy <= ch; yy++) {
                const v = yy < ch ? (luma[yy * cw + xci] < th2) : !cur2;
                if (yy === ch || v !== cur2) { runs2.push({ d: cur2, len: yy - s2, x0: s2 }); s2 = yy; cur2 = v; }
            }
            for (let i = 0; i + 4 < runs2.length; i++) {
                const r = runs2;
                if (!r[i].d || r[i + 1].d || !r[i + 2].d || r[i + 3].d || !r[i + 4].d) continue;
                const base = r[i + 2].len / 3;
                if (base < 2.5 || base > 60) continue;
                let ok = true;
                for (const j of [0, 1, 3, 4]) { const l = r[i + j].len; if (Math.abs(l - base) > base * 2 || l < base * 0.5) { ok = false; break; } }
                if (!ok || r[i + 2].len < base * 2) continue;
                const yc = r[i + 2].x0 + r[i + 2].len / 2;
                if (Math.abs(yc - h.y) <= base * 4) { out.push({ x: h.x, y: yc, m: (h.m + base) / 2 }); break; }
            }
        }
        const res = [];
        for (const h of out) {
            let g = null;
            for (const o2 of res) if (Math.abs(o2.x - h.x) < 24 && Math.abs(o2.y - h.y) < 24) { g = o2; break; }
            if (g) { const n = g.n + 1; g.x = (g.x * g.n + h.x) / n; g.y = (g.y * g.n + h.y) / n; g.m = (g.m * g.n + h.m) / n; g.n = n; }
            else res.push({ x: h.x, y: h.y, m: h.m, n: 1 });
        }
        return res;
    },
    // 解 8 元线性方程（高斯消元）— DLT 用
    solve8(M, b) {
        const A = []; for (let i = 0; i < 8; i++) A.push(M[i].slice().concat([b[i]]));
        for (let c = 0; c < 8; c++) {
            let p = c;
            for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
            if (Math.abs(A[p][c]) < 1e-12) return null;
            [A[c], A[p]] = [A[p], A[c]];
            for (let r = 0; r < 8; r++) {
                if (r === c) continue;
                const f = A[r][c] / A[c][c];
                for (let k = c; k <= 8; k++) A[r][k] -= f * A[c][k];
            }
        }
        const x = []; for (let i = 0; i < 8; i++) x.push(A[i][8] / A[i][i]);
        return x;
    },
    // 单应 H=[a..h]，照片坐标 = H(图像坐标)，分母 gx+hy+1
    dlt(code, photo) {
        const M = [], b = [];
        for (let i = 0; i < 4; i++) {
            const { x, y } = code[i], { x: u, y: v } = photo[i];
            M.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
            M.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
        }
        return this.solve8(M, b);
    },
    applyH(h, x, y) { const den = h[6] * x + h[7] * y + 1; return { x: (h[0] * x + h[1] * y + h[2]) / den, y: (h[3] * x + h[4] * y + h[5]) / den }; },
    // 单份格式读取：C=finder 中心，ux/uy 单位向（ux 指 TR，uy 指 BL），dxSign=+1(TL)/-1(BR)，s=局部模块尺度(照片px)
    readFmt1(luma, cw, ch, C, ux, uy, dxSign, s) {
        const bits = new Uint8Array(192);
        let bi = 0;
        for (let k2 = 0; k2 < 7 && bi < 192; k2++) {
            const dy = -24 + 8 * k2;
            for (let k = 0; k < 28 && bi < 192; k++) {
                const dx = dxSign > 0 ? (32 + 8 * k) : (248 - 8 * k); // BR 份 x 递增以与写侧同序
                const px = C.x + ux.x * dx * s / 8 + uy.x * dy * s / 8;
                const py = C.y + ux.y * dx * s / 8 + uy.y * dy * s / 8;
                bits[bi++] = this.samplePt(luma, cw, ch, px, py, Math.max(1.5, s * 0.45)) ? 1 : 0;
            }
        }
        if (bi < 192) return null;
        const S = this.stride(192);
        const bytes = new Uint8Array(24);
        for (let i = 0; i < 24; i++) { let v = 0; for (let j = 0; j < 8; j++) v = v * 2 + bits[(i * 8 + j) * S % 192]; bytes[i] = v; }
        const cod = RS255.decode(bytes, 16);
        if (!cod || cod.length < 8) return null;
        if (cod[0] !== 0x4A || cod[1] !== 0x32) return null;
        const cw0 = cod[2] * 256 + cod[3], ch0 = cod[4] * 256 + cod[5];
        if (cw0 < 96 || ch0 < 96 || cw0 > 40000 || ch0 > 40000) return null;
        return { cw0, ch0 };
    },
    readFmt2(luma, cw, ch, tl, tr, bl, br) {
        const uxN = this.norm(tr.x - tl.x, tr.y - tl.y), uyN = this.norm(bl.x - tl.x, bl.y - tl.y);
        const a = this.readFmt1(luma, cw, ch, tl, uxN, uyN, 1, tl.m);
        if (a) return a;
        const ux2 = this.norm(br.x - bl.x, br.y - bl.y), uy2 = this.norm(br.y - tr.y, br.x - tr.x);
        const b = this.readFmt1(luma, cw, ch, br, ux2, uy2, -1, br.m);
        return b;
    },
    norm(dx, dy) { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; },
    samplePt(luma, cw, ch, px, py, r) {
        const cx0 = Math.round(px), cy0 = Math.round(py), rr = Math.max(1, Math.ceil(r));
        if (cx0 - rr < 0 || cy0 - rr < 0 || cx0 + rr >= cw || cy0 + rr >= ch) {
            return cx0 >= 0 && cy0 >= 0 && cx0 < cw && cy0 < ch ? luma[cy0 * cw + cx0] : 255;
        }
        let s = 0, n = 0;
        for (let y = -rr; y <= rr; y++) { const o = (cy0 + y) * cw; for (let x = -rr; x <= rr; x++) { s += luma[o + cx0 + x]; n++; } }
        return s / n;
    },
    // 照片→代码画布同序采样全部数据模块（跳过格式区）
    stream(luma, cw, ch, H, cw0, ch0) {
        const mods = this.order(cw0, ch0), fmtK = new Set(this.fmtSet(cw0, ch0).map(p => p.x + ',' + p.y));
        const vals = [];
        let mn = 1e9, mx = -1;
        for (const mod of mods) {
            if (fmtK.has(mod.x + ',' + mod.y)) continue;
            const p = this.applyH(H, mod.x, mod.y);
            const q = this.applyH(H, mod.x + 8, mod.y);
            const sm = Math.hypot(q.x - p.x, q.y - p.y);
            const v = this.samplePt(luma, cw, ch, p.x, p.y, Math.max(1.5, sm * 0.42));
            vals.push(v); if (v < mn) mn = v; if (v > mx) mx = v;
        }
        const th = (mn + mx) / 2;
        const bits = new Uint8Array(vals.length);
        for (let i = 0; i < vals.length; i++) bits[i] = vals[i] < th ? 1 : 0;
        return bits;
    },
    // 载荷解码：np ∈ {128,64,32} 自适应，返回 127 字节或 null
    decodePayload(bits, nfree) {
        for (const np of [128, 64, 32]) {
            const n = 127 + np, L = n * 8;
            if (nfree < L) continue;
            const S = this.stride(L);
            const bytes = new Uint8Array(n);
            for (let i = 0; i < n; i++) { let v = 0; for (let j = 0; j < 8; j++) v = v * 2 + bits[(i * 8 + j) * S % L]; bytes[i] = v; }
            const cod = RS255.decode(bytes, np);
            if (!cod || cod.length < 10) continue;
            const cnt = cod[4];
            if (cnt < 1 || cnt > 12 || 5 + cnt * 8 + 2 > cod.length) continue;
            if (cod[5 + cnt * 8] !== 67 || cod[6 + cnt * 8] !== 88) continue; // 'CX'
            return cod;
        }
        return null;
    },
    // 主入口：从照片/文件图像像素读 J2 码 → { payload, H, w0, h0 } | null
    readRing(d, cw, ch) {
        const luma = this.luma(d, cw, ch);
        const cand = this.scanFinders(luma, cw, ch);
        if (cand.length < 4) return null;
        const combos = this.candQuads(cand);
        for (const quad of combos) {
            const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
            const ph = quad.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
            for (let r = 0; r < 4; r++) {
                const TL = ph[r], TR = ph[(r + 1) & 3], BR = ph[(r + 2) & 3], BL = ph[(r + 3) & 3];
                const fmt = this.readFmt2(luma, cw, ch, TL, TR, BL, BR);
                if (!fmt) continue;
                const H = this.dlt(this.corners(fmt.cw0, fmt.ch0), [TL, TR, BR, BL]);
                if (!H) continue;
                const bits = this.stream(luma, cw, ch, H, fmt.cw0, fmt.ch0);
                const payload = this.decodePayload(bits, bits.length);
                if (payload) return { payload, H, w0: fmt.cw0, h0: fmt.ch0 };
            }
        }
        return null;
    },
    // finder 候选组合：恰 4 直接；>4 取凸四边形（按质心极角跨度面积）前 6
    candQuads(cand) {
        if (cand.length === 4) return [cand];
        const pick = (arr, k) => { const r = []; const rec = (i, acc) => { if (acc.length === k) { r.push(acc.slice()); return; } for (let j = i; j < arr.length; j++) { acc.push(arr[j]); rec(j + 1, acc); acc.pop(); } }; rec(0, []); return r; };
        const scored = [];
        for (const c of pick(cand, 4)) {
            const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
            const o = c.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
            let area = 0;
            for (let i = 0; i < 4; i++) { const a2 = o[i], b2 = o[(i + 1) & 3]; area += a2.x * b2.y - a2.y * b2.x; }
            scored.push({ o, area: Math.abs(area) });
        }
        scored.sort((a, b) => b.area - a.area);
        return scored.slice(0, 6).map(s => s.o);
    },
    // 内容重建：照片→原内容坐标画布（最近邻，H 映射），界外白
    reconstruct(d, cw, ch, H, w0, h0) {
        const iw = w0 - 128, ih = h0 - 128;
        if (iw < 8 || ih < 8) return null;
        const c2 = document.createElement('canvas'); c2.width = iw; c2.height = ih;
        const x2 = c2.getContext('2d'), id = x2.createImageData(iw, ih), sd = id.data;
        for (let y = 0; y < ih; y++) {
            for (let x = 0; x < iw; x++) {
                const p = this.applyH(H, 64 + x + 0.5, 64 + y + 0.5);
                const px = Math.round(p.x), py = Math.round(p.y), f = (y * iw + x) * 4;
                if (px >= 0 && py >= 0 && px < cw && py < ch) {
                    const s = (py * cw + px) * 4;
                    sd[f] = d[s]; sd[f + 1] = d[s + 1]; sd[f + 2] = d[s + 2];
                } else { sd[f] = 255; sd[f + 1] = 255; sd[f + 2] = 255; }
                sd[f + 3] = 255;
            }
        }
        x2.putImageData(id, 0, 0);
        return c2;
    },
};

const IA = {
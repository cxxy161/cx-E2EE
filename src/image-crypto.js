/* ===== RS(255,k) over GF(256) poly 0x11D（V3-J 鲁棒 JPEG 边框码纠错核；decode 支持擦除，Forney 伴随式）===== */
const RS255 = (() => {
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const MUL = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  const INV = (a) => EXP[(255 - LOG[a]) % 255];
  const genPoly = (np) => { let g = [1]; for (let i = 0; i < np; i++) { const root = EXP[i], ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= MUL(g[j], root); ng[j + 1] ^= g[j]; } g = ng; } return g; };
  const encode = (data, np) => {
    const k = data.length, n = k + np, g = genPoly(np), rem = new Uint8Array(n);
    for (let i = 0; i < k; i++) rem[np + i] = data[k - 1 - i];
    for (let d = n - 1; d >= np; d--) {
      if (rem[d]) { const c = rem[d]; for (let j = 0; j <= np; j++) rem[d - np + j] ^= MUL(g[j], c); rem[d] = 0; }
    }
    const out = new Uint8Array(n); out.set(data, 0);
    for (let i = 0; i < np; i++) out[k + i] = rem[np - 1 - i];
    return out;
  };
  const decode = (r, np, erasIn) => {
    const n = r.length, k = n - np, t = np >> 1, S = new Array(np).fill(0);
    let zero = true;
    for (let i = 0; i < np; i++) { let s = 0, xi = EXP[i]; for (let j = 0; j < n; j++) s = MUL(s, xi) ^ r[j]; S[i] = s; if (s) zero = false; }
    if (zero) return r.slice(0, k);
    const eras = (erasIn || []).slice().sort((a, b) => a - b);
    const s = eras.length;
    if (s > np) return null;
    let Le = [1]; // 擦除定位器（低次在前）
    for (const p of eras) {
      const jj = n - 1 - p, X = EXP[jj % 255], ng = new Array(Le.length + 1).fill(0);
      for (let i = 0; i < Le.length; i++) { ng[i] ^= Le[i]; ng[i + 1] ^= MUL(Le[i], X); }
      Le = ng;
    }
    const F = new Array(np - s).fill(0); // Forney 伴随式：S·Λe，取 degree s..np-1
    for (let i = 0; i < np; i++) for (let j = 0; j < Le.length; j++) { const deg = i + j; if (deg >= s && deg < np) F[deg - s] ^= MUL(S[i], Le[j]); }
    let C = new Array(F.length + 1).fill(0), B = new Array(F.length + 1).fill(0);
    C[0] = 1; B[0] = 1; let L = 0, m = 1, b = 1;
    const N = F.length;
    for (let i = 0; i < N; i++) {
      let dd = F[i];
      for (let j = 1; j <= L; j++) dd ^= MUL(C[j], F[i - j] || 0);
      if (!dd) { m++; continue; }
      const T = C.slice(), coef = MUL(dd, INV(b));
      for (let j = 0; j + m <= N; j++) C[j + m] ^= MUL(B[j], coef);
      if (2 * L <= i) { L = i + 1 - L; B = T; b = dd; m = 1; } else m++;
    }
    const Lu = C.slice(0, L + 1);
    let Lam;
    if (s) {
      Lam = new Array(Le.length + Lu.length - 1).fill(0);
      for (let i = 0; i < Le.length; i++) for (let j = 0; j < Lu.length; j++) Lam[i + j] ^= MUL(Le[i], Lu[j]);
    } else Lam = Lu;
    while (Lam.length && Lam[Lam.length - 1] === 0) Lam.pop();
    const degLam = Lam.length - 1;
    if ((degLam - s) * 2 + s > np) return null;
    const errJ = [];
    for (let j = 0; j < n; j++) {
      const point = j === 0 ? 1 : EXP[(255 - j) % 255];
      let val = Lam[0] || 0, xp = point;
      for (let i = 1; i < Lam.length; i++) { val ^= MUL(Lam[i], xp); xp = MUL(xp, point); }
      if (val === 0) errJ.push(j);
    }
    if (errJ.length !== degLam) return null;
    const Om = new Array(np).fill(0);
    for (let i = 0; i < np; i++) for (let j = 0; j < Lam.length; j++) if (i + j < np && Lam[j]) Om[i + j] ^= MUL(S[i], Lam[j]);
    const out = r.slice();
    for (const j of errJ) {
      const X = EXP[j % 255], point = j === 0 ? 1 : EXP[(255 - j) % 255];
      let dev = 0, pw = 1;
      for (let i = 1; i < Lam.length; i++) { if ((i & 1) && Lam[i]) dev ^= MUL(Lam[i], pw); pw = MUL(pw, point); }
      let om = 0, pw2 = 1;
      for (let i = 0; i < np; i++) { om ^= MUL(Om[i], pw2); pw2 = MUL(pw2, point); }
      const e = MUL(MUL(om, X), INV(dev || 1));
      out[n - 1 - j] ^= e;
    }
    return out.slice(0, k);
  };
  return { encode, decode };
})();

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
        const pts = [], col = (a, b) => { const r = []; for (let x = a; x <= b; x += 8) r.push(x); return r; };
        const topY = [12, 20, 28, 36, 44, 52, 60], rightX = [], botY = [], leftX = [];
        for (let k = 0; k < 7; k++) { rightX.push(cw - 60 + 8 * k); botY.push(ch - 60 + 8 * k); leftX.push(12 + 8 * k); }
        for (const yc of topY) for (const xc of col(68, cw - 68)) pts.push({ x: xc, y: yc });
        for (const xc of rightX) for (const yc of col(68, ch - 68)) pts.push({ x: xc, y: yc });
        for (const yc of botY) for (const xc of col(68, cw - 68)) pts.push({ x: xc, y: yc });
        for (const xc of leftX) for (const yc of col(68, ch - 68)) pts.push({ x: xc, y: yc });
        return pts;
    },
    // 格式区模块中心（贴 Finder 邻域、尺寸无关）：TL 份 x68..172×y12..60；BR 份 x=cw-172..cw-68（各 14 列，取前 96 模块）
    fmtSet(cw, ch) {
        const out = [], col = (a, b) => { const r = []; for (let x = a; x <= b; x += 8) r.push(x); return r; };
        const topY = [12, 20, 28, 36, 44, 52, 60], botY = [];
        for (let k = 0; k < 7; k++) botY.push(ch - 60 + 8 * k);
        for (const yc of topY) for (const xc of col(68, 172)) out.push({ x: xc, y: yc });
        for (const yc of botY) for (const xc of col(cw - 172, cw - 68)) out.push({ x: xc, y: yc });
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
    // 编码 payload（≤127B）画入边框；TL/BR 邻域 19 列留作格式区（贴 Finder、尺寸无关，承载画布尺寸供自举）
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
        const fmtB = [0x4A, 0x32, cw >> 8 & 255, cw & 255, ch >> 8 & 255, ch & 255];
        const fCod = RS255.encode(fmtB, 6); // RS(12,6) t=3 → 12B → 96bit
        const paintFmt = (set) => {
            const L = 96, S = this.stride(L);
            for (let i = 0; i < L; i++) { const b = (fCod[i >> 3] >> (7 - (i & 7))) & 1; this.paintMod(d, cw, set[(i * S) % L], b); }
        };
        paintFmt(fmt.slice(0, 96));
        paintFmt(fmt.slice(98, 194));
        const buf = new Uint8Array(127); buf.set(payload, 0);
        const cod = RS255.encode(buf, np), L = cod.length * 8, S = this.stride(L);
        const fm = [];
        for (const p0 of mods) if (!fmtK.has(p0.x + ',' + p0.y)) fm.push(p0);
        for (let p = 0; p < L && p < fm.length; p++) {
            const b = (cod[p >> 3] >> (7 - (p & 7))) & 1;
            this.paintMod(d, cw, fm[(p * S) % L], b);
        }
        return L <= fm.length;
    },
    /* --- 读取侧 --- */
    /* --- 读取侧 --- */
    luma(d, cw, ch) {
        const L = new Uint8Array(cw * ch);
        for (let i = 0; i < L.length; i++) L[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
        return L;
    },
    // 行/列游程扫描 1:1:3:1:1 回字，双向确认 + 亚像素中心 + 模块尺度估计
    scanFinders(luma, cw, ch) {
        const hits = [];
        // 工作量预算：大尺寸/噪声图（如 PNG 打码图）的随机图案会产生海量疑似回字命中，
        // 逐行列确认会让解密卡死。真 Finder 的命中少且稳定，预算截断对识别几乎无损。
        const ROW_HIT_MAX = 12, TOTAL_HIT_MAX = 320, COL_BUDGET = 900;
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
            let rowHits = 0;
            for (let i = 0; i + 4 < runs.length; i++) {
                if (hits.length >= TOTAL_HIT_MAX) break;
                const r = runs;
                if (!r[i].d || r[i + 1].d || !r[i + 2].d || r[i + 3].d || !r[i + 4].d) continue;
                const base = r[i + 2].len / 3;
                if (base < 2.5 || base > 60) continue;
                let ok = true;
                for (const j of [0, 1, 3]) { const l = r[i + j].len; if (Math.abs(l - base) > base * 2 || l < base * 0.5) { ok = false; break; } }
                if (!ok || r[i + 2].len < base * 2 || r[i + 4].len < base * 0.5) continue; // 第5段(最外黑框)外侧可能紧邻图像内容，仅设下界
                hits.push({ x: r[i + 2].x0 + r[i + 2].len / 2, y: y, m: base });
                if (++rowHits >= ROW_HIT_MAX) break;
            }
            if (hits.length >= TOTAL_HIT_MAX) break;
        }
        const out = [];
        let colUsed = 0;
        for (const h of hits) {
            if (colUsed >= COL_BUDGET) break;
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
            colUsed++;
            for (let i = 0; i + 4 < runs2.length; i++) {
                const r = runs2;
                if (!r[i].d || r[i + 1].d || !r[i + 2].d || r[i + 3].d || !r[i + 4].d) continue;
                const base = r[i + 2].len / 3;
                if (base < 2.5 || base > 60) continue;
                let ok = true;
                for (const j of [0, 1, 3]) { const l = r[i + j].len; if (Math.abs(l - base) > base * 2 || l < base * 0.5) { ok = false; break; } }
                if (!ok || r[i + 2].len < base * 2 || r[i + 4].len < base * 0.5) continue;
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
        // 游程 m 仅作粗估计；精确模块尺由 readRing 的 measureFinder 亚像素边缘测量提供
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
    norm(dx, dy) { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; },
    // —— 亚像素模块尺测量（QR 式）：finder 中心十字 4 方向取亮度线，阈值游程定位中心暗段与外框段，
    //    边界线性插值亚像素 → mX=(右外框右缘−左外框左缘)/7、mY 同理；抗曝光膨胀/JPEG 振铃。
    edgeCross(get, g0, th, dir) {
        for (let i = 1; i <= 10; i++) {
            const a = get(g0 + dir * (i - 1)), b = get(g0 + dir * i);
            if ((a < th) !== (b < th)) return g0 + dir * (i - 1) + (th - a) / ((b - a) || 1);
        }
        return null;
    },
    measureFinder(luma, cw, ch, cx, cy) {
        const axis = (dx, dy) => {
            // 采样范围截断到画布内（边缘 finder 会越界，要求有效长度足够）
            const lo = Math.max(0, Math.round(cx - dx * 45)), hi = Math.min(cw - 1, Math.round(cx + dx * 45));
            const lo2 = Math.max(0, Math.round(cy - dy * 45)), hi2 = Math.min(ch - 1, Math.round(cy + dy * 45));
            const n = (dx !== 0 ? hi - lo + 1 : hi2 - lo2 + 1);
            if (n < 30) return null;
            const vals = [];
            for (let k = 0; k < n; k++) {
                const x = dx !== 0 ? (lo + k) : Math.round(cx);
                const y = dy !== 0 ? (lo2 + k) : Math.round(cy);
                vals.push(luma[y * cw + x]);
            }
            const c0 = dx !== 0 ? (Math.round(cx) - lo) : (Math.round(cy) - lo2);
            let mn = 255, mx = 0;
            for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
            if (mx - mn < 60) return null;
            const th = (mn + mx) / 2;
            const runs = []; let s = 0, cur = vals[0] < th;
            for (let i = 1; i <= vals.length; i++) { const v = i < vals.length ? (vals[i] < th) : !cur; if (i === vals.length || v !== cur) { runs.push({ d: cur, x0: s, len: i - s }); s = i; cur = v; } }
            let ci = -1;
            for (let i = 0; i < runs.length; i++) { if (runs[i].d && runs[i].x0 <= c0 && c0 < runs[i].x0 + runs[i].len) { ci = i; break; } }
            if (ci < 2 || ci + 2 >= runs.length) return null;
            if (runs[ci].len < 6 || runs[ci].len > 60) return null; // 中心 3×3 黑块（曝光膨胀可达 44px）
            const l = runs[ci - 2], r = runs[ci + 2];
            if (!l.d || !r.d) return null;
            if (l.len > 40 || r.len > 40) return null; // 外框应≈1 模块
            // 外框外侧必须都是亮（quiet/白背景）；紧邻数据/内容时本方向尺度不可靠 → 拒绝
            if (ci - 3 < 0 || ci + 3 >= runs.length) return null;
            if (runs[ci - 3].d || runs[ci + 3].d) return null;
            const get = i => (i >= 0 && i < vals.length) ? vals[i] : th;
            const xL = this.edgeCross(get, l.x0, th, -1); // 外框左缘（暗→背景亮，从暗段内朝外找交叉）
            const xR = this.edgeCross(get, r.x0 + r.len - 1, th, 1); // 外框右缘（暗→背景亮）
            if (xL === null || xR === null) return null;
            const span = xR - xL;
            if (span < 18 || span > 600) return null;
            return span;
        };
        const hSpan = axis(1, 0), vSpan = axis(0, 1);
        if (!hSpan && !vSpan) return null;
        return { mX: hSpan ? hSpan / 7 : null, mY: vSpan ? vSpan / 7 : null };
    },
    // 由 4 个 finder 估计画布尺寸（分轴：水平用 TL/TR 的 mX 平均，垂直用 TL/BL 的 mY 平均）
    estimateWH(luma, cw, ch, quad) {
        const xm = [], ym = [];
        for (const f of quad) {
            const m = this.measureFinder(luma, cw, ch, f.x, f.y);
            if (m) { if (m.mX) xm.push(m.mX); if (m.mY) ym.push(m.mY); }
        }
        if (!xm.length || !ym.length) return null;
        const avg = a => a.reduce((p, v) => p + v, 0) / a.length;
        const TL = quad[0], TR = quad[1], BL = quad[3];
        const W0 = Math.round(Math.hypot(TR.x - TL.x, TR.y - TL.y) / avg(xm) * 8) + 72;
        const H0 = Math.round(Math.hypot(BL.x - TL.x, BL.y - TL.y) / avg(ym) * 8) + 72;
        if (W0 < 96 || H0 < 96 || W0 > 40000 || H0 > 40000) return null;
        return { W0, H0, mX: avg(xm), mY: avg(ym) };
    },
    samplePt(luma, cw, ch, px, py, r) {
        const cx0 = Math.round(px), cy0 = Math.round(py), rr = Math.max(1, Math.ceil(r));
        if (cx0 - rr < 0 || cy0 - rr < 0 || cx0 + rr >= cw || cy0 + rr >= ch) {
            return cx0 >= 0 && cy0 >= 0 && cx0 < cw && cy0 < ch ? luma[cy0 * cw + cx0] : 255;
        }
        let s = 0, n = 0;
        for (let y = -rr; y <= rr; y++) { const o = (cy0 + y) * cw; for (let x = -rr; x <= rr; x++) { s += luma[o + cx0 + x]; n++; } }
        return s / n;
    },
    // 照片→代码画布同序采样数据模块（跳过格式区槽，与写端一致）
    stream(luma, cw, ch, H, cw0, ch0) {
        const mods = this.order(cw0, ch0), fmtK = new Set(this.fmtSet(cw0, ch0).map(p => p.x + ',' + p.y));
        const vals = [];
        let mn = 1e9, mx = -1;
        for (const mod of mods) {
            if (fmtK.has(mod.x + ',' + mod.y)) continue;
            const p = this.applyH(H, mod.x, mod.y);
            const q = this.applyH(H, mod.x + 8, mod.y);
            const sm = Math.hypot(q.x - p.x, q.y - p.y);
            const v = this.samplePt(luma, cw, ch, p.x, p.y, Math.max(2, sm * 0.375));
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
// 局部仿射读 TL 邻域格式区（19 列×7 行，取前 128 模块）：代码偏移相对 TL finder 中心固定，
    // 照片位置 = TL + (dx/8)*mX*ux + (dy/8)*mY*uy —— 完全尺寸无关（QR format 贴角等价物）
    readFmtLocal(luma, cw, ch, TL, ux, uy, mX, mY) {
        if (!mX) return null;
        mY = mX; // 垂直尺度在内容邻域易被污染（mY 波动 7.8~10.1），格式区垂直跨度仅 ±24px，用水平尺度足够
        const vals = new Float64Array(96);
        let bi = 0, mn = 1e9, mx = -1;
        for (let k2 = 0; k2 < 7 && bi < 96; k2++) {
            const codeY = 12 + 8 * k2, dy = (codeY - 36);
            for (let k = 0; k < 14 && bi < 96; k++) {
                const codeX = 68 + 8 * k, dx = (codeX - 36);
                const px = TL.x + (dx / 8) * mX * ux.x + (dy / 8) * mY * uy.x;
                const py = TL.y + (dx / 8) * mX * ux.y + (dy / 8) * mY * uy.y;
                const v = this.samplePt(luma, cw, ch, px, py, Math.max(1.5, mX * 0.42));
                vals[bi++] = v; if (v < mn) mn = v; if (v > mx) mx = v;
            }
        }
        if (bi < 96) return null;
        const th = (mn + mx) / 2;
        const S = this.stride(96);
        const bytes = new Uint8Array(12);
        for (let i = 0; i < 12; i++) { let v = 0; for (let j = 0; j < 8; j++) v = v * 2 + (vals[(i * 8 + j) * S % 96] < th ? 1 : 0); bytes[i] = v; }
        const cod = RS255.decode(bytes, 6);
        if (!cod || cod.length < 6) return null;
        if (cod[0] !== 0x4A || cod[1] !== 0x32) return null;
        const cw0 = cod[2] * 256 + cod[3], ch0 = cod[4] * 256 + cod[5];
        if (cw0 < 96 || ch0 < 96 || cw0 > 40000 || ch0 > 40000) return null;
        return { cw0, ch0 };
    },
    // 主入口：从照片/文件图像像素读 J2 码 → { payload, H, w0, h0 } | null
    // QR 式流程：4 Finder → 局部仿射读 TL 格式区(尺寸无关) → 得真画布尺寸 → DLT → 数据网格 → payload
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
                const trySize = (cw0, ch0) => {
                    if (cw0 < 96 || ch0 < 96 || cw0 > 40000 || ch0 > 40000) return null;
                    const H = this.dlt(this.corners(cw0, ch0), [TL, TR, BR, BL]);
                    if (!H) return null;
                    const bits = this.stream(luma, cw, ch, H, cw0, ch0);
                    const payload = this.decodePayload(bits, bits.length);
                    if (!payload) return null;
                    const pcw = payload[0] * 256 + payload[1], pch = payload[2] * 256 + payload[3];
                    if (pcw >= 96 && pch >= 96 && (Math.abs(pcw - cw0) > 2 || Math.abs(pch - ch0) > 2)) {
                        const H2 = this.dlt(this.corners(pcw, pch), [TL, TR, BR, BL]);
                        const b2 = H2 ? this.stream(luma, cw, ch, H2, pcw, pch) : null;
                        const p2 = b2 ? this.decodePayload(b2, b2.length) : null;
                        if (p2) return { payload: p2, H: H2, w0: pcw, h0: pch };
                    }
                    return { payload, H, w0: pcw, h0: pch };
                };
                // 局部仿射读格式区（尺寸无关）
                const m = this.measureFinder(luma, cw, ch, TL.x, TL.y);
                if (!m) continue;
                const ux = this.norm(TR.x - TL.x, TR.y - TL.y), uy = this.norm(BL.x - TL.x, BL.y - TL.y);
                const fmt = this.readFmtLocal(luma, cw, ch, TL, ux, uy, m.mX, m.mY);
                if (!fmt) continue;
                const hit = trySize(fmt.cw0, fmt.ch0);
                if (hit) return hit;
                // 格式区读到的尺寸直接用于网格，但低质量 JPEG 下格式位可能有少量错 → 附近整数微调
                for (let dw = -8; dw <= 8; dw += 8) for (let dh = -8; dh <= 8; dh += 8) {
                    const h2 = trySize(fmt.cw0 + dw, fmt.ch0 + dh);
                    if (h2) return h2;
                }
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
        return scored.slice(0, 12).map(s => s.o);
    },
    // 内容重建：照片→原内容坐标画布（最近邻，H 映射），界外白
    // 取整用 floor：内容像素中心 +0.5 落在源像素内核（round 会整体 +1px 偏移，
    // 导致区域 16px 单元边缘 1px 未还原，且底部/右侧残留 1px 边框像素）
    reconstruct(d, cw, ch, H, w0, h0) {
        const iw = w0 - 128, ih = h0 - 128;
        if (iw < 8 || ih < 8) return null;
        const c2 = document.createElement('canvas'); c2.width = iw; c2.height = ih;
        const x2 = c2.getContext('2d'), id = x2.createImageData(iw, ih), sd = id.data;
        for (let y = 0; y < ih; y++) {
            for (let x = 0; x < iw; x++) {
                const p = this.applyH(H, 64 + x + 0.5, 64 + y + 0.5);
                const px = Math.floor(p.x), py = Math.floor(p.y), f = (y * iw + x) * 4;
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
    al: 'v3', fs: { e: null, d: null }, target: 'e',
    showV1() {
        $('b-v1').style.display = '';
        this.set('v1');
        $('v1-toggle').style.display = 'none';
    },
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
    set(v) {
        this.al = v;
        $('b-v1').className = v === 'v1' ? 'ao on' : 'ao';
        $('b-v2').className = v === 'v2' ? 'ao on' : 'ao';
        $('b-v3').className = v === 'v3' ? 'ao on' : 'ao';
        $('pa-v1').style.display = v === 'v1' ? 'block' : 'none';
        $('pa-v2').style.display = v === 'v2' ? 'block' : 'none';
        $('pa-v3').style.display = v === 'v3' ? 'block' : 'none';
        // V3 时隐藏默认加密按钮与通用密码框（V3 面板有自己的密码输入，位于打码区域下方）；整页切换蓝白主题
        const mainBtn = document.querySelector('#sp-e .btn');
        if (mainBtn) mainBtn.style.display = v === 'v3' ? 'none' : '';
        if ($('lbl-ke')) $('lbl-ke').style.display = v === 'v3' ? 'none' : '';
        if ($('ke')) $('ke').style.display = v === 'v3' ? 'none' : '';
        $('v1-toggle').style.display = v === 'v3' ? 'none' : '';
        document.body.classList.toggle('v3-theme', v === 'v3');
        // 扫码器只属于 V3（识别 V3-J2 四角回字码），V1/V2 隐藏；切算法时关闭浮层
        const sb = $('scan-btn'); if (sb) sb.style.display = v === 'v3' ? '' : 'none';
        if (v !== 'v3' && this.scan && this.scan.on) this.scan.close();
        if (v === 'v3') this.initV3();
    },
    ui() { let v1 = parseInt($('qv1').value), v2 = parseInt($('qv2').value), v3 = parseInt($('qv3').value);
        $('vq1').innerText = v1 == 100 ? "PNG" : v1 + "%"; $('vs2').innerText = $('sv2').value + "%"; $('vs3').innerText = $('sv3').value + "%"; $('vq2').innerText = v2 == 100 ? "PNG" : v2 + "%"; $('vq3').innerText = v3 == 100 ? "PNG" : v3 + "%"; },
    ld(i, t) {
        const f = i.files[0]; if (!f) return; this.fs[t] = f; this.target = t;
        // 加密/解密面板各自独立的 blob URL，避免互相 revoke 导致预览失效
        if (!this.u) this.u = {};
        if (this.u[t]) URL.revokeObjectURL(this.u[t]);
        this.u[t] = URL.createObjectURL(f);
        $('pv-' + t).src = this.u[t]; $('pv-' + t).classList.add('on'); $('lb-' + t).style.display = 'none';
        // 仅加密区载入时同步打码编辑器；解密载入不影响编辑状态
        if (this.al === 'v3' && t === 'e') MOB.loadFrom(this.u[t], t);
    },
    // 计算中状态：按钮禁用+文案，先让出一帧再执行同步计算（否则 busy 样式来不及渲染）
    setBusy(t, on) {
        const list = [];
        const b0 = document.querySelector(t === 'e' ? '#sp-e .btn' : '#sp-d .btn');
        if (b0) list.push(b0);
        if (t === 'e') { const b1 = document.querySelector('.v3-enc'); if (b1) list.push(b1); }
        for (const b of list) {
            if (!b) continue;
            if (on) {
                if (!b.dataset.busyTxt) b.dataset.busyTxt = b.textContent;
                b.textContent = '⏳ 计算中…'; b.disabled = true; b.classList.add('busy');
            } else {
                if (b.dataset.busyTxt) b.textContent = b.dataset.busyTxt;
                b.disabled = false; b.classList.remove('busy');
            }
        }
    },
    run(t) {
        if (this.busy && this.busy[t]) return;
        const f = this.fs[t]; if (!f && !$('pv-' + t).src) return T("请先载入图片");
        const k = (t === 'e' ? ($('ke3') ? $('ke3').value : $('ke').value) : $('kd').value) || '';
        if (!k) return T("请输入密码");
        if (!this.busy) this.busy = {};
        this.busy[t] = true;
        this.setBusy(t, true);
        const self = this;
        setTimeout(() => {
            const img = new Image();
            const finish = () => { self.busy[t] = false; self.setBusy(t, false); };
            img.onload = () => {
                try {
                    if (self.al === 'v1') self.pV1(img, k, t);
                    else if (self.al === 'v2') self.pV2(img, k, t);
                    else self.pV3(img, k, t);
                } finally { finish(); }
            };
            img.onerror = () => { finish(); T("图片加载失败"); };
            img.src = $('pv-' + t).src;
        }, 40);
    },
    /* ===== 手机摄像头扫码器：帧循环 readRing 识别，命中即自动还原（扫码器需要 secure context 才能调摄像头） ===== */
    scan: {
        on: false, stream: null, raf: 0, lastT: 0, busyHit: false,
        open() {
            if (this.on) return;
            const ov = $('scan-overlay');
            if (!ov) return T("扫码器组件缺失");
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { T("当前浏览器/环境不支持摄像头（手机需用 https 或 localhost 访问）"); return; }
            this.on = true;
            ov.classList.add('on');
            const st = $('scan-status'); if (st) st.textContent = '正在启动摄像头…';
            const self = this;
            navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            }).then(stream => {
                if (!self.on) { stream.getTracks().forEach(t => t.stop()); return; }
                self.stream = stream;
                const v = $('scan-video'); v.srcObject = stream; v.play().catch(() => {});
                if (st) st.textContent = '对准打码图…';
                self.lastT = 0;
                self.loop();
            }).catch(e => {
                self.on = false;
                self._stop();
                // 保留浮层：摄像头失败也要让用户看到「拍照识别」「摄像头诊断」兜底按钮
                const st = $('scan-status');
                const why = (e && e.name) || String(e);
                if (st) st.textContent = '摄像头不可用（' + why + '）—— 可直接拍照识别，或点「摄像头诊断」查原因';
                if (e && e.name === 'NotAllowedError') T("摄像头被拦截（NotAllowedError）：浮层已保留，请用「拍照识别」，或点「摄像头诊断」把结果发我");
                else if (e && e.name === 'SecurityError') T("安全策略拦截（SecurityError）：请点「摄像头诊断」查看是否被 Permissions-Policy/iframe 限制");
                else T("摄像头不可用：" + why + ' —— 浮层已保留，可用「拍照识别」');
            });
        },
        // 拍照识别兜底：调起系统相机拍一张 → 自动识别还原（不依赖 getUserMedia 权限，全平台可用）
        photo() {
            const inp = $('scan-photo-input');
            if (!inp) return T("拍照组件缺失");
            const st = $('scan-status'); if (st) st.textContent = '拍照后将自动识别…';
            const self = this;
            inp.onchange = () => {
                const f = inp.files[0];
                inp.value = '';
                if (!f) return;
                const url = URL.createObjectURL(f);
                const img = new Image();
                img.onload = () => { self.hitPhoto(url, img); };
                img.onerror = () => T("照片读取失败");
                img.src = url;
            };
            inp.click();
        },
        // 摄像头诊断：输出 secure context/camera 权限状态/FeaturePolicy/getUserMedia 原始错误（用 T 逐行展示）
        diag() {
            const lines = [];
            const show = () => { const t = $('tst'); if (t) { t.style.whiteSpace = 'pre-line'; t.innerText = lines.join('\n'); t.className = 'on'; clearTimeout(t.tm); t.tm = setTimeout(() => { t.className = ''; t.style.whiteSpace = ''; }, 15000); } };
            lines.push('secureContext=' + (window.isSecureContext ? 'yes' : 'NO'));
            if (document.permissionsPolicy && document.permissionsPolicy.allowsFeature) { lines.push('policy.camera.allowed=' + document.permissionsPolicy.allowsFeature('camera')); }
            else if (document.featurePolicy && document.featurePolicy.allowsFeature) { lines.push('featurePolicy.camera=' + document.featurePolicy.allowsFeature('camera')); }
            else { lines.push('policyAPI=n/a'); }
            const tryPerm = () => {
                if (navigator.permissions && navigator.permissions.query) {
                    navigator.permissions.query({ name: 'camera' }).then(s => { lines.push('permissions.camera=' + s.state); show(); })
                        .catch(e => { lines.push('permissions.query err=' + e.name); show(); });
                } else { lines.push('permissionsAPI=n/a'); show(); }
                return;
            };
            try {
                navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(s => {
                    lines.push('getUserMedia=OK!');
                    s.getTracks().forEach(t => t.stop());
                    show();
                }).catch(e => {
                    lines.push('gUM fail: name=' + e.name + ' msg=' + (e.message || '') + ' constraint=' + (e.constraint || ''));
                    tryPerm();
                });
            } catch (e) { lines.push('gUM throw=' + e); tryPerm(); }
            show();
        },
        hitPhoto(url, img) {
            const k = $('kd') ? $('kd').value : '';
            if (!k) { T("请先在解密框输入密码再拍照识别"); return; }
            URL.revokeObjectURL(url);
            IA.setBusy('d', true);
            const finish = () => IA.setBusy('d', false);
            try { IA.pV3(img, k, 'd'); } catch (e) { finish(); T("识别失败：" + e); return; }
            finish();
            // 若 pV3 未识别（pV3 内部报 T），延时提示重拍
            setTimeout(() => {
                const t = $('tst') ? $('tst').innerText : '';
                if (t.includes('未识别')) T("没拍好：请把打码图完整放入取景框后重拍");
            }, 1200);
        },
        close() {
            this.on = false;
            this._stop();
            if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
            const ov = $('scan-overlay'); if (ov) ov.classList.remove('on');
        },
        _stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } },
        loop() {
            if (!this.on) return;
            const self = this;
            this.raf = requestAnimationFrame(() => self.tick());
        },
        tick() {
            if (!this.on) return;
            const now = performance.now();
            if (now - this.lastT > 150) { // ≈6fps
                this.lastT = now;
                const hit = this.detect();
                if (hit) { this.hit(hit); return; }
            }
            this.loop();
        },
        detect() {
            const vd = $('scan-video'); if (!vd || !vd.videoWidth) return null;
            const cv = $('scan-canvas'); if (!cv) return null;
            const x = cv.getContext('2d');
            const scale = Math.min(1, 1280 / vd.videoWidth);
            const w = Math.max(8, Math.round(vd.videoWidth * scale)), h = Math.max(8, Math.round(vd.videoHeight * scale));
            cv.width = w; cv.height = h;
            x.drawImage(vd, 0, 0, w, h);
            const d = x.getImageData(0, 0, w, h);
            const rr = J2.readRing(d.data, w, h);
            if (rr) return { rr, d, w, h };
            return null;
        },
        hit(res) {
            this._stop();
            const st = $('scan-status'); if (st) st.textContent = '识别成功，正在还原…';
            const k = $('kd') ? $('kd').value : '';
            if (!k) { T("请先在解密框输入密码再扫码"); this.close(); return; }
            const self = this;
            const cv = $('scan-canvas');
            const onImg = (img) => {
                IA.setBusy('d', true);
                try { IA.pV3(img, k, 'd'); } finally { IA.setBusy('d', false); }
                self.close();
            };
            try {
                const url = cv.toDataURL('image/jpeg', 0.92);
                const img = new Image();
                img.onload = () => onImg(img);
                img.onerror = () => { T("画面转码失败"); self.close(); };
                img.src = url;
            } catch (e) { T("画面转码失败：" + e); self.close(); }
        }
    },
    pV1(img, k, t) {
        const c = $('cvs'), x = c.getContext('2d'), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (w * h > 16777216) { T("图片过大，可能导致崩溃"); return; }
        c.width = w; c.height = h; x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, w, h).data, len = w * h, p = this.perm(len, this.hash(k)), b = new Uint8ClampedArray(d.length), E = t === 'e';
        if (E) for (let i = 0; i < len; i++) { const s = p[i] * 4, dst = i * 4; b[dst] = d[s]; b[dst + 1] = d[s + 1]; b[dst + 2] = d[s + 2]; b[dst + 3] = 255; }
        else for (let i = 0; i < len; i++) { const s = i * 4, dst = p[i] * 4; b[dst] = d[s]; b[dst + 1] = d[s + 1]; b[dst + 2] = d[s + 2]; b[dst + 3] = 255; }
        x.putImageData(new ImageData(b, w, h), 0, 0);
        let q = 1.0, m = 'image/png'; if (E) { const v = parseInt($('qv1').value); if (v < 100) { m = 'image/jpeg'; q = v / 100; } } this.fin(c, t, m, q);
    },
    pV2(img, k, t) {
        const c = $('cvs'), x = c.getContext('2d'), E = t === 'e'; let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (E) { const s = parseInt($('sv2').value) / 100; if (s < 1) { w = Math.floor(w * s); h = Math.floor(h * s); } }
        w = Math.floor(w / 8) * 8; h = Math.floor(h / 8) * 8; if (w < 8) w = 8; if (h < 8) h = 8;
        if (w * h > 16777216) { T("图片过大，可能导致崩溃"); return; }
        c.width = w; c.height = h; x.drawImage(img, 0, 0, w, h);
        const d = x.getImageData(0, 0, w, h).data, sd = this.hash(k), r = this.rng(sd), bl = w * h / 64, p = this.perm(bl, sd), cm = new Int32Array(bl), nr = this.rng(sd + 999);
        for (let i = 0; i < bl; i++) cm[i] = Math.floor(nr() * 1e6);
        const b = new Uint8ClampedArray(d.length), bx = w / 8, CM = v => 50 + (v / 255) * 155, EX = v => { let n = (v - 50) / 155; if (n < 0) n = 0; if (n > 1) n = 1; return n * 255; };
        for (let i = 0; i < bl; i++) {
            let si, di; if (E) { si = i; di = p[i]; } else { si = p[i]; di = i; }
            const sx = (si % bx) * 8, sy = Math.floor(si / bx) * 8, dx = (di % bx) * 8, dy = Math.floor(di / bx) * 8;
            const rw = cm[E ? di : si], ns = (rw % 81) - 40, fU = rw & 0x100, fV = rw & 0x200, sw = rw & 0x400;
            for (let y = 0; y < 8; y++) for (let l = 0; l < 8; l++) {
                const sI = ((sy + y) * w + (sx + l)) * 4, dI = ((dy + y) * w + (dx + l)) * 4;
                let R = d[sI], G = d[sI + 1], B = d[sI + 2], Y = .299 * R + .587 * G + .114 * B, U = -.147 * R - .289 * G + .436 * B, V = .615 * R - .515 * G - .1 * B;
                if (E) { Y = CM(Y) + ns; if (sw) [U, V] = [V, U]; if (fU) U = -U; if (fV) V = -V; } else { if (fV) V = -V; if (fU) U = -U; if (sw) [U, V] = [V, U]; Y -= ns; Y = EX(Y); }
                R = Y + 1.14 * V; G = Y - .395 * U - .581 * V; B = Y + 2.032 * U; b[dI] = R; b[dI + 1] = G; b[dI + 2] = B; b[dI + 3] = 255;
            }
        }
        x.putImageData(new ImageData(b, w, h), 0, 0);
        let q = 1.0, m = 'image/png'; if (E) { const v = parseInt($('qv2').value); if (v < 100) { m = 'image/jpeg'; q = v / 100; } } this.fin(c, t, m, q);
    },
    initV3() { MOB.setup(); },
    /* 区域内 N×N 块置换 + 块级 YUV 变换（unit=置换单元边长，PNG=8，JPEG 鲁棒=16）；
       sort=true 时加密末尾按亮度排序（索引写LSB），解密开头逆排（仅 PNG 路径使用，unit 恒 8） */
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
    /* 区域内块按亮度排序（E=true 写原索引到块首像素 R LSB；E=false 读 LSB 逆排） */
    sortRegion(d, w, h, x0, y0, bx, by, bl, enc) {
        const rbit = Math.ceil(Math.log2(bl)) || 1, ord = new Int32Array(bl);
        const lum = new Float64Array(bl);
        for (let i = 0; i < bl; i++) {
            let s = 0;
            for (let y = 0; y < 8; y++) for (let l = 0; l < 8; l++) {
                const f = ((y0 + Math.floor(i / bx) * 8 + y) * w + (x0 + (i % bx) * 8 + l)) * 4;
                s += d[f] * .299 + d[f + 1] * .587 + d[f + 2] * .114;
            }
            lum[i] = s / 64;
        }
        if (enc) {
            for (let i = 0; i < bl; i++) ord[i] = i;
            ord.sort((a, b) => lum[a] - lum[b]); // 亮度升序
            // 应用重排并把原索引写进每个目标块首像素 R LSB
            const tmp = new Uint8ClampedArray(d);
            for (let j = 0; j < bl; j++) {
                const src = ord[j]; // 新位置 j 应放原 src 块
                for (let y = 0; y < 8; y++) for (let l = 0; l < 8; l++) {
                    const sf = ((y0 + Math.floor(src / bx) * 8 + y) * w + (x0 + (src % bx) * 8 + l)) * 4;
                    const tf = ((y0 + Math.floor(j / bx) * 8 + y) * w + (x0 + (j % bx) * 8 + l)) * 4;
                    d[tf] = tmp[sf]; d[tf + 1] = tmp[sf + 1]; d[tf + 2] = tmp[sf + 2];
                }
                // 写原索引到块首 rbit 像素 R LSB
                for (let b = 0; b < rbit; b++) {
                    const f = ((y0 + Math.floor(j / bx) * 8) * w + (x0 + (j % bx) * 8) + b) * 4;
                    d[f] = (d[f] & 254) | (src >> b & 1);
                }
            }
        } else {
            // 读每块首像素 LSB 得到原索引，逆排
            const idx = new Int32Array(bl), tmp = new Uint8ClampedArray(d);
            for (let j = 0; j < bl; j++) {
                let v = 0;
                for (let b = 0; b < rbit; b++) {
                    const f = ((y0 + Math.floor(j / bx) * 8) * w + (x0 + (j % bx) * 8) + b) * 4;
                    v |= (tmp[f] & 1) << b;
                }
                idx[j] = v;
            }
            for (let j = 0; j < bl; j++) {
                const dst = idx[j];
                for (let y = 0; y < 8; y++) for (let l = 0; l < 8; l++) {
                    const sf = ((y0 + Math.floor(j / bx) * 8 + y) * w + (x0 + (j % bx) * 8 + l)) * 4;
                    const tf = ((y0 + Math.floor(dst / bx) * 8 + y) * w + (x0 + (dst % bx) * 8 + l)) * 4;
                    d[tf] = tmp[sf]; d[tf + 1] = tmp[sf + 1]; d[tf + 2] = tmp[sf + 2];
                }
            }
        }
    },
    /* 元数据字节流：count + 区域坐标 + 魔数CX + 签名 + 标志(bit0=诱饵,bit1=排序,bit2-3=降采样率-1) + 数据长度LE */
    metaBytes(count, regions, k, flag, dataLen) {
        const bs = [count];
        for (const r of regions) bs.push(r.x >> 8 & 255, r.x & 255, r.y >> 8 & 255, r.y & 255, r.w >> 8 & 255, r.w & 255, r.h >> 8 & 255, r.h & 255);
        bs.push(67, 88); // "CX"
        const sig = (this.hash('V3|' + count + '|' + regions.map(r => r.x + ',' + r.y + ',' + r.w + ',' + r.h).join('&') + '|' + k) >>> 0) & 0xFFFFFF;
        bs.push(sig >> 16 & 255, sig >> 8 & 255, sig & 255);
        bs.push(flag & 255, dataLen >>> 24 & 255, dataLen >>> 16 & 255, dataLen >>> 8 & 255, dataLen & 255);
        return bs;
    },
    /* ===== V3 外扩边框元数据：原图居中，四周 B 宽边框承载元数据，原图像素零占用 ===== */
    /* PNG 模式边框宽度 8px（LSB）；JPEG 模式 64px（J2 拍屏鲁棒码：Finder 定位 + 二值环带） */
    bW() { return parseInt($('qv3').value) < 100 ? 64 : 8; },
    /* 边框像素索引流：顶→右→底→左（跳过四角），供 LSB 或块级使用 */
    borderOrd(cw, ch, B) {
        const pts = [];
        for (let x = 0; x < cw; x++) for (let y = 0; y < B; y++) pts.push(y * cw + x);          // 顶
        for (let y = B; y < ch - B; y++) for (let x = cw - B; x < cw; x++) pts.push(y * cw + x); // 右
        for (let x = cw - 1; x >= 0; x--) for (let y = ch - B; y < ch; y++) pts.push(y * cw + x); // 底
        for (let y = ch - B - 1; y >= B; y--) for (let x = 0; x < B; x++) pts.push(y * cw + x);   // 左
        return pts;
    },
    /* PNG/LSB：每字节写 8 像素 R 最低位 */
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
    /* 边框 8×8 块坐标流：顶(全宽)→右(y避开角)→底(全宽)→左(y避开角) */
    borderBlocks(w, h, B) {
        const bz = w >> 3, bh = h >> 3, nb = B >> 3, bl = [];
        for (let r = 0; r < nb; r++) for (let c = 0; c < bz; c++) bl.push({ x: c * 8, y: r * 8 });                    // 顶
        for (let r = nb; r < bh - nb; r++) for (let c = 0; c < nb; c++) bl.push({ x: w - B + c * 8, y: r * 8 });      // 右
        for (let r = bh - nb; r < bh; r++) for (let c = 0; c < bz; c++) bl.push({ x: c * 8, y: r * 8 });              // 底
        for (let r = nb; r < bh - nb; r++) for (let c = 0; c < nb; c++) bl.push({ x: c * 8, y: r * 8 });              // 左
        return bl;
    },
    wMetaJpeg(bs, d, w, h, B) {
        const bl = this.borderBlocks(w, h, B), stride = Math.floor(bl.length / 3), LV = [16, 80, 176, 240];
        const bits = []; for (const b of bs) for (let i = 7; i >= 0; i--) bits.push(b >> i & 1);
        while (bits.length % 2) bits.push(0);
        const qs = []; for (let i = 0; i < bits.length; i += 2) qs.push(bits[i] * 2 + bits[i + 1]);
        if (qs.length > stride) return false;
        for (let rep = 0; rep < 3; rep++) for (let i = 0; i < qs.length; i++) {
            const b2 = bl[rep * stride + i], v = LV[qs[i]];
            for (let y = 0; y < 8; y++) for (let l = 0; l < 8; l++) { const f = ((b2.y + y) * w + (b2.x + l)) * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; }
        }
        return true;
    },
    rMetaJpeg(d, w, h, B) {
        const bl = this.borderBlocks(w, h, B), stride = Math.floor(bl.length / 3), LV = [16, 80, 176, 240], vals = [];
        for (const b2 of bl) { let s = 0; for (let y = 0; y < 8; y++) for (let l = 0; l < 8; l++) s += d[((b2.y + y) * w + (b2.x + l)) * 4]; vals.push(Math.round(s / 64)); }
        const qs = [];
        for (let i = 0; i < stride; i++) {
            const mean = (vals[i] + vals[i + stride] + vals[i + 2 * stride]) / 3;
            let q = 0, bd = 1e9; for (let j = 0; j < 4; j++) { const dd = Math.abs(mean - LV[j]); if (dd < bd) { bd = dd; q = j; } }
            qs.push(q);
        }
        const bytes = []; for (let i = 0; i < qs.length; i += 4) { let b = 0; for (let j = 0; j < 4; j++) b = b * 4 + (qs[i + j] || 0); bytes.push(b); }
        return bytes;
    },
    /* J2 拍屏鲁棒码委托（实现体在顶部 J2 对象）：Finder 定位 + 单应校正 + RS 环带解码 */
    readRing(d, cw, ch) { return J2.readRing(d, cw, ch); },
    /* 解析字节流 → {cnt, regions, stored, flag, dataLen}，魔数不对返回 null */
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
    /* ===== V3-J 鲁棒 JPEG 边框码 =====
       B=48px：外圈 5 模块(8px)为数据/格式，最内 1 模块环为时序定位条(棋盘格)。
       数据：RS(255,179) 30%纠错，GF(256)；双副本(容量足时)；环形模块地图。
       几何：时序条测 X/Y 独立缩放与平移 → 抗 裁切/放大/拉伸；二次压缩由 4 级亮度+RS 吸收。 */
    metaBytesR(cw, ch, count, regions, k, flag, dataLen) {
        const bs = [cw >> 8 & 255, cw & 255, ch >> 8 & 255, ch & 255, count];
        for (const r of regions) bs.push(r.x >> 8 & 255, r.x & 255, r.y >> 8 & 255, r.y & 255, r.w >> 8 & 255, r.w & 255, r.h >> 8 & 255, r.h & 255);
        bs.push(67, 88); // "CX"
        const sig = (this.hash('V3|' + count + '|' + regions.map(r => r.x + ',' + r.y + ',' + r.w + ',' + r.h).join('&') + '|' + k) >>> 0) & 0xFFFFFF;
        bs.push(sig >> 16 & 255, sig >> 8 & 255, sig & 255);
        bs.push(flag & 255, dataLen >>> 24 & 255, dataLen >>> 16 & 255, dataLen >>> 8 & 255, dataLen & 255);
        return bs;
    },
    parseMetaR(bs) {
        if (!bs || bs.length < 10) return null;
        const cw = bs[0] * 256 + bs[1], ch = bs[2] * 256 + bs[3], cnt = bs[4];
        if (cnt < 1 || cnt > 12) return null;
        if (bs[5 + cnt * 8] !== 67 || bs[6 + cnt * 8] !== 88) return null;
        const regions = [];
        for (let i = 0; i < cnt; i++) { const o = 5 + i * 8; regions.push({ x: bs[o] * 256 + bs[o + 1], y: bs[o + 2] * 256 + bs[o + 3], w: bs[o + 4] * 256 + bs[o + 5], h: bs[o + 6] * 256 + bs[o + 7] }); }
        const so = 5 + cnt * 8 + 2;
        const stored = (bs[so] << 16) | (bs[so + 1] << 8) | bs[so + 2];
        const flag = bs[so + 3] & 255, dataLen = bs.length > so + 7 ? (bs[so + 4] << 24 | bs[so + 5] << 16 | bs[so + 6] << 8 | bs[so + 7]) : 0;
        return { cw, ch, cnt, regions, stored, flag, dataLen };
    },
    /* 环形数据模块地图（原画布坐标系；顶部 y=0 行前 24 模块为格式区，跳过） */
    jpegMods(cw, ch) {
        const mods = [], wm = cw >> 3, hm = ch >> 3;
        for (let r = 0; r < 5; r++) for (let c = 6; c <= wm - 7; c++) { if ((r === 0 || r === 4) && c < 30) continue; mods.push({ x: c * 8, y: r * 8 }); }              // 顶（y=0/32 行前 24 模块为格式区，跳过）
        for (let d = 0; d < 5; d++) for (let r = 1; r <= hm - 7; r++) mods.push({ x: cw - 8 - d * 8, y: r * 8 });                                     // 右
        for (let d = 0; d < 5; d++) for (let c = wm - 7; c >= 6; c--) { if ((d === 0 || d === 4) && c < 30) continue; mods.push({ x: c * 8, y: ch - 8 - d * 8 }); }                                    // 底（y=ch-8/ch-40 行前 24 模块为格式副本，跳过）
        for (let d = 0; d < 5; d++) for (let r = hm - 7; r >= 1; r--) mods.push({ x: d * 8, y: r * 8 });                                            // 左
        return mods;
    },
    jpegFormat(y0) { const y = y0 === undefined ? 32 : y0; const fs2 = []; for (let k = 0; k < 24; k++) fs2.push({ x: 48 + k * 8, y }); return fs2; }, // 格式区：顶 y=32 行（抗≤32px裁切），24 模块（6 字节）
    /* 写时序环 + 格式 + RS 双副本数据（直接改 d.data）。返回是否容量充足 */
    writeRobust(d, cw, ch, payload, _len) {
        if (payload.length > 127) return false;
        const mods = this.jpegMods(cw, ch);
        if (mods.length < 1020) return false;
        const LV = [16, 80, 176, 240];
        // 1) 时序定位环（最内 8px 环：水平条= x 奇偶，垂直条= y 奇偶，相位固定于原点）
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            const hb = (y >= 40 && y < 48) || (y >= ch - 48 && y < ch - 40);
            const vb = (x >= 40 && x < 48) || (x >= cw - 48 && x < cw - 40);
            if (hb || vb) { const v = (hb ? ((x >> 3) & 1) : ((y >> 3) & 1)) ? 255 : 0, f = (y * cw + x) * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; }
        }
        // 2) 格式区：'R3' + 画布宽高（6 字节；顶 y=32 与底 ch-40 双份，避开最外行以抗裁切）
        const fmtB = [82, 51, cw >> 8 & 255, cw & 255, ch >> 8 & 255, ch & 255];
        const putFmtRow = (y0) => { const fs2 = this.jpegFormat(y0); for (let b = 0; b < fmtB.length; b++) for (let k = 0; k < 4; k++) { const m = fs2[b * 4 + k], idx = (fmtB[b] >> (6 - 2 * k)) & 3, v = LV[idx]; for (let yy = y0; yy < y0 + 8; yy++) for (let xx = m.x; xx < m.x + 8; xx++) { const f = (yy * cw + xx) * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; } } };
        putFmtRow(32);
        if (ch >= 96) putFmtRow(ch - 40);
        // 3) RS 编码 → 环形双副本（k=127：50% ECC，t=64，抗裁切/二次压缩更强）
        const p1 = new Uint8Array(127); p1.set(payload, 0);
        const cw1 = RS255.encode(p1, 128);
        const putBytes = (bytes, start) => {
            let mi = start;
            for (let j = 0; j < bytes.length; j++) for (let k = 0; k < 4; k++) {
                if (mi >= mods.length) return false;
                const m = mods[mi++], idx = (bytes[j] >> (6 - 2 * k)) & 3, v = LV[idx];
                for (let yy = m.y; yy < m.y + 8; yy++) for (let xx = m.x; xx < m.x + 8; xx++) { const f = (yy * cw + xx) * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; }
            }
            return true;
        };
        if (!putBytes(cw1, 0)) return false;
        let used = 1020;
        if (mods.length >= 2040) { if (!putBytes(cw1, 1020)) return false; used = 2040; }
        // 4) 剩余填充（装饰性模式）
        for (let i = used; i < mods.length; i++) { const m = mods[i], v = LV[(i * 7 + 5) & 3]; for (let yy = m.y; yy < m.y + 8; yy++) for (let xx = m.x; xx < m.x + 8; xx++) { const f = (yy * cw + xx) * 4; d[f] = v; d[f + 1] = v; d[f + 2] = v; d[f + 3] = 255; } }
        return true;
    },
    /* 时序条检测 → {sx, sy, tx:[候选], ty:[候选]} 或 null */
    jpegGeo(d, cw, ch) {
        const lum = new Uint8Array(cw * ch);
        for (let i = 0; i < lum.length; i++) lum[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
        const stripH = (y0, y1) => {
            let best = 0, by = -1;
            for (let y = y0; y < y1; y++) { let trans = 0, prev = -1; const o = y * cw; for (let x = 0; x < cw; x++) { const v = lum[o + x]; if (prev >= 0 && Math.abs(v - prev) > 120) trans++; prev = v; } if (trans > best) { best = trans; by = y; } }
            if (best < 4 || by < 0) return null;
            // 分数过零点（线性插值的 128 阈值穿越点）→ 精确测 pitch 与首黑
            const o = by * cw, cr = [];
            for (let x = 0; x < cw - 1; x++) { const a = lum[o + x], b2 = lum[o + x + 1]; if ((a < 128) !== (b2 < 128)) cr.push(x + (128 - a) / (b2 - a)); }
            if (cr.length < 4) return null;
            const difs = []; for (let i = 1; i < cr.length; i++) difs.push(cr[i] - cr[i - 1]);
            difs.sort((a, b2) => a - b2);
            const md = difs[difs.length >> 1];
            if (md < 2 || md > 40) return null;
            let s = 0, n = 0;
            for (const d2 of difs) if (Math.abs(d2 - md) <= md * 0.45) { s += d2; n++; }
            const p = n ? s / n : md;
            const firstDark = lum[o] < 128 ? 0 : cr[0];
            return { pitch: p, first: firstDark, y: by };
        };
        const stripV = (x0, x1) => {
            let best = 0, bx = -1;
            for (let x = x0; x < x1; x++) { let trans = 0, prev = -1; for (let y = 0; y < ch; y++) { const v = lum[y * cw + x]; if (prev >= 0 && Math.abs(v - prev) > 120) trans++; prev = v; } if (trans > best) { best = trans; bx = x; } }
            if (best < 4 || bx < 0) return null;
            const cr = [];
            for (let y = 0; y < ch - 1; y++) { const a = lum[y * cw + bx], b2 = lum[(y + 1) * cw + bx]; if ((a < 128) !== (b2 < 128)) cr.push(y + (128 - a) / (b2 - a)); }
            if (cr.length < 4) return null;
            const difs = []; for (let i = 1; i < cr.length; i++) difs.push(cr[i] - cr[i - 1]);
            difs.sort((a, b2) => a - b2);
            const md = difs[difs.length >> 1];
            if (md < 2 || md > 40) return null;
            let s = 0, n = 0;
            for (const d2 of difs) if (Math.abs(d2 - md) <= md * 0.45) { s += d2; n++; }
            const p = n ? s / n : md;
            const firstDark = lum[bx] < 128 ? 0 : cr[0];
            return { pitch: p, first: firstDark, x: bx };
        };
        const top = stripH(0, Math.min(768, ch)), bot = stripH(Math.max(0, ch - 768), ch);
        const left = stripV(0, Math.min(768, cw)), right = stripV(Math.max(0, cw - 768), cw);
        if (!top && !bot) return null;
        let sx = 0, sy = 0;
        if (top && bot) sx = ((top.pitch + bot.pitch) / 2) / 8; else sx = ((top || bot).pitch) / 8;
        if (left && right) sy = ((left.pitch + right.pitch) / 2) / 8; else if (left || right) sy = ((left || right).pitch) / 8;
        if (!sy) sy = sx; // 单轴缺失时借用另一轴（保守）
        if (sx < 0.4 || sx > 4 || sy < 0.4 || sy > 4) return null;
        const tx = [], ty = [];
        if (top) for (let i = 0; i < 5; i++) tx.push(top.first - 2 * top.pitch * i);
        if (bot) for (let i = 0; i < 5; i++) tx.push(bot.first - 2 * bot.pitch * i);
        if (!tx.length) return null;
        if (left) for (let i = 0; i < 5; i++) ty.push(left.first - 2 * left.pitch * i);
        if (right) for (let i = 0; i < 5; i++) ty.push(right.first - 2 * right.pitch * i);
        if (!ty.length) ty.push(0);
        return { sx, sy, tx, ty };
    },
    /* 窗口内按最接近亮度级投票（众数，抑制缩小混叠；平票回退窗口均值最近级）→ {q 级别, n 像素数} */
    levelPoll(d, cw, ch, cx, cy, hx, hy) {
        const LV = [16, 80, 176, 240];
        const x0 = Math.max(0, Math.floor(cx - hx)), x1 = Math.min(cw, Math.ceil(cx + hx));
        const y0 = Math.max(0, Math.floor(cy - hy)), y1 = Math.min(ch, Math.ceil(cy + hy));
        let acc = 0, n = 0, votes = [0, 0, 0, 0];
        for (let y = y0; y < y1; y++) {
            const o = y * cw;
            for (let x = x0; x < x1; x++) {
                const v = d[(o + x) * 4];
                let qv = 0, bd = 1e9;
                for (let j = 0; j < 4; j++) { const dd = Math.abs(v - LV[j]); if (dd < bd) { bd = dd; qv = j; } }
                votes[qv]++; acc += v; n++;
            }
        }
        if (!n) return { q: 0, n: 0 };
        let q = 0;
        for (let j = 1; j < 4; j++) if (votes[j] > votes[q]) q = j;
        let occ = 0; for (let j = 0; j < 4; j++) if (votes[j] === votes[q]) occ++;
        if (occ > 1) { // 平票 → 均值最近级兜底
            const mean = acc / n; q = 0; let bd = 1e9;
            for (let j = 0; j < 4; j++) { const dd = Math.abs(mean - LV[j]); if (dd < bd) { bd = dd; q = j; } }
        }
        return { q, n };
    },
    sampleJpeg(d, cw, ch, mods, sx, sy, tx, ty) {
        const nMod = mods.length, out = new Uint8Array(Math.ceil(nMod / 4)), eras = new Set();
        const hx = Math.max(1, Math.round(3 * sx)), hy = Math.max(1, Math.round(3 * sy));
        for (let mi = 0; mi < nMod; mi++) {
            const m = mods[mi], cx = sx * (m.x + 4) + tx, cy = sy * (m.y + 4) + ty;
            const r = this.levelPoll(d, cw, ch, cx, cy, hx, hy);
            if (!r.n) eras.add(mi >> 2); // 模块完全被裁切 → 该字节标记为擦除
            out[mi >> 2] |= r.q << (6 - 2 * (mi & 3));
        }
        return { bytes: out, eras: Array.from(eras) };
    },
    /* 鲁棒读取：几何 → 格式 → RS 双副本尝试（含平移候选组合与擦除）→ {payload, geo, w0, h0} 或 null */
    readRobustJpeg(d, cw, ch) {
        const geo = this.jpegGeo(d, cw, ch);
        if (!geo) return null;
        const readFmtRow = (tx, ty, y0) => {
            const fs2 = this.jpegFormat(y0), vals = [];
            for (let b = 0; b < 6; b++) {
                let Bv = 0;
                for (let k = 0; k < 4; k++) { const m = fs2[b * 4 + k]; const cx = geo.sx * (m.x + 4) + tx, cy = geo.sy * (y0 + 4) + ty; const r = this.levelPoll(d, cw, ch, cx, cy, Math.max(1, Math.round(3 * geo.sx)), Math.max(1, Math.round(3 * geo.sy))); if (!r.n) return null; Bv |= r.q << (6 - 2 * k); }
                vals.push(Bv);
            }
            return vals;
        };
        const fmtTry = (tx, ty) => {
            let fb = readFmtRow(tx, ty, 32);
            if (fb && fb[0] !== 82) fb = ch >= 96 ? readFmtRow(tx, ty, ch - 40) : null;
            if (!fb || fb[1] !== 51) return null;
            const w0 = fb[2] * 256 + fb[3], h0 = fb[4] * 256 + fb[5];
            if (w0 < 96 || h0 < 96 || w0 > 40000 || h0 > 40000) return null;
            const mods = this.jpegMods(w0, h0);
            const sm = this.sampleJpeg(d, cw, ch, mods, geo.sx, geo.sy, tx, ty);
            const bytes = sm.bytes, eras = sm.eras;
            let rs = null;
            if (bytes.length >= 255) rs = RS255.decode(bytes.slice(0, 255), 128, eras.filter(e2 => e2 < 255));
            if (!rs && bytes.length >= 510) rs = RS255.decode(bytes.slice(255, 510), 128, eras.filter(e2 => e2 >= 255 && e2 < 510).map(e2 => e2 - 255));
            if (rs && this.parseMetaR(rs)) return { payload: rs, geo: { sx: geo.sx, sy: geo.sy, tx, ty }, w0, h0 };
            return null;
        };
        // 候选顺序：几何启发（无留白快速路径）→ 3px 网格扫描（覆盖截图页面留白/偏移≤384px，命中魔数后停止）
        for (const tx of geo.tx) for (const ty of geo.ty) { const r = fmtTry(tx, ty); if (r) return r; }
        for (let ty = 0; ty <= 384; ty += 3) for (let tx = 0; tx <= 384; tx += 3) { const r = fmtTry(tx, ty); if (r) return r; }
        return null;
    },
    /* 按几何把接收图重采样回原尺寸画布（近恒等=精确拷贝，非整数缩放=双线性），供区域逆变换 */
    robustReconstruct(d, cw, ch, w0, h0, geo) {
        const iw = Math.max(1, w0 - 96), ih = Math.max(1, h0 - 96);
        const c2 = document.createElement('canvas'); c2.width = iw; c2.height = ih;
        const x2 = c2.getContext('2d'), id = x2.createImageData(iw, ih), sd = id.data;
        const xi = Math.round(geo.tx), yi = Math.round(geo.ty);
        const nearId = Math.abs(geo.sx - 1) < 0.02 && Math.abs(geo.sy - 1) < 0.02 && Math.abs(geo.tx - xi) < 0.4 && Math.abs(geo.ty - yi) < 0.4;
        if (nearId) {
            // 精确拷贝：整像素直取，避免双线性把区域外的加密乱码渗入区域边界形成 1px 环
            for (let y = 0; y < ih; y++) for (let l = 0; l < iw; l++) {
                const rx = l + 48 + xi, ry = y + 48 + yi, f = (y * iw + l) * 4;
                if (rx >= 0 && ry >= 0 && rx < cw && ry < ch) {
                    const s = (ry * cw + rx) * 4;
                    sd[f] = d[s]; sd[f + 1] = d[s + 1]; sd[f + 2] = d[s + 2]; sd[f + 3] = 255;
                } else { sd[f] = 0; sd[f + 1] = 0; sd[f + 2] = 0; sd[f + 3] = 255; }
            }
            x2.putImageData(id, 0, 0);
            return c2;
        }
        const bi = (ox, oy) => {
            // 最近邻重采样：几何(相位)已亚像素级准确，直接取单一源像素，
            // 避免双线性把相邻乱码块混合 → 消除"每个格子一圈乱码边"
            const gx = Math.round(geo.sx * ox + geo.tx), gy = Math.round(geo.sy * oy + geo.ty);
            if (gx < 0 || gy < 0 || gx >= cw || gy >= ch) return [0, 0, 0];
            const s = (gy * cw + gx) * 4;
            return [d[s], d[s + 1], d[s + 2]];
        };
        for (let y = 0; y < ih; y++) for (let l = 0; l < iw; l++) {
            const c3 = bi(48 + l + 0.5, 48 + y + 0.5), f = (y * iw + l) * 4;
            sd[f] = Math.max(0, Math.min(255, c3[0])); sd[f + 1] = Math.max(0, Math.min(255, c3[1])); sd[f + 2] = Math.max(0, Math.min(255, c3[2])); sd[f + 3] = 255;
        }
        x2.putImageData(id, 0, 0);
        return c2;
    },
    /* 区域边界清理：对齐盒(8px对齐)外扩 band 的环带(含4px对齐边距)用盒外 ref 像素外延替换，
   消除 JPEG 压缩残留在边界的噪声带/振铃；随后对选框内缘 1px 做均化，去掉暗色镶边 */
    jpegBandClean(d, w, h, regions, band) {
        band = band || 2;
        const ref = band + 2;
        for (const r of regions) {
            const ax0 = Math.max(0, Math.floor(r.x / 8) * 8), ay0 = Math.max(0, Math.floor(r.y / 8) * 8);
            const ax1 = Math.min(w, Math.ceil((r.x + r.w) / 8) * 8), ay1 = Math.min(h, Math.ceil((r.y + r.h) / 8) * 8);
            const yA = Math.max(0, ay0 - band), yB = Math.min(h, ay1 + band);
            const xA = Math.max(0, ax0 - band), xB = Math.min(w, ax1 + band);
            // 左带 [xA, r.x)
            for (let x = xA; x < r.x; x++) { const s8 = Math.max(0, ax0 - ref); for (let y = yA; y < yB; y++) { const f = (y * w + x) * 4, s = (y * w + s8) * 4; d[f] = d[s]; d[f + 1] = d[s + 1]; d[f + 2] = d[s + 2]; } }
            // 右带 [r.x+r.w, xB)
            for (let x = Math.min(w, r.x + r.w); x < xB; x++) { const s8 = Math.min(w - 1, ax1 + ref - 1); for (let y = yA; y < yB; y++) { const f = (y * w + x) * 4, s = (y * w + s8) * 4; d[f] = d[s]; d[f + 1] = d[s + 1]; d[f + 2] = d[s + 2]; } }
            // 上带 [yA, r.y)
            for (let y = yA; y < r.y; y++) { const s8 = Math.max(0, ay0 - ref); for (let x = xA; x < xB; x++) { const f = (y * w + x) * 4, s = (s8 * w + x) * 4; d[f] = d[s]; d[f + 1] = d[s + 1]; d[f + 2] = d[s + 2]; } }
            // 下带 [r.y+r.h, yB)
            for (let y = Math.min(h, r.y + r.h); y < yB; y++) { const s8 = Math.min(h - 1, ay1 + ref - 1); for (let x = xA; x < xB; x++) { const f = (y * w + x) * 4, s = (s8 * w + x) * 4; d[f] = d[s]; d[f + 1] = d[s + 1]; d[f + 2] = d[s + 2]; } }
            // 注：曾有的"选框内缘 1px 均化"已移除——实测截图/分数几何下它把选框边缘
            // 像素向内错位采样，重采样误差放大后形成一圈明显边框(内缘PSNR 22→14dB)；
            // 外带延展已足够覆盖 JPEG 残留噪声带，内缘交给内容本身。
        }
    },
    /* JPEG 块效应去块：区域内每条内部 8×8 块界线做 6 像素斜坡平滑。
       强度按接缝亮度跳变自适应：|Δ|≤24 → 全修(块噪声)；24<|Δ|≤72 → 按 1-|Δ|/96
       比例减弱；>72 → 视为真实内容边缘跳过(不洗掉文字/图形边界)。
       宽度 6px(比旧 4px 更宽，覆盖 60% JPEG 低质量下的块色差宽度)。
       另含选框内缘 1px 修复：边缘像素与内侧 2px 颜色差>阈值(28)时，
       边缘←内侧2px（消除低质量JPEG下选框最外1px的块量化破坏带）。 */
    jpegDeblock(d, w, h, regions) {
        for (const r of regions) {
            const x0 = Math.max(0, Math.floor(r.x / 8) * 8), y0 = Math.max(0, Math.floor(r.y / 8) * 8);
            const x1 = Math.min(w, Math.ceil((r.x + r.w) / 8) * 8), y1 = Math.min(h, Math.ceil((r.y + r.h) / 8) * 8);
            // 选框内缘 1px 修复（阈值自适应，只修 JPEG 量化破坏的边缘）
            const ET = 28, ef = (xa, ya, xb, yb, odx, ody) => {
                for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
                    const f = (y * w + x) * 4, s = ((y + ody) * w + (x + odx)) * 4;
                    if (f < 0 || s < 0 || f + 2 >= d.length || s + 2 >= d.length) continue;
                    if (Math.abs(d[f] - d[s]) + Math.abs(d[f + 1] - d[s + 1]) + Math.abs(d[f + 2] - d[s + 2]) > ET) {
                        d[f] = d[s]; d[f + 1] = d[s + 1]; d[f + 2] = d[s + 2];
                    }
                }
            };
            ef(r.x, r.y, Math.min(w, r.x + 1), Math.min(h, r.y + r.h), 2, 0);
            ef(Math.max(0, r.x + r.w - 1), r.y, Math.min(w, r.x + r.w), Math.min(h, r.y + r.h), -2, 0);
            ef(r.x, r.y, Math.min(w, r.x + r.w), Math.min(h, r.y + 1), 0, 2);
            ef(r.x, Math.max(0, r.y + r.h - 1), Math.min(w, r.x + r.w), Math.min(h, r.y + r.h), 0, -2);
            if (x1 - x0 < 16 || y1 - y0 < 16) continue;
            const rampV = (x) => {
                for (let y = y0; y < y1; y++) {
                    const f0 = (y * w + x - 1) * 4, f1 = (y * w + x) * 4;
                    const jm = Math.abs(d[f0] - d[f1]) + Math.abs(d[f0 + 1] - d[f1 + 1]) + Math.abs(d[f0 + 2] - d[f1 + 2]) / 1;
                    const ad = (Math.abs(d[f0] - d[f1]) + Math.abs(d[f0 + 1] - d[f1 + 1]) + Math.abs(d[f0 + 2] - d[f1 + 2])) / 3;
                    if (ad > 72) continue;         // 真实强边缘，不修
                    const wm = ad <= 24 ? 1 : Math.max(0, 1 - (ad - 24) / 72); // 自适应力度
                    for (let c2 = 0; c2 < 3; c2++) {
                        const p0 = d[f0 + c2], p1 = d[f1 + c2], diff = p1 - p0;
                        const f2 = (y * w + x - 2) * 4, f3 = (y * w + x + 1) * 4;
                        const f4 = (y * w + x - 3) * 4, f5 = (y * w + x + 2) * 4;
                        d[f4 + c2] = Math.max(0, Math.min(255, d[f4 + c2] + ((diff >> 3) * wm | 0)));
                        d[f2 + c2] = Math.max(0, Math.min(255, d[f2 + c2] + ((diff * 3 / 8 * wm) | 0)));
                        d[f0 + c2] = Math.max(0, Math.min(255, p0 + ((diff * 5 / 8 * wm) | 0)));
                        d[f1 + c2] = Math.max(0, Math.min(255, p1 - ((diff * 5 / 8 * wm) | 0)));
                        d[f3 + c2] = Math.max(0, Math.min(255, d[f3 + c2] - ((diff * 3 / 8 * wm) | 0)));
                        d[f5 + c2] = Math.max(0, Math.min(255, d[f5 + c2] - ((diff >> 3) * wm | 0)));
                    }
                }
            };
            const rampH = (y) => {
                for (let x = x0; x < x1; x++) {
                    const f0 = ((y - 1) * w + x) * 4, f1 = (y * w + x) * 4;
                    const ad = (Math.abs(d[f0] - d[f1]) + Math.abs(d[f0 + 1] - d[f1 + 1]) + Math.abs(d[f0 + 2] - d[f1 + 2])) / 3;
                    if (ad > 72) continue;
                    const wm = ad <= 24 ? 1 : Math.max(0, 1 - (ad - 24) / 72);
                    for (let c2 = 0; c2 < 3; c2++) {
                        const p0 = d[f0 + c2], p1 = d[f1 + c2], diff = p1 - p0;
                        const f2 = ((y - 2) * w + x) * 4, f3 = ((y + 1) * w + x) * 4;
                        const f4 = ((y - 3) * w + x) * 4, f5 = ((y + 2) * w + x) * 4;
                        d[f4 + c2] = Math.max(0, Math.min(255, d[f4 + c2] + ((diff >> 3) * wm | 0)));
                        d[f2 + c2] = Math.max(0, Math.min(255, d[f2 + c2] + ((diff * 3 / 8 * wm) | 0)));
                        d[f0 + c2] = Math.max(0, Math.min(255, p0 + ((diff * 5 / 8 * wm) | 0)));
                        d[f1 + c2] = Math.max(0, Math.min(255, p1 - ((diff * 5 / 8 * wm) | 0)));
                        d[f3 + c2] = Math.max(0, Math.min(255, d[f3 + c2] - ((diff * 3 / 8 * wm) | 0)));
                        d[f5 + c2] = Math.max(0, Math.min(255, d[f5 + c2] - ((diff >> 3) * wm | 0)));
                    }
                }
            };
            for (let x = x0 + 8; x < x1; x += 8) rampV(x);
            for (let y = y0 + 8; y < y1; y += 8) rampH(y);
        }
    },
    /* 块 DC 中位数均衡（单遍、3×3 邻域中位数参考、钳制±28）：
       对每个 8×8 块，用 3×3 邻域块均值的【中位数】作参考——中位数对单个异常块/真实
       梯度边缘稳健，不会把邻近的真实明暗差当成噪声拉平。
       修正量 = clamp(邻域中位 - 块均值)。离散度(邻域 MAD)大时收敛修正量，
       离散度小(邻域一致)时大胆修正——只压"整块偏离邻居"的 JPEG DC 噪声，
       保留真实内容梯度(渐变/光照/文字)。实测：旧全量均衡洗平对比=雾(PSNR 21→13)，
       本版钳制+中位数可在不雾化的前提下显著压掉 8×8 块 DC 色差。 */
    jpegDcEqualize(d, w, h, regions) {
        for (const r of regions) {
            const x0 = Math.max(0, Math.floor(r.x / 8) * 8), y0 = Math.max(0, Math.floor(r.y / 8) * 8);
            const x1 = Math.min(w, Math.ceil((r.x + r.w) / 8) * 8), y1 = Math.min(h, Math.ceil((r.y + r.h) / 8) * 8);
            const cols = (x1 - x0) >> 3, rows = (y1 - y0) >> 3;
            if (rows < 5 || cols < 5) continue;
            const means = new Array(rows);
            for (let br = 0; br < rows; br++) {
                means[br] = new Array(cols);
                for (let bc = 0; bc < cols; bc++) {
                    let s0 = 0, s1 = 0, s2 = 0;
                    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                        const f = ((y0 + br * 8 + y) * w + (x0 + bc * 8 + x)) * 4;
                        s0 += d[f]; s1 += d[f + 1]; s2 += d[f + 2];
                    }
                    means[br][bc] = [s0 / 64, s1 / 64, s2 / 64];
                }
            }
            const sortN = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
            const fix = new Array(rows);
            for (let br = 0; br < rows; br++) {
                fix[br] = new Array(cols);
                for (let bc = 0; bc < cols; bc++) {
                    const lums = [], ns = [];
                    const neigh = [];
                    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                        const nr = br + dr, nc = bc + dc;
                        if (nr === br && nc === bc) continue;
                        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                            const m = means[nr][nc];
                            neigh.push(m);
                            lums.push(0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]);
                            ns.push(0.299 * means[br][bc][0] + 0.587 * means[br][bc][1] + 0.114 * means[br][bc][2]);
                        }
                    }
                    if (!neigh.length) { fix[br][bc] = null; continue; }
                    // 邻域离散度：亮度 MAD（中位数绝对偏差）——邻域一致→0，梯度大→大
                    const medL = sortN(lums);
                    let mad = 0; for (const L of lums) mad += Math.abs(L - medL);
                    mad /= lums.length;
                    // 修正幅度：离散度大→只修小部分(真实梯度)，离散度小→大胆修(块噪声)
                    const gain = Math.max(0.08, 0.95 - mad / 100); // MAD 0→0.95(平坦全修), MAD 80→0.15(梯度少修)
                    const med0 = sortN(neigh.map(m => m[0]));
                    const med1 = sortN(neigh.map(m => m[1]));
                    const med2 = sortN(neigh.map(m => m[2]));
                    // 无钳制，直接按 gain 比例修正：
                    // gain 高(平坦区,邻域一致) → 修正幅度大(修块噪声)
                    // gain 低(梯度区,邻域离散) → 修正幅度小(保留内容)
                    fix[br][bc] = [gain * (med0 - means[br][bc][0]), gain * (med1 - means[br][bc][1]), gain * (med2 - means[br][bc][2])];
                }
            }
            for (let br = 0; br < rows; br++) for (let bc = 0; bc < cols; bc++) {
                const f2 = fix[br][bc]; if (!f2 || (!f2[0] && !f2[1] && !f2[2])) continue;
                for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                    const f = ((y0 + br * 8 + y) * w + (x0 + bc * 8 + x)) * 4;
                    d[f] = Math.max(0, Math.min(255, d[f] + f2[0])); d[f + 1] = Math.max(0, Math.min(255, d[f + 1] + f2[1])); d[f + 2] = Math.max(0, Math.min(255, d[f + 2] + f2[2]));
                }
            }
        }
    },
    /* 区域内 5×5 中值平滑：抹平 JPEG 逐块量化造成的"每块一个色调"马赛克贴片感（保留文字等边缘） */
    jpegRegionSmooth(d, w, h, regions) {
        for (const r of regions) {
            const x0 = Math.max(0, Math.floor(r.x / 8) * 8), y0 = Math.max(0, Math.floor(r.y / 8) * 8);
            const x1 = Math.min(w, Math.ceil((r.x + r.w) / 8) * 8), y1 = Math.min(h, Math.ceil((r.y + r.h) / 8) * 8);
            const bw = x1 - x0, bh = y1 - y0;
            if (bw < 10 || bh < 10) continue;
            const tmp = new Uint8ClampedArray(bw * bh * 4);
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const fi = ((y0 + y) * w + (x0 + x)) * 4, ti = (y * bw + x) * 4;
                tmp[ti] = d[fi]; tmp[ti + 1] = d[fi + 1]; tmp[ti + 2] = d[fi + 2];
            }
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const r0 = [], g0 = [], b0 = [];
                for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
                    const px = x + xx, py = y + yy;
                    if (px < 0 || py < 0 || px >= bw || py >= bh) continue;
                    const ti = (py * bw + px) * 4;
                    r0.push(tmp[ti]); g0.push(tmp[ti + 1]); b0.push(tmp[ti + 2]);
                }
                r0.sort((a, b2) => a - b2); g0.sort((a, b2) => a - b2); b0.sort((a, b2) => a - b2);
                const fi = ((y0 + y) * w + (x0 + x)) * 4;
                d[fi] = r0[r0.length >> 1]; d[fi + 1] = g0[g0.length >> 1]; d[fi + 2] = b0[b0.length >> 1];
            }
        }
    },
    /* 加密：外扩画布，原图居中，边框存元数据；解密：读边框→校验→还原→裁剪回原尺寸 */
    pV3(img, k, t) {
        const c = $('cvs'), x = c.getContext('2d');
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (w * h > 45000000) { T("图片过大"); return; }
        const E = t === 'e', B = E ? this.bW() : 0;
        // 前置缩放（仅加密）：按 sv3 比例缩小原图，减小输出体积与诱饵容量占用
        let scale = 1;
        if (E && w && h) {
            const s = parseInt($('sv3').value) / 100;
            if (s > 0 && s < 1) { scale = s; w = Math.max(8, Math.floor(w * s)); h = Math.max(8, Math.floor(h * s)); }
        }
        // 加密：外扩边框；解密：加密图本身含边框，直接采用其尺寸
        const cw = E ? w + B * 2 : w, ch = E ? h + B * 2 : h;
        c.width = cw; c.height = ch;
        // 边框背景：将原图四条边缘向外拉伸，边框视觉上自然延续图片色彩
        if (E) {
            x.drawImage(img, 0, 0, w, 1, 0, 0, cw, B);       // 上
            x.drawImage(img, 0, h - 1, w, 1, 0, ch - B, cw, B); // 下
            x.drawImage(img, 0, 0, 1, h, 0, B, B, ch - B * 2);  // 左
            x.drawImage(img, w - 1, 0, 1, h, cw - B, B, B, ch - B * 2); // 右
            x.drawImage(img, B, B, w, h);                     // 原图居中
        } else {
            x.drawImage(img, 0, 0, w, h);
        }
        const d = x.getImageData(0, 0, cw, ch);
        if (E) {
            let regions = MOB.regions.slice();
            if (!regions.length) return T("请先框选要打码的区域");
            // 区域坐标换算到缩放后：必须与图像尺寸 Math.floor(w*s) 同取整规则，
            // 且钳制不超出缩放后图像边界（否则全图打码时区域比图大 1px → 逆变换越界/整体错位乱码）
            if (scale !== 1) regions = regions.map(r => {
                const rx = Math.max(0, Math.min(Math.floor(r.x * scale), w - 1));
                const ry = Math.max(0, Math.min(Math.floor(r.y * scale), h - 1));
                const rw = Math.max(1, Math.min(Math.floor(r.w * scale), w - rx));
                const rh = Math.max(1, Math.min(Math.floor(r.h * scale), h - ry));
                return { x: rx, y: ry, w: rw, h: rh };
            });
            const jpeg = parseInt($('qv3').value) < 100;
            // J2（JPEG 鲁棒）用 16px 置换单元——单元在拍屏照片中可分辨、块定位更稳；
            // PNG 保持 8px 逐位不变。
            const unit = jpeg ? 16 : 8;
            // 关键：区域与缩放后图像边界做 unit 对齐（ceil 到完整块）后再写入元数据。
            // 加密传 {x:reg.x+B} 给 regionEnc 时块数必须与解密端 {x:reg.x} 一致
            // （B=8/64 均整除 unit，块网格同源）；否则加密 ceil 到块、解密 floor 到块
            // → 块数不同 → 置换表不同 → 全图乱码。
            regions = regions.map(r => {
                const rx2 = Math.floor(r.x / unit) * unit;
                const ry2 = Math.floor(r.y / unit) * unit;
                // 右下边界也要回落完整单元：w-rx2 不够倍数时截断到倍数
                const rw2 = Math.max(0, Math.floor((Math.min(w - rx2, Math.ceil(r.w / unit) * unit)) / unit) * unit);
                const rh2 = Math.max(0, Math.floor((Math.min(h - ry2, Math.ceil(r.h / unit) * unit)) / unit) * unit);
                return { x: rx2, y: ry2, w: rw2, h: rh2 };
            });
            const decoy = !jpeg && MOB.decoyOn && MOB.decoyImg;
            const sort = !jpeg && !decoy && MOB.sortOn;
            if (MOB.decoyOn && !MOB.decoyImg) { T("请先选择诱饵图"); return; }
            if (jpeg) { T("诱饵图/色块排序仅支持 PNG 输出，当前已自动忽略"); }
            // 区域加密（含排序）——诱饵模式跳过：数据将按原字节存入 LSB
            if (!decoy) regions.forEach((reg, idx) => this.regionEnc(d.data, cw, ch, { ...reg, x: reg.x + B, y: reg.y + B }, this.hash(k + '#' + idx), true, sort, jpeg, unit));
            // 诱饵模式：区域原始像素散布到原图区 LSB，区域本体填诱饵图
            let decoySc = 1, dataLen = 0;
            if (decoy) {
                // 容量预估：区域数据是否需要降采样（有损）
                const cap3 = w * h * 3, need0 = regions.reduce((a, r) => a + r.w * r.h * 24, 0);
                if (need0 > cap3) {
                    const approxSc = Math.max(2, Math.ceil(Math.sqrt(need0 / cap3)));
                    // 弹出三选 modal；选择后经回调继续
                    this.promptCap(need0, cap3, approxSc, (choice) => {
                        if (choice === 'cancel') { T("已取消加密"); return; }
                        if (choice === 'nodecoy') {
                            // 关闭诱饵 → 普通打码无损，重跑
                            MOB.decoyOn = false; if ($('v3-decoyb')) $('v3-decoyb').innerText = '🖼 诱饵图: 关';
                            T("已关闭诱饵图，按普通打码加密");
                            this.pV3(img, k, t);
                            return;
                        }
                        // losse：接受降采样，继续诱饵加密
                        this.decoyCvs = this.prepareDecoy(MOB.decoyImg, w, h);
                        const em = this.decoyEmbed(d.data, cw, ch, w, h, B, regions);
                        if (!em) { T("诱饵容量仍不足，请减小打码区域"); return; }
                        this.decoyPaint(d.data, cw, ch, w, h, B, regions, this.decoyCvs);
                        this.decoyMetaOut(c, x, d, cw, ch, B, jpeg, t, regions, k, 1, em.total, em.sc);
                    });
                    return; // 等 modal 回调
                }
                this.decoyCvs = this.prepareDecoy(MOB.decoyImg, w, h);
                const em = this.decoyEmbed(d.data, cw, ch, w, h, B, regions);
                if (!em) { T("诱饵容量仍不足，请减小打码区域"); return; }
                decoySc = em.sc; dataLen = em.total;
                this.decoyPaint(d.data, cw, ch, w, h, B, regions, this.decoyCvs);
            }
            if (jpeg) {
                // J2 拍屏鲁棒 JPEG：四角 Finder 定位 + 二值环带码 + RS(255,127) 自适应，边框 64px
                // 区域内容（16px 置换+扰动）不入边框，只存坐标与签名 → 密码反推即可
                const payload = this.metaBytesR(cw, ch, regions.length, regions, k, 8, 0); // flag bit3=JPEG友好亮度域
                if (!J2.writeRing(d.data, cw, ch, payload)) { T("图片尺寸过小，JPEG 鲁棒边框容量不足（建议原图 ≥ 512×512）"); return; }
                x.putImageData(d, 0, 0);
                this.fin(c, t, 'image/jpeg', parseInt($('qv3').value) / 100);
            } else {
                this.decoyMetaOut(c, x, d, cw, ch, B, jpeg, t, regions, k, decoy ? 1 : 0, dataLen, decoySc);
            }
        } else {
            // 解密：J2 拍屏鲁棒码(64px Finder) → 旧 V3-J(48px 时序条) → PNG(8px LSB) → 旧 JPEG(32px 块级)
            let parsed = null, geo = null, w0 = 0, h0 = 0, dB = 8, ring = null;
            const rr = this.readRing(d.data, cw, ch); // 优先尝试 J2（Finder + homography，支持拍屏透视）
            if (rr && (parsed = this.parseMetaR(rr.payload))) { ring = rr; w0 = rr.w0; h0 = rr.h0; }
            const rob = this.readRobustJpeg(d.data, cw, ch);
            if (!parsed && rob && (parsed = this.parseMetaR(rob.payload))) { geo = rob.geo; w0 = rob.w0; h0 = rob.h0; }
            if (!parsed) { parsed = this.parseMeta(this.rMetaPng(d.data, this.borderOrd(cw, ch, 8), 200)); }
            if (!parsed) { const pr = this.parseMeta(this.rMetaJpeg(d.data, cw, ch, 32)); if (pr) { parsed = pr; dB = 32; } }
            if (!parsed) { T("未识别到打码元数据，或不是 V3 加密图"); return; }
            const { cnt, regions, stored, flag, dataLen } = parsed;
            const expect = (this.hash('V3|' + cnt + '|' + regions.map(r => r.x + ',' + r.y + ',' + r.w + ',' + r.h).join('&') + '|' + k) >>> 0) & 0xFFFFFF;
            if (stored !== expect) { T("❌ 密码错误，无法解密"); return; }
            if (ring) {
                // J2 路径：按单应 H 把照片/文件重采样回原内容网格 → 16px 置换+扰动逆变换 → JPEG 后处理
                const c2 = J2.reconstruct(d.data, cw, ch, ring.H, ring.w0, ring.h0);
                if (!c2) { T("还原失败：图像几何异常"); return; }
                const x2 = c2.getContext('2d'), rd = x2.getImageData(0, 0, c2.width, c2.height);
                const soft = !!(flag & 8);
                regions.slice().reverse().forEach((reg, idx) => this.regionEnc(rd.data, c2.width, c2.height, { x: reg.x, y: reg.y, w: reg.w, h: reg.h }, this.hash(k + '#' + (regions.length - 1 - idx)), false, false, soft, 16));
                this.jpegBandClean(rd.data, c2.width, c2.height, regions, 2);
                this.jpegDcEqualize(rd.data, c2.width, c2.height, regions);
                this.jpegDeblock(rd.data, c2.width, c2.height, regions);
                x2.putImageData(rd, 0, 0);
                this.fin(c2, t, 'image/png', 1);
                return;
            }
            if (geo) {
                // 几何鲁棒路径：按检测到的 缩放+平移 重建原尺寸图像网格，再区域逆变换
                // 先精修：对 tx/ty 做 ±2px 半像素扫描，选块缝最平的对齐
                const refine = () => {
                    const sw = Math.min(160, w0 - 96), sh = Math.min(120, h0 - 96);
                    if (sw < 32 || sh < 32) return;
                    const sx0 = geo.sx, sy0 = geo.sy;
                    const baseTx = geo.tx, baseTy = geo.ty;
                    let bestTx = baseTx, bestTy = baseTy, bestS = Infinity;
                    for (let dtx = -2; dtx <= 2; dtx += 0.5) for (let dty = -2; dty <= 2; dty += 0.5) {
                        const tx2 = baseTx + dtx, ty2 = baseTy + dty;
                        let score = 0, n = 0;
                        for (let ox = 8; ox < sw; ox += 8) {
                            for (let oy = 0; oy < sh; oy += 3) {
                                const gx0 = Math.round(sx0 * (48 + ox - 0.5) + tx2);
                                const gx1 = Math.round(sx0 * (48 + ox + 0.5) + tx2);
                                const gy = Math.round(sy0 * (48 + oy + 0.5) + ty2);
                                if (gx0 >= 0 && gx1 < cw && gy >= 0 && gy < ch) {
                                    const s0 = (gy * cw + gx0) * 4, s1 = (gy * cw + gx1) * 4;
                                    score += Math.abs(d[s0] - d[s1]) + Math.abs(d[s0 + 1] - d[s1 + 1]) + Math.abs(d[s0 + 2] - d[s1 + 2]);
                                    n++;
                                }
                            }
                        }
                        for (let oy = 8; oy < sh; oy += 8) {
                            for (let ox = 0; ox < sw; ox += 3) {
                                const gy0 = Math.round(sy0 * (48 + oy - 0.5) + ty2);
                                const gy1 = Math.round(sy0 * (48 + oy + 0.5) + ty2);
                                const gx = Math.round(sx0 * (48 + ox + 0.5) + tx2);
                                if (gx >= 0 && gx < cw && gy0 >= 0 && gy1 < ch) {
                                    const s0 = (gy0 * cw + gx) * 4, s1 = (gy1 * cw + gx) * 4;
                                    score += Math.abs(d[s0] - d[s1]) + Math.abs(d[s0 + 1] - d[s1 + 1]) + Math.abs(d[s0 + 2] - d[s1 + 2]);
                                    n++;
                                }
                            }
                        }
                        score = n ? score / n : Infinity;
                        if (score < bestS) { bestS = score; bestTx = tx2; bestTy = ty2; }
                    }
                    geo.tx = bestTx; geo.ty = bestTy;
                };
                try { refine(); } catch (e) { /* refinement failed, use original */ }
                const c2 = this.robustReconstruct(d.data, cw, ch, w0, h0, geo), x2 = c2.getContext('2d');
                const rd = x2.getImageData(0, 0, c2.width, c2.height);
                regions.slice().reverse().forEach((reg, idx) => this.regionEnc(rd.data, c2.width, c2.height, { x: reg.x, y: reg.y, w: reg.w, h: reg.h }, this.hash(k + '#' + (regions.length - 1 - idx)), false, false, !!(flag & 8)));
                // 区域边界清理（含 4px 对齐边距与内缘均化）；恒等与分数几何均启用，PNG 路径不经此分支。
                // 实测：DC 全量均衡会洗掉区域内真实明暗梯度(雾)，全区域 5×5 中值抹细节；
                // 现为轻量均衡(单遍3×3邻域钳制±8,只压块噪声小差) + 阈值化去块(只拉≤48的小差,不碰真实边缘)。
                this.jpegBandClean(rd.data, c2.width, c2.height, regions, 2);
                this.jpegDcEqualize(rd.data, c2.width, c2.height, regions);
                this.jpegDeblock(rd.data, c2.width, c2.height, regions);
                x2.putImageData(rd, 0, 0);
                this.fin(c2, t, 'image/png', 1);
            } else {
                if (flag & 1) { // 诱饵：直接从 LSB 提取区域原始像素填回（仅 PNG 路径可达）
                    const sc = ((flag >> 2) & 63) || 1;
                    if (!this.decoyExtract(d.data, cw, ch, dB, regions, dataLen, sc)) { T("诱饵数据提取失败"); return; }
                } else {
                    const sort2 = !!(flag & 2);
                    // 逆序还原：加密时后处理的区域先还原
                    regions.slice().reverse().forEach((reg, idx) => this.regionEnc(d.data, cw, ch, { ...reg, x: reg.x + dB, y: reg.y + dB }, this.hash(k + '#' + (regions.length - 1 - idx)), false, sort2, !!(flag & 8)));
                    if (dB === 32) { const rg2 = regions.map(rg => ({ x: rg.x + dB, y: rg.y + dB, w: rg.w, h: rg.h })); this.jpegDcEqualize(d.data, cw, ch, rg2); this.jpegDeblock(d.data, cw, ch, rg2); }
                }
                x.putImageData(d, 0, 0);
                // 裁剪回原尺寸
                const c2 = document.createElement('canvas'), x2 = c2.getContext('2d');
                const w2 = cw - dB * 2, h2 = ch - dB * 2;
                c2.width = w2; c2.height = h2; x2.drawImage(c, dB, dB, w2, h2, 0, 0, w2, h2);
                this.fin(c2, t, 'image/png', 1);
            }
        }
    },
    /* 诱饵图资源：缩放原图尺寸供取色 */
    decoyCvs: null,
    prepareDecoy(img, w, h) {
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const x = cv.getContext('2d'); x.drawImage(img, 0, 0, w, h);
        return cv;
    },
    /* 把每个区域(加密后)像素散布到原图区 LSB；容量不足自动降采样。返回 {bits, sc} 或 null */
    decoyEmbed(d, cw, ch, w, h, B, regions) {
        const cap = w * h * 3;
        // 需要位数 = 各区域(w*sc缩放)像素*24
        let need = 0; for (const r of regions) need += r.w * r.h * 24;
        let sc = 1;
        // 降采样到 ≤ 容量：面积缩到 (w*h/8)，sc² ≥ 面积比
        if (need > cap) {
            sc = Math.ceil(Math.sqrt(need / cap)) || 2;
            if (sc < 2) sc = 2;
            if (sc > 16) sc = 16;
        }
        const bits = [];
        for (const reg of regions) {
            const sw = Math.ceil(reg.w / sc) || 1, sh = Math.ceil(reg.h / sc) || 1;
            for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
                // 取 sc×sc 块中心像素作代表
                const cx = sx * sc + (sc >> 1), cy = sy * sc + (sc >> 1);
                const px = Math.min(reg.x + cx, reg.x + reg.w - 1), py = Math.min(reg.y + cy, reg.y + reg.h - 1);
                const f = ((B + py) * cw + (B + px)) * 4;
                bits.push(d[f], d[f + 1], d[f + 2]);
            }
        }
        const total = bits.length * 8;
        if (total > cap) return null; // 极端情况兜底
        // 逐位写入原图区像素 R/G/B LSB
        let bi = 0;
        outer:
        for (let y = 0; y < h; y++) for (let l = 0; l < w; l++) {
            const f = ((B + y) * cw + (B + l)) * 4;
            for (let ch_ = 0; ch_ < 3; ch_++) {
                if (bi >= total) break outer;
                const byte = bits[bi >> 3], bit = bi & 7;
                d[f + ch_] = (d[f + ch_] & 254) | ((byte >> (7 - bit)) & 1);
                bi++;
            }
        }
        return { total, sc };
    },
    /* 帮助弹窗 */
    showHelp() { const h = $('v3-help'); if (h) h.classList.add('on'); },
    hideHelp() { const h = $('v3-help'); if (h) h.classList.remove('on'); },
    /* 超容量三选 modal：关闭诱饵(无损) / 接受有损 / 取消 —— 经 callback 返回选择 */
    promptCap(need, cap, sc, cb) {
        const kb = n => (n / 8 / 1024).toFixed(0);
        $('v3-ask-d').innerHTML = `打码区域数据量 <b>${kb(need)} KB</b> 超过容量 <b>${kb(cap)} KB</b>。<br>` +
            `当前诱饵模式需 <b>${sc}×${sc}</b> 降采样存储，解密时区域为马赛克近似（有损）。请选择：`;
        const box = $('v3-ask');
        const done = (v) => { box.classList.remove('on'); cb(v); };
        const bind = (id, v) => { const el = $(id); el.onclick = () => done(v); };
        bind('v3-opt-nodecoy', 'nodecoy');
        bind('v3-opt-losse', 'losse');
        $('v3-opt-cancel').onclick = () => done('cancel');
        box.classList.add('on');
    },
    /* 诱饵/打码收尾：写元数据 + 输出 */
    decoyMetaOut(c, x, d, cw, ch, B, jpeg, t, regions, k, decoyFlag, dataLen, decoySc) {
        const flag = decoyFlag | ((decoySc & 63) << 2);
        const bs = this.metaBytes(regions.length, regions, k, flag, dataLen);
        const ord = this.borderOrd(cw, ch, B);
        const ok = jpeg ? this.wMetaJpeg(bs, d.data, cw, ch, B) : this.wMetaPng(bs, d.data, ord);
        if (!ok) { T("边框放不下元数据，请减少区域"); return; }
        x.putImageData(d, 0, 0);
        let q = 1.0, m = 'image/png';
        if (jpeg) { m = 'image/jpeg'; q = parseInt($('qv3').value) / 100; }
        this.fin(c, t, m, q);
    },
    /* 从 LSB 提取诱饵数据，按区域 24bit/像素 还原为加密+排序后状态；sc=降采样率(1=原始) */
    decoyExtract(d, cw, ch, dB, regions, dataLen, sc) {
        const bits = [];
        let bi = 0;
        outer:
        for (let y = 0; y < ch - dB * 2; y++) for (let l = 0; l < cw - dB * 2; l++) {
            const f = ((dB + y) * cw + (dB + l)) * 4;
            for (let ch_ = 0; ch_ < 3; ch_++) {
                if (bi >= dataLen) break outer;
                bits[bi] = d[f + ch_] & 1; bi++;
            }
        }
        if (bits.length < dataLen) return false;
        const byteAt = (bi2) => { let v = 0; if (bi2 * 8 + 7 >= bits.length) return 0; for (let b = 0; b < 8; b++) v = (v << 1) | bits[bi2 * 8 + b]; return v; };
        let off = 0;
        for (const reg of regions) {
            const sw = Math.ceil(reg.w / sc) || 1, sh = Math.ceil(reg.h / sc) || 1;
            for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
                const R = byteAt(off), G = byteAt(off + 1), B = byteAt(off + 2);
                off += 3;
                // 放大填充 sc×sc 块
                for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) {
                    const px = reg.x + sx * sc + xx, py = reg.y + sy * sc + yy;
                    if (px >= reg.x + reg.w || py >= reg.y + reg.h) continue;
                    const f = ((dB + py) * cw + (dB + px)) * 4;
                    d[f] = R; d[f + 1] = G; d[f + 2] = B;
                }
            }
        }
        return true;
    },
    /* 区域本体填充诱饵图：每个打码区域独立把整张诱饵图拉伸铺满（仅高 7 位，保留 LSB 数据位） */
    decoyPaint(d, cw, ch, w, h, B, regions, decoyCvs) {
        for (const reg of regions) {
            // 整张诱饵图拉伸到该区域尺寸 → 每个打码区域各自独立显示同一张诱饵图
            const rc = document.createElement('canvas'); rc.width = reg.w; rc.height = reg.h;
            const rx = rc.getContext('2d');
            rx.drawImage(decoyCvs, 0, 0, w, h, 0, 0, reg.w, reg.h);
            const ddr = rx.getImageData(0, 0, reg.w, reg.h).data;
            for (let yy = 0; yy < reg.h; yy++) for (let xx = 0; xx < reg.w; xx++) {
                const f = ((B + reg.y + yy) * cw + (B + reg.x + xx)) * 4;
                const ff = (yy * reg.w + xx) * 4;
                d[f] = (d[f] & 1) | (ddr[ff] & 254);
                d[f + 1] = (d[f + 1] & 1) | (ddr[ff + 1] & 254);
                d[f + 2] = (d[f + 2] & 1) | (ddr[ff + 2] & 254);
            }
        }
    },
    fin(c, t, m, q) {
        const i = $('o' + t);
        // 结果图用 Blob URL 展示（纯本地，长按可保存；不经过任何服务器）
        if (!this.buMime) this.buMime = {};
        this.buMime[t] = m;
        const show = (blob) => {
            if (!this.bu) this.bu = {};
            if (this.bu[t]) URL.revokeObjectURL(this.bu[t]);
            this.bu[t] = URL.createObjectURL(blob);
            i.src = this.bu[t];
            $('rx-' + t).classList.add('on');
            i.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            if (t === 'e') {
                const s = blob.size;
                $('me').innerText = `格式:${m.split('/')[1].toUpperCase()}|大小:${s > 1e6 ? (s / 1e6).toFixed(2) + "MB" : (s / 1024).toFixed(0) + "KB"}`;
            }
        };
        try { c.toBlob(b => { if (b) show(b); else { const u = c.toDataURL(m, q); i.src = u; } }, m, q); }
        catch (e) { const u = c.toDataURL(m, q); i.src = u; }
    },
    dl(t) {
        const s = $('o' + t).src; if (!s) return;
        const mime = this.buMime && this.buMime[t] || (s.includes('png') ? 'image/png' : 'image/jpeg');
        const ext = mime.includes('png') ? 'png' : 'jpg';
        const name = `CX_${this.al}_${Date.now()}.${ext}`;
        const fire = (url) => {
            const a = document.createElement('a');
            a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => document.body.removeChild(a), 500);
        };
        if (s.startsWith('blob:')) {
            // 已是 Blob URL：直接下载；安卓 WebView 若无效则长按保存（blob 图可长按）
            fire(s);
        } else if (s.startsWith('data:')) {
            // dataURL → Blob URL（兼容旧路径），a 挂载 DOM 后 click
            try {
                const b = atob(s.split(',')[1]); const n = b.length; const u8 = new Uint8Array(n);
                for (let i = 0; i < n; i++) u8[i] = b.charCodeAt(i);
                const blob = new Blob([u8], { type: mime });
                const url = URL.createObjectURL(blob);
                fire(url);
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            } catch (e) { fire(s); }
        }
    }
};

const APP_VER = '3.7';

try { var vt = document.getElementById('ver-tag'); if (vt) vt.textContent = 'v' + APP_VER; } catch (e) {}

/* ===== V3 打码编辑器 ===== */
const MOB = {
    url: null, img: null, natW: 0, natH: 0, regions: [], drag: null,
    setup() { const ov = $('pv3-ov'); if (ov.__bound) return; ov.__bound = true;
        const start = (e) => { if (!this.img) return; const p = this.pt(e); this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; ov.setPointerCapture(e.pointerId); };
        const move = (e) => { if (!this.drag) return; const p = this.pt(e); this.drag.x1 = p.x; this.drag.y1 = p.y; this.draw(); };
        const end = () => { if (!this.drag) return; const d = this.drag; this.drag = null;
            let x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
            if (w > 8 && h > 8) { this.addRegion({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }); } this.draw(); };
        ov.addEventListener('pointerdown', start);
        ov.addEventListener('pointermove', move);
        ov.addEventListener('pointerup', end);
        ov.addEventListener('pointercancel', end);
        window.addEventListener('resize', () => this.draw());
    },
    pt(e) { const r = $('pv3-ov').getBoundingClientRect(); const sx = this.natW / r.width, sy = this.natH / r.height;
        return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy }; },
    addRegion(reg) { if (this.regions.length >= 12) return T("最多 12 个区域"); this.regions.push(this.norm(reg)); this.renderList(); this.draw(); },
    norm(reg) { // 适配坐标系（区域可在原图全范围，边框外扩不影响）
        let x = Math.max(0, reg.x), y = Math.max(0, reg.y);
        let x2 = Math.min(this.natW, reg.x + reg.w), y2 = Math.min(this.natH, reg.y + reg.h);
        return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) }; },
    all() { if (!this.img) return T("先载入图片"); this.addRegion({ x: 0, y: 0, w: this.natW, h: this.natH }); },
    undo() { this.regions.pop(); this.renderList(); this.draw(); },
    clear() { this.regions = []; this.renderList(); this.draw(); this.encClear(); },
    del(i) { this.regions.splice(i, 1); this.renderList(); this.draw(); },
    renderList() {
        const L = $('v3-list'); L.innerHTML = '';
        this.regions.forEach((r, i) => {
            const it = document.createElement('div'); it.className = 'v3-item';
            it.innerHTML = `<span class="num">${i + 1}</span><span class="meta">${r.w}×${r.h} @ (${r.x},${r.y})</span><button class="v3-del">✕</button>`;
            it.querySelector('.v3-del').onclick = () => this.del(i);
            L.appendChild(it);
        });
        $('v3-count').innerText = '已选 ' + this.regions.length + ' 个区域（元数据外扩进边框）';
    },
    draw() {
        const ov = $('pv3-ov'), c = ov.getContext('2d');
        if (!this.img || !this.natW) { ov.width = ov.height = 0; return; }
        const r = $('v3-stage').getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        ov.width = Math.round(r.width * dpr); ov.height = Math.round(r.height * dpr);
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const sx = r.width / this.natW, sy = r.height / this.natH;
        this.regions.forEach((reg, i) => {
            c.fillStyle = 'rgba(47,123,255,.22)'; c.strokeStyle = '#2f7bff'; c.lineWidth = 2;
            c.fillRect(reg.x * sx, reg.y * sy, reg.w * sx, reg.h * sy);
            c.strokeRect(reg.x * sx, reg.y * sy, reg.w * sx, reg.h * sy);
            c.fillStyle = '#2f7bff';
            c.beginPath(); c.arc(reg.x * sx + 10, reg.y * sy + 10, 11, 0, 7); c.fill();
            c.fillStyle = '#fff'; c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
            c.fillText(i + 1, reg.x * sx + 10, reg.y * sy + 10);
        });
        if (this.drag) {
            let x = Math.min(this.drag.x0, this.drag.x1) * sx, y = Math.min(this.drag.y0, this.drag.y1) * sy;
            let w = Math.abs(this.drag.x1 - this.drag.x0) * sx, h = Math.abs(this.drag.y1 - this.drag.y0) * sy;
            c.strokeStyle = '#2f7bff'; c.lineWidth = 2; c.setLineDash([6, 4]);
            c.strokeRect(x, y, w, h); c.setLineDash([]);
            c.fillStyle = 'rgba(47,123,255,.15)'; c.fillRect(x, y, w, h);
        }
    },
    loadFrom(url, t) {
        const img = new Image();
        img.onload = () => { this.url = url; this.img = img; this.natW = img.naturalWidth; this.natH = img.naturalHeight;
            this.regions = []; this.encClear();
            const st = $('v3-stage'); st.style.aspectRatio = this.natW + '/' + this.natH;
            $('pv3-img').src = url; $('pv3-img').style.display = 'block'; $('v3-empty').style.display = 'none';
            this.draw(); };
        img.src = url;
    },
    encClear() { },
    /* PNG 增强开关：诱饵图（排序功能已下线） */
    sortOn: false, decoyOn: false, decoyImg: null, decoyURL: null,
    togDecoy() {
        this.decoyOn = !this.decoyOn;
        $('v3-decoyb').innerText = '🖼 诱饵图: ' + (this.decoyOn ? '开' : '关');
        $('v3-decoy-row').style.display = this.decoyOn ? 'block' : 'none';
    },
    pickDecoy(i) {
        const f = i.files[0]; if (!f) return;
        if (this.decoyURL) URL.revokeObjectURL(this.decoyURL);
        this.decoyURL = URL.createObjectURL(f);
        const im = new Image();
        im.onload = () => { this.decoyImg = im; $('v3-decoy-lb').innerText = '✅ 诱饵图已载入 ' + im.naturalWidth + '×' + im.naturalHeight + '（可重新选择）'; };
        im.src = this.decoyURL;
    },
    decoyReset() { if (this.decoyURL) URL.revokeObjectURL(this.decoyURL); this.decoyURL = null; this.decoyImg = null; $('v3-decoy-lb').innerHTML = '📁 选择诱饵图（每个打码区域将独立铺满显示这张诱饵图，解密无需诱饵图）'; },
};

// 页面默认打开 V3 区域打码
IA.set('v3');

// 全局粘贴与拖拽支持
document.addEventListener('paste', e => {
    const it = e.clipboardData.items; let f = null; for (let i = 0; i < it.length; i++) if (it[i].type.includes('image')) { f = it[i].getAsFile(); break; } if (!f) return;
    const t = IA.target || 'e'; const dt = new DataTransfer(); dt.items.add(f); $('dr-' + t).querySelector('input').files = dt.files; IA.ld($('dr-' + t).querySelector('input'), t); T(`已粘贴到${t === 'd' ? '解密' : '加密'}框`);
});
['e', 'd'].forEach(t => {
    const d = $('dr-' + t);
    d.addEventListener('mouseenter', () => IA.target = t);
    d.addEventListener('dragover', e => { e.preventDefault(); d.style.borderColor = 'var(--p)'; d.style.background = 'rgba(0,242,255,.1)'; });
    d.addEventListener('dragleave', e => { e.preventDefault(); d.style.borderColor = 'var(--b)'; d.style.background = 'rgba(0,0,0,.2)'; });
    d.addEventListener('drop', e => { e.preventDefault(); d.style.borderColor = 'var(--b)'; d.style.background = 'rgba(0,0,0,.2)'; if (e.dataTransfer.files[0]) { const i = d.querySelector('input'); i.files = e.dataTransfer.files; IA.ld(i, t); } });
});

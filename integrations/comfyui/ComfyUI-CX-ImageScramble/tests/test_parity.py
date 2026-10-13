# -*- coding: utf-8 -*-
"""
test_parity.py — 证明本节点的 Python 实现与 cx-E2EE 网页端 JS 实现 **逐位等价**。

做法：不手抄 JS，而是用 make_ref_impl.py 从 src/image-crypto.js
原样抽取 IA.hash / IA.rng / IA.perm / IA.regionEnc / IA.metaBytes 等，交给 node 跑，
再把同一份数据喂给 cx_core.py，比较字节。

用法（用 ComfyUI 自带 python 跑，需要 numpy）：
    D:\ComfyUI-new\venv\Scripts\python.exe tests\test_parity.py
可选参数：--src <仓库>/src/image-crypto.js（不给则自动定位，见 tests/js_parity/cx_src.py）
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

try:  # Windows 控制台默认 GBK，中文/表情符号会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
sys.path.insert(0, os.path.join(HERE, "js_parity"))

import cx_core  # noqa: E402
import cx_src  # noqa: E402

JP = os.path.join(HERE, "js_parity")

FAIL = []


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def run(cmd, **kw):
    # 显式 UTF-8：Windows 控制台默认 GBK，非 ASCII 会在这里翻车
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "replace")
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        raise SystemExit("命令失败：%s\n%s\n%s" % (" ".join(map(str, cmd)), p.stdout, p.stderr))
    return p.stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=None,
                    help="src/image-crypto.js 路径（默认自动定位）")
    ap.add_argument("--node", default="node")
    args = ap.parse_args()
    src = cx_src.resolve(args.src)
    print("真源 JS：%s" % src)

    print("== 1. 从真源码抽取 JS 实现 ==")
    run([sys.executable, os.path.join(JP, "make_ref_impl.py"), src,
         os.path.join(JP, "ref_impl.mjs")])

    print("== 2. hash / rng / perm 对照 ==")
    # 网页端口径：区域 seed = hash(密码 + '#' + 区域序号)，这里直接把这些字符串也丢给 JS 算
    pw_cases = ["", "pwd", "密码123", "cx-e2ee", "0", "a b#c", "长" * 64]
    pw_idx = [0, 1, 7, 11]
    hash_cases = ["pwd#0", "123#1", "", "CX-E2EE", "密码123#7", "a" * 257] \
        + ["%s#%d" % (pw, i) for pw in pw_cases for i in pw_idx]
    perm_cases = [[1, 0], [8, -1], [37, 987654321], [1024, 12345], [4096, -2147483648]]
    rng_cases = [[12345, 6], [-2147483648, 6], [0, 6]]
    spec = {"hashes": hash_cases, "perms": perm_cases, "rng": rng_cases}
    with tempfile.TemporaryDirectory() as td0:
        sp = os.path.join(td0, "spec.json")
        op = os.path.join(td0, "probe.json")
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False)
        run([args.node, "ref_probe.mjs", sp, op], cwd=JP)
        with open(op, encoding="utf-8") as f:
            js = json.load(f)

    bad = []
    for s in hash_cases:
        py = cx_core.cx_hash(s)
        if int(js["hashes"][s]) != py:
            bad.append((s, js["hashes"][s], py))
    check("IA.hash 全部一致（含中文/长串）", not bad, str(bad[:3]))

    bad = []
    # 注意：密码为空串时节点走 int key 那条路（秘密 = "0"），不属于「网页端密码」口径，故跳过
    for pw in [x for x in pw_cases if x]:
        for i in pw_idx:
            want = cx_core._i32(int(js["hashes"]["%s#%d" % (pw, i)]))
            got = cx_core.region_seed(0, pw, i)
            if want != got:
                bad.append((pw, i, want, got))
    check("密码→种子：region_seed(密码, 区域序号) == JS hash(密码#序号)", not bad, str(bad[:3]))

    bad = []
    for n in (1, 12345, 987654321, -7):
        for i in (0, 3):
            if cx_core.region_seed(n, "", i) != cx_core.region_seed(0, str(n), i):
                bad.append((n, i))
    check("key=N 与 password=\"N\" 是同一个秘密（种子相同）", not bad, str(bad[:3]))

    ok = True
    for key, pw, want_src, want_warn in [(1, "", "int key", False), (0, "p", "password", False),
                                         (5, "p", "password", True), (0, "", "int key", False)]:
        src, warn = cx_core.describe_secret(key, pw)
        if src != want_src or bool(warn) != want_warn:
            ok = False
    check("describe_secret：来源判定 + 同时给两者会告警（不静默）", ok)

    bad = []
    for n, seed in perm_cases:
        js_p = js["perms"]["%d:%d" % (n, seed)]
        py_p = cx_core._perm(n, seed)
        if list(map(int, js_p)) != py_p:
            bad.append((n, seed, next((i for i, (a, b) in enumerate(zip(js_p, py_p)) if int(a) != b), None)))
    check("IA.perm 置换表逐元素相同", not bad, str(bad[:3]))

    bad = []
    for seed, cnt in rng_cases:
        js_r = js["rng"]["%d:%d" % (seed, cnt)]
        g = cx_core._rng(seed)
        for i in range(cnt):
            if next(g) != js_r[i]:
                bad.append((seed, i))
                break
    check("IA.rng 浮点序列完全相同", not bad, str(bad[:3]))

    print("== 3. regionEnc 像素级对照（RGB 平面逐字节） ==")
    rng = np.random.default_rng(20240117)
    W, H = 512, 384
    img = rng.integers(0, 256, size=(H, W, 3), dtype=np.uint8)
    # 加一块平滑渐变，保证也有非噪声内容
    yy, xx = np.mgrid[0:H, 0:W]
    img[..., 0] = np.clip((xx * 255 // W), 0, 255).astype(np.uint8)
    img[..., 1] = np.clip((yy * 255 // H), 0, 255).astype(np.uint8)

    rgbs = np.concatenate([img, np.full((H, W, 1), 255, np.uint8)], axis=2)
    cases = []
    for unit in (8, 16):
        for soft in (False, True):
            for enc in (True, False):
                for (x, y, w, h, seed) in [
                    (0, 0, W, H, 12345),            # 全图
                    (101, 57, 200, 130, -7),        # 非对齐
                    (500, 370, 100, 100, 999999),   # 越过右下边界
                    (7, 7, 9, 9, 2147483647),       # 小于一个块
                    (64, 64, 8, 8, 0),              # 恰好一个块
                ]:
                    cases.append((unit, soft, enc, x, y, w, h, seed))

    with tempfile.TemporaryDirectory() as td:
        raw_in = os.path.join(td, "in.raw")
        open(raw_in, "wb").write(rgbs.tobytes())
        n_ok = 0
        for (unit, soft, enc, x, y, w, h, seed) in cases:
            raw_js = os.path.join(td, "js.raw")
            run([args.node, "ref_harness.mjs", raw_in, str(W), str(H), str(x), str(y),
                 str(w), str(h), str(seed), str(unit), "1" if soft else "0",
                 "1" if enc else "0", raw_js], cwd=JP)
            js_rgb = np.frombuffer(open(raw_js, "rb").read(), np.uint8).reshape(H, W, 4)[..., :3].copy()

            py_rgb = rgbs[..., :3].copy()
            cx_core.region_enc(py_rgb, x, y, w, h, seed, enc, soft, unit)

            same = np.array_equal(js_rgb, py_rgb)
            diff = -1 if same else int(np.abs(js_rgb.astype(int) - py_rgb.astype(int)).max())
            check("unit=%-2d soft=%d enc=%d box=(%d,%d,%d,%d) seed=%d" % (unit, soft, enc, x, y, w, h, seed),
                  same, "" if same else "max|Δ|=%d, 不同像素=%d" % (diff, int((js_rgb != py_rgb).any(-1).sum())))
            n_ok += same
        check("regionEnc 全部 %d 组逐字节一致" % len(cases), n_ok == len(cases))

        # 往返：加密 → 解密。注意区域打码是「混淆」不是无损加密：
        # Y 被压到 [50,205] 再加 ±40 扰动，极端饱和色在 YUV→RGB 时会钳制，故有损。
        print("== 4. 加解密往返 ==")
        BOX = (101, 57, 200, 130)

        def roundtrip(img, seed=-7, soft=False):
            a = img.copy().astype(np.int32)
            b = img.copy()
            cx_core.region_enc(b, BOX[0], BOX[1], BOX[2], BOX[3], seed, True, soft, 8)
            scrambled = b.copy()
            cx_core.region_enc(b, BOX[0], BOX[1], BOX[2], BOX[3], seed, False, soft, 8)
            d = np.abs(a - b.astype(np.int32))
            sub = d[BOX[1]:BOX[1] + BOX[3], BOX[0]:BOX[0] + BOX[2]]
            mse = float((sub.astype(np.float64) ** 2).mean())
            psnr = 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)
            return scrambled, d, sub, psnr

        # (a) 照片类内容（平滑渐变 + 低频结构）：往返应高保真
        base = np.zeros((H, W, 3), np.uint8)
        base[..., 0] = (xx * 255 // W)
        base[..., 1] = (yy * 255 // H)
        base[..., 2] = ((xx + yy) * 255 // (W + H))
        blob = (np.sin(xx / 40.0) * np.cos(yy / 30.0) * 40 + 128).astype(np.int32)
        photo = np.clip(base.astype(np.int32) + blob[..., None] - 128, 0, 255).astype(np.uint8)

        scr, d, sub, psnr = roundtrip(photo)
        changed = float((scr[BOX[1]:BOX[1] + BOX[3], BOX[0]:BOX[0] + BOX[2]] != photo[
            BOX[1]:BOX[1] + BOX[3], BOX[0]:BOX[0] + BOX[2]]).any(-1).mean())
        check("打码确实生效（区域内变化像素 > 95%%）", changed > 0.95, "变化=%.2f%%" % (changed * 100))
        check("照片类内容往返 PSNR > 30dB 且区域内 mean|Δ| < 1.0",
              psnr > 30 and sub.mean() < 1.0,
              "PSNR=%.1fdB 区域内 mean|Δ|=%.3f max|Δ|=%d" % (psnr, sub.mean(), sub.max()))
        # 注意：受影响范围是「按 unit 向下/向上对齐后的块范围」，比标称 aabb 略大
        ax0, ay0, ax1, ay1 = cx_core._region_block_span(BOX[0], BOX[1], BOX[2], BOX[3], W, H, 8)
        mask = np.ones((H, W), bool)
        mask[ay0:ay1, ax0:ax1] = False
        print("         [INFO] aabb=(%d,%d,%d,%d) → 实际对齐块范围=(%d,%d,%d,%d)"
              % (BOX + (ax0, ay0, ax1, ay1)))
        check("对齐块范围之外像素零改动", not d[mask].any(),
              "范围外 max|Δ|=%d" % (int(d[mask].max()) if d[mask].size else 0))

        # (b) 极端彩噪（最坏情况）：仅报告数据，不做断言
        _, d2, sub2, psnr2 = roundtrip(rgbs[..., :3])
        print("         [INFO] 纯随机彩噪（最坏情况）往返：PSNR=%.1fdB mean|Δ|=%.3f max|Δ|=%d"
              % (psnr2, sub2.mean(), sub2.max()))
        # (c) 多区域 + 重叠：加密正序 / 解密倒序（网页端语义），应可整体还原
        print("== 5. 多区域重叠往返 ==")
        regions = [(64, 64, 160, 120), (128, 96, 160, 120), (300, 200, 90, 80)]
        a = photo.copy().astype(np.int32)
        b = photo.copy()
        n1 = cx_core.scramble_array(b, regions, 20240117, "", 8, False, True)
        n2 = cx_core.scramble_array(b, regions, 20240117, "", 8, False, False)
        d3 = np.abs(a - b.astype(np.int32))
        check("3 区域（含重叠）全部生效并整体还原", n1 == 3 and n2 == 3 and d3.mean() < 1.0,
              "processed=%d/%d 全图 mean|Δ|=%.3f max|Δ|=%d" % (n1, n2, d3.mean(), d3.max()))

        # (d) 含大面积饱和色块的图：JS 参考实现「自己加密再自己解密」的往返结果
        #     必须与 Python 的往返结果逐字节相同 —— 证明往返保真度（含其固有损失）来自算法本身
        print("== 6. 饱和色块图：往返结果与 JS 参考实现逐字节对照 ==")
        sat = np.zeros((H, W, 3), np.uint8)
        sat[..., 0] = np.clip(xx * 255 // (W - 1), 0, 255)
        sat[..., 1] = np.clip(yy * 255 // (H - 1), 0, 255)
        sat[..., 2] = np.clip((np.sin(xx / 37.0) + np.cos(yy / 23.0)) * 60 + 128, 0, 255)
        sat[150:230, 60:240] = (250, 250, 30)
        sat[60:130, 330:470] = (20, 20, 20)
        sat[260:340, 300:420] = (255, 0, 0)
        SB = (101, 57, 200, 150)

        raw0 = os.path.join(td, "sat0.raw")
        open(raw0, "wb").write(np.concatenate(
            [sat, np.full((H, W, 1), 255, np.uint8)], axis=2).tobytes())
        raw1 = os.path.join(td, "sat1.raw")
        raw2 = os.path.join(td, "sat2.raw")
        base = [args.node, "ref_harness.mjs", None, str(W), str(H), str(SB[0]), str(SB[1]),
                str(SB[2]), str(SB[3]), "20240117", "8", "0"]
        run(base[:2] + [raw0] + base[3:] + ["1", raw1], cwd=JP)   # JS 加密
        run(base[:2] + [raw1] + base[3:] + ["0", raw2], cwd=JP)   # JS 解密
        js_rt = np.frombuffer(open(raw2, "rb").read(), np.uint8).reshape(H, W, 4)[..., :3].copy()

        py_rt = sat.copy()
        cx_core.region_enc(py_rt, SB[0], SB[1], SB[2], SB[3], 20240117, True, False, 8)
        cx_core.region_enc(py_rt, SB[0], SB[1], SB[2], SB[3], 20240117, False, False, 8)
        same = np.array_equal(js_rt, py_rt)
        sub_s = (js_rt.astype(np.int32) - sat.astype(np.int32))[
            SB[1]:SB[1] + SB[3], SB[0]:SB[0] + SB[2]]
        mse_s = float((sub_s.astype(np.float64) ** 2).mean())
        psnr_s = 10 * np.log10(255.0 ** 2 / mse_s) if mse_s else 99.0
        check("JS enc→dec 与 Python enc→dec 逐字节相同", same,
              "" if same else "不同像素=%d" % int((js_rt != py_rt).any(-1).sum()))
        print("         [INFO] 该图（含饱和色块）往返 PSNR=%.1fdB mean|Δ|=%.2f "
              "← 与网页端同一个数值，损失来自算法本身（Y 压到[50,205]+±40 扰动后 YUV→RGB 钳制）"
              % (psnr_s, abs(sub_s).mean()))

    print()
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅  Python 实现与网页端 JS 逐字节等价")
    return 0


if __name__ == "__main__":
    sys.exit(main())

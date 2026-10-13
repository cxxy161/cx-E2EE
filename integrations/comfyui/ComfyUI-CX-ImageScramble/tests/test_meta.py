# -*- coding: utf-8 -*-
"""
test_meta.py — V3 元数据层（网页端 PNG 路径）的验证

证明三件事：
  1. 本实现的 metaBytes / parseMeta / borderOrd / wMetaPng / rMetaPng 与 cx-E2EE 的真 JS
     实现**逐字节相同**（JS 由 make_ref_impl.py 从 image-crypto.js 原样抽取）；
  2. 交叉：JS 写的边框元数据 Python 能读回、Python 写的 JS 能读回；
  3. 端到端意义：打码图自带区域表 → **还原只需要 图 + 密码**（这里在 numpy 层先闭环，
     真 ComfyUI 服务端在 tests/test_e2e_server.py 里再验一遍）。

用法：venv\\Scripts\\python.exe tests\\test_meta.py
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
JP = os.path.join(HERE, "js_parity")
sys.path.insert(0, JP)
import cx_core  # noqa: E402
import cx_src  # noqa: E402

FAIL = []


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def run(cmd, **kw):
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "replace")
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        raise SystemExit("命令失败：%s\n%s\n%s" % (" ".join(map(str, cmd)), p.stdout, p.stderr))
    return p.stdout.strip()


def psnr(a, b, box=None):
    a = a.astype(np.int32); b = b.astype(np.int32)
    if box:
        x, y, w, h = box
        a = a[y:y + h, x:x + w]; b = b[y:y + h, x:x + w]
    mse = float(((a - b) ** 2).mean())
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def main():
    src_arg = None
    if "--src" in sys.argv:
        src_arg = sys.argv[sys.argv.index("--src") + 1]
    print("== 0. 抽取 JS 实现 ==")
    print("真源 JS：%s" % cx_src.resolve(src_arg))
    args = [sys.executable, os.path.join(JP, "make_ref_impl.py")]
    if src_arg:
        args.append(src_arg)
    run(args)
    src = open(os.path.join(JP, "ref_impl.mjs"), encoding="utf-8").read()
    for m in ("metaBytes", "parseMeta", "borderOrd", "wMetaPng", "rMetaPng"):
        check("已抽取 %s" % m, ("%s(" % m) in src)

    cases = [
        {"cw": 100, "ch": 60, "count": 1, "k": "pwd", "regions": [[8, 16, 32, 48]]},
        {"cw": 132, "ch": 100, "count": 3,
         "k": "密码123",
         "regions": [[0, 0, 16, 16], [64, 32, 48, 48], [200, 150, 100, 60]]},
        {"cw": 300, "ch": 200, "count": 12,
         "k": "",
         "regions": [[i * 20, i * 10, 16, 16] for i in range(12)]},
        {"cw": 90, "ch": 90, "count": 2, "k": "a b#c&d",
         "regions": [[65535, 40000, 320, 480], [12, 34, 56, 78]]},
    ]

    with tempfile.TemporaryDirectory() as td:
        spec = {"cases": cases, "pyimg_w": 96, "pyimg_h": 72}
        faces_region = [(8, 8, 32, 24), (48, 32, 16, 16)]

        # Python 侧先写一张带元数据的裸 RGBA，交给 JS 读（交叉方向 2）
        cw, ch = spec["pyimg_w"], spec["pyimg_h"]
        py_img = np.full((ch, cw, 4), 255, np.uint8)
        py_img[..., 0] = np.random.default_rng(5).integers(0, 256, (ch, cw))  # 随便填，LSB 会被覆盖
        ok_w = cx_core.v3_write_meta(py_img, faces_region, "cross", B=8)
        p_raw = os.path.join(td, "py.rgba")
        open(p_raw, "wb").write(py_img.tobytes())

        sp = os.path.join(td, "spec.json")
        op = os.path.join(td, "out.json")
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(spec, f, ensure_ascii=False)
        run([os.environ.get("CX_NODE", "node"), "ref_meta.mjs", sp, op, p_raw], cwd=JP)
        with open(op, encoding="utf-8") as f:
            js = json.load(f)

        print("== 1. metaBytes / parseMeta / borderOrd 逐字节对照 ==")
        bad = []
        for c, jc in zip(cases, js["cases"]):
            bs_py = cx_core.meta_bytes(c["count"], [tuple(r) for r in c["regions"]], c["k"])
            if list(bs_py) != list(jc["bytes"]):
                bad.append((c["count"], c["k"], list(bs_py)[:8], jc["bytes"][:8]))
        check("metaBytes 全部一致（含中文密码 / 12 区域 / 空密码 / 大坐标）", not bad, str(bad[:2]))

        bad = []
        for c, jc in zip(cases, js["cases"]):
            o_py = cx_core.border_order(c["cw"], c["ch"], 8)
            if list(map(int, o_py)) != list(map(int, jc["order"])):
                bad.append((c["cw"], c["ch"], len(o_py), len(jc["order"])))
        check("borderOrd 像素序号流完全一致（顶→右→底→左）", not bad, str(bad[:2]))

        bad = []
        for c, jc in zip(cases, js["cases"]):
            bs = cx_core.meta_bytes(c["count"], [tuple(r) for r in c["regions"]], c["k"])
            pm = cx_core.parse_meta(bytes(jc["bytes"]))
            if (pm is None or pm["cnt"] != c["count"]
                    or [tuple(x) for x in pm["regions"]] != [tuple(r) for r in c["regions"]]
                    or pm["stored"] != jc["parsed"]["stored"]):
                bad.append((c["count"], pm))
        check("Python 解析 JS 的字节 == JS 自己解析的结果", not bad, str(bad[:2]))

        print("== 2. 写边框：Python 与 JS 写出来的像素缓冲逐字节相同 ==")
        bad = []
        for c, jc in zip(cases, js["cases"]):
            arr = np.full((c["ch"], c["cw"], 4), 255, np.uint8)
            bs = cx_core.meta_bytes(c["count"], [tuple(r) for r in c["regions"]], c["k"])
            cx_core.write_meta_png(arr, cx_core.border_order(c["cw"], c["ch"], 8), bs)
            js_buf = np.frombuffer(open(op + ".rgba.%dx%d" % (c["cw"], c["ch"]), "rb").read(),
                                   np.uint8).reshape(c["ch"], c["cw"], 4)
            if not np.array_equal(arr, js_buf):
                bad.append((c["cw"], c["ch"], int((arr != js_buf).sum())))
        check("wMetaPng 写出结果一致（R 通道 LSB 原位改）", not bad, str(bad[:2]))

        print("== 3. 交叉可读（JS 写 → Python 读、Python 写 → JS 读） ==")
        arr = np.full((ch, cw, 4), 255, np.uint8)
        cx_core.write_meta_png(arr, cx_core.border_order(cw, ch, 8),
                               cx_core.meta_bytes(len(faces_region), faces_region, "cross"))
        pm = cx_core.parse_meta(cx_core.read_meta_png(arr, cx_core.border_order(cw, ch, 8)))
        check("Python 自己写→自己读", pm and [tuple(r) for r in pm["regions"]] == faces_region)

        js_pm = js["pyimg"]["parsed"]
        js_regs = [(r["x"], r["y"], r["w"], r["h"]) for r in js_pm["regions"]] if js_pm else []
        check("JS 读 Python 写的边框元数据（区域 + 签名都对）",
              bool(js_pm) and js_regs == faces_region
              and js_pm["stored"] == cx_core.v3_signature(len(faces_region), faces_region, "cross"),
              "js=%s stored=%s want=%s" % (js_regs, js_pm and js_pm["stored"],
                                           cx_core.v3_signature(len(faces_region), faces_region, "cross")))

        print("== 4. 签名：同一个密码才算通过（网页端就是这么判断密码对错） ==")
        sig_ok = cx_core.v3_signature(2, faces_region, "right")
        sig_bad = cx_core.v3_signature(2, faces_region, "wrong")
        check("不同密码 → 签名不同", sig_ok != sig_bad, "%d vs %d" % (sig_ok, sig_bad))
        check("签名是 24bit", 0 <= sig_ok <= 0xFFFFFF)

        print("== 5. 打码图自带区域表 → 还原只要 图 + 密码（numpy 层闭环） ==")
        H, W = 200, 260
        yy, xx = np.mgrid[0:H, 0:W]
        img = np.zeros((H, W, 3), np.float32)
        img[..., 0] = (60 + 120 * xx / (W - 1)); img[..., 1] = (70 + 110 * yy / (H - 1))
        img[..., 2] = 90 + 60 * (np.sin(xx / 29.0) * np.cos(yy / 17.0) + 1) / 2
        img = np.rint(img).astype(np.uint8)

        regions = [(32, 24, 96, 64), (150, 110, 80, 56)]
        arr = cx_core.pad_with_border(img, 8)            # 外扩 8px，原图居中
        aligned = cx_core.align_regions_web(regions, W, H, 8)
        shifted = [(x + 8, y + 8, w, h) for (x, y, w, h) in aligned]
        cx_core.scramble_array(arr, shifted, 0, "我的密码", 8, False, True)
        cx_core.v3_write_meta(arr, aligned, "我的密码")
        scrambled = arr.copy()

        # 还原：只用 这张图 + 密码
        pm = cx_core.v3_read_meta(scrambled)
        check("从打码图里读回区域表", pm and [tuple(r) for r in pm["regions"]] == aligned,
              str(pm and pm["regions"]))
        check("密码校验通过", pm["stored"] == cx_core.v3_signature(pm["cnt"], pm["regions"], "我的密码"))
        back = scrambled.copy()
        cx_core.scramble_array(back, [(x + 8, y + 8, w, h) for (x, y, w, h) in pm["regions"]],
                               0, "我的密码", 8, bool(pm["flag"] & 8), False)
        back = back[8:-8, 8:-8]
        check("还原尺寸回到原图尺寸", back.shape == img.shape, str(back.shape))
        p_all = psnr(back, img)
        check("只给图+密码就能还原（PSNR > 40dB）", p_all > 40, "PSNR=%.1fdB" % p_all)
        check("密码不对 → 签名不符（可据此报「密码错误」）",
              pm["stored"] != cx_core.v3_signature(pm["cnt"], pm["regions"], "错密码"))

    print()
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅ V3 元数据层与网页端逐字节等价（解密只需 图 + 密码）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

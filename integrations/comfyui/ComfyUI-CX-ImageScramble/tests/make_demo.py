# -*- coding: utf-8 -*-
"""
make_demo.py — 生成对照图（人眼确认用）

两种预设：
    --preset aabb   输入 / 打码(aabb) / 还原
    --preset boxes  输入 / 节点输出的「有效区域掩膜」 / 打码(SEGS 打框数据) / 还原
也可以完全自定义面板：
    --panel "D:\\path\\a.png|1. 输入" --panel "D:\\path\\b.png|2. 打码" --out demo.png

用法（需先跑过 test_e2e_server.py）：
    venv\\Scripts\\python.exe tests\\make_demo.py --preset boxes
"""

import argparse
import glob
import os

from PIL import Image, ImageDraw, ImageFont

try:
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
COMFY = os.path.dirname(os.path.dirname(PKG))

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def load_font(size=20):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def newest(pattern):
    hits = glob.glob(pattern)
    if not hits:
        raise SystemExit("没有匹配到文件：%s（先跑 test_e2e_server.py）" % pattern)
    return max(hits, key=os.path.getmtime)


def preset_panels(name, aabb):
    inp = os.path.join(COMFY, "input", "cx_e2e_input.png")
    out = os.path.join(COMFY, "output")
    if name == "aabb":
        return [(inp, "1. input"),
                (newest(os.path.join(out, "cx_e2e_scrambled_*.png")),
                 "2. CX_RegionScramble  aabb=%s" % aabb),
                (newest(os.path.join(out, "cx_e2e_roundtrip_*.png")),
                 "3. + CX_RegionUnscramble（同 aabb/key）")]
    if name == "meta":
        return [(inp, "1. input（原始图）"),
                (newest(os.path.join(out, "cx_e2e_metascramble_*.png")),
                 "2. 打码图：外扩 8px 边框，区域表写在边框 LSB 里（自带怎么还原）"),
                (newest(os.path.join(out, "cx_e2e_metaback_*.png")),
                 "3. 只给「这张图 + key」还原（未接任何打框数据）")]
    if name == "boxes":
        return [(inp, "1. input"),
                (newest(os.path.join(out, "cx_e2e_segsregion_*.png")),
                 "2. 节点 MASK 输出：实际被打码的块（来自打框数据）"),
                (newest(os.path.join(out, "cx_e2e_segspath_*.png")),
                 "3. CX_RegionScramble  segs=SEGS  region_shape=mask"),
                (newest(os.path.join(out, "cx_e2e_segsback_*.png")),
                 "4. + CX_RegionUnscramble（同一份 SEGS/key）")]
    raise SystemExit("未知预设：%s" % name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preset", default="boxes", choices=["aabb", "boxes", "meta"])
    ap.add_argument("--panel", action="append", default=[], help='\"路径|标题\"，可重复')
    ap.add_argument("--aabb", default="101,57,200,150")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    if args.panel:
        panels = []
        for p in args.panel:
            path, _, label = p.partition("|")
            panels.append((path, label or os.path.basename(path)))
    else:
        panels = preset_panels(args.preset, args.aabb)

    imgs = [(Image.open(p).convert("RGB"), lb) for p, lb in panels]
    pad, bar = 12, 34
    W = max(im.width for im, _ in imgs) + pad * 2
    H = sum(im.height + bar + pad for im, _ in imgs) + pad
    canvas = Image.new("RGB", (W, H), (24, 26, 32))
    draw = ImageDraw.Draw(canvas)
    font = load_font(20)

    cy = pad
    for im, label in imgs:
        draw.text((pad, cy + 6), label, fill=(230, 232, 238), font=font)
        cy += bar
        canvas.paste(im, (pad, cy))
        cy += im.height + pad

    out = args.out or os.path.join(COMFY, "output", "cx_node_demo_%s.png" % args.preset)
    canvas.save(out)
    print("wrote", out, canvas.size)
    for p, lb in panels:
        print("   ", lb, "<-", p)


if __name__ == "__main__":
    main()

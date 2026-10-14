#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检测模型的**回归抽样**脚本：换模型 / 调阈值之后，先看一遍漏检与误报倾向。

为什么不进 CI：它需要真实权重与真实图片（两者都不入库），跑一次几秒到几分钟。
它是给人看的"抽样体检"，不是断言测试 —— 断言在 test/detect/detect-core.test.mjs 里。

与浏览器侧的关系：这里用 **ultralytics 自己的 predict()** 作为参考实现
（同一份参考也用在 fixture 生成与单测对照里），所以结论可以直接和页面上的框互相印证。

用法
----
    # 直接给 .pt 或 .onnx（ultralytics 两种都吃得下）
    python tools/detect-sweep.py --model models/detect/build/foo.int8.onnx --dir D:\\某个图片目录

    # 只看前 20 张、阈值 0.3、并把聚合统计另存一份 JSON
    python tools/detect-sweep.py --model 某模型.pt --dir 图目录 --conf 0.3 --limit 20 --json out.json

输出
----
  · 每张图一行：最大置信度 / 检出数 / 类别分布 / 尺寸（按最大置信度降序）
  · 末尾聚合：有检出张数、零检出张数、分档计数、各类别总命中数
  · --json 只写**聚合统计**（不写逐图文件名），避免把本机素材清单外带
"""

import argparse
import glob
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


def collect_images(d, recursive=False):
    files = []
    if recursive:
        for root, _dirs, names in os.walk(d):
            for n in names:
                if n.lower().endswith(IMG_EXT):
                    files.append(os.path.join(root, n))
    else:
        for e in IMG_EXT:
            files += glob.glob(os.path.join(d, "*" + e))
    return sorted(set(files))


def main():
    ap = argparse.ArgumentParser(description="检测模型回归抽样（漏检/误报倾向 + 阈值敏感性）")
    ap.add_argument("--model", required=True, help=".pt 或 .onnx（构建产物在 models/detect/build/ 下）")
    ap.add_argument("--dir", required=True, help="图片目录")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 张（0 = 全部）")
    ap.add_argument("--recursive", action="store_true", help="递归子目录")
    ap.add_argument("--json", dest="json_out", help="聚合统计落盘路径（只含统计，不含文件名）")
    ap.add_argument("--list-files", action="store_true", help="在输出里显示文件名（默认显示，加 --no-name 可关）")
    ap.add_argument("--no-name", dest="show_name", action="store_false", default=True)
    args = ap.parse_args()

    if not os.path.isfile(args.model):
        print("找不到模型：%s" % args.model, file=sys.stderr)
        return 2
    imgs = collect_images(args.dir, args.recursive)
    if not imgs:
        print("目录里没有图片：%s" % args.dir, file=sys.stderr)
        return 2
    if args.limit:
        imgs = imgs[:args.limit]

    try:
        from ultralytics import YOLO
    except Exception as e:
        print("需要 ultralytics（可把 CX_PYTHON 指到 ComfyUI 自带的解释器）：%s" % e, file=sys.stderr)
        return 3

    model = YOLO(args.model)
    names = dict(model.names or {})
    print("模型 %s（task=%s，%d 类）· 图片 %d 张 · conf=%.2f imgsz=%d\n"
          % (os.path.basename(args.model), getattr(model, "task", "?"), len(names), len(imgs),
             args.conf, args.imgsz))

    rows, cls_total = [], {}
    for i, p in enumerate(imgs, 1):
        try:
            r = model.predict(p, imgsz=args.imgsz, conf=args.conf, verbose=False, device="cpu")[0]
        except Exception as e:
            rows.append((0.0, 0, {}, "读取失败:" + str(e)[:40], p, None))
            continue
        cls_ids = r.boxes.cls.cpu().numpy().astype(int).tolist() if r.boxes is not None else []
        confs = r.boxes.conf.cpu().numpy().tolist() if r.boxes is not None else []
        per = {}
        for c in cls_ids:
            per[str(c)] = per.get(str(c), 0) + 1
            cls_total[str(c)] = cls_total.get(str(c), 0) + 1
        h, w = (r.orig_shape if r.orig_shape else (0, 0))
        rows.append((max(confs) if confs else 0.0, len(cls_ids), per, "", p, "%dx%d" % (w, h)))

    rows.sort(key=lambda t: -t[0])
    for mx, n, per, err, p, size in rows:
        label = ", ".join("%s×%d" % (names.get(int(k), k), v) for k, v in sorted(per.items()))
        name = os.path.basename(p) if args.show_name else "(略)"
        flag = "  ← 零检出" if n == 0 else ("  ← " + err if err else "")
        print("%5.2f  n=%-3d %-9s %-28s %s%s" % (mx, n, size or "?", label, name, flag))

    hit = [r for r in rows if r[1] > 0]
    agg = {
        "model": os.path.basename(args.model),
        "conf": args.conf, "imgsz": args.imgsz,
        "images": len(rows), "images_with_hits": len(hit), "images_zero": len(rows) - len(hit),
        "max_conf_overall": round(max((r[0] for r in rows), default=0.0), 4),
        "conf_buckets": {
            "ge_0.8": len([r for r in rows if r[0] >= 0.8]),
            "0.5_0.8": len([r for r in rows if 0.5 <= r[0] < 0.8]),
            "0.25_0.5": len([r for r in rows if 0.25 <= r[0] < 0.5]),
            "lt_0.25": len([r for r in rows if r[0] < 0.25]),
        },
        "per_class_total": {names.get(int(k), k): v for k, v in sorted(cls_total.items())},
        "note": "只含聚合统计（不落逐图文件名）；本机图与权重均不入库",
    }
    print("\n聚合：%d 张中 %d 张有检出（零检出 %d 张）；最高置信 %.3f"
          % (agg["images"], agg["images_with_hits"], agg["images_zero"], agg["max_conf_overall"]))
    print("分档：≥0.8 %d · 0.5~0.8 %d · 0.25~0.5 %d · <0.25 %d"
          % (agg["conf_buckets"]["ge_0.8"], agg["conf_buckets"]["0.5_0.8"],
             agg["conf_buckets"]["0.25_0.5"], agg["conf_buckets"]["lt_0.25"]))
    if agg["per_class_total"]:
        print("类别命中：" + ", ".join("%s=%d" % (k, v) for k, v in agg["per_class_total"].items()))
    print("\n提示：页面上的默认阈值是 0.30。零检出偏多先看是否阈值过高/构图过小；"
          "误报偏多就看是不是把整个画面都框进了某类。")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(agg, f, ensure_ascii=False, indent=1)
        print("聚合统计已写出：%s" % args.json_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

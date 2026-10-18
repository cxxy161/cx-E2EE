#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 test/detect 用的**真实模型输出** fixture（可复核 / 可重跑）

为什么需要它
------------
自动打框的解码、NMS、跨模型合并这些步骤，如果只用手写的合成张量去测，很容易
"测试和实现一起写错还互相印证"。所以这里用**真模型在真图上的原始输出**做 fixture：

  · 输入：某个检测/分割模型 + 一张图
  · 处理：letterbox 到 640 → onnxruntime 跑一次 → 取原始输出张量 →
          按「最大类别分」降序裁剪到前 K 个锚点（体积从 MB 级降到 KB 级，但仍保留
          真实的重叠框，NMS 与合并才有东西可测）
  · 参考值：用 **ultralytics 自己的 predict()** 算一遍框，作为与被测实现无关的对照
  · 产物：只含数字（W/H、类别表、裁剪后的 preds 的 base64、参考框），**不含图片本身**

因此 fixture 可以入库，而图与权重都不必入库。

用法
----
    python tools/detect-make-fixture.py \
        --model models/detect/bbox/foot_yolov8n.pt \
        --image "D:\\某张干净图.png" \
        --out test/detect/fixtures/bbox-foot-640.json \
        --imgsz 640 --topk 64 --conf 0.05

依赖：ultralytics / onnxruntime / numpy / opencv（与 tools/detect-export.py 相同）。
"""

import argparse
import base64
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def letterbox(im, new=640, color=114):
    import cv2
    import numpy as np
    h, w = im.shape[:2]
    r = min(new / h, new / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    dw, dh = (new - nw) // 2, (new - nh) // 2
    out = np.full((new, new, 3), color, np.uint8)
    out[dh:dh + nh, dw:dw + nw] = cv2.resize(im, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return out, r, dw, dh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help=".pt 或 .onnx（.pt 会现场导出到临时目录）")
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--topk", type=int, default=64)
    ap.add_argument("--conf", type=float, default=0.05, help="裁剪锚点时的低阈值（保证不漏掉真框）")
    ap.add_argument("--ref-conf", type=float, default=0.25, help="参考框用的阈值")
    args = ap.parse_args()

    import cv2
    import numpy as np
    from ultralytics import YOLO

    # 1) 参考值：ultralytics 自己的 predict（与被测实现无关的对照）
    y = YOLO(args.model)
    res = y.predict(args.image, imgsz=args.imgsz, conf=args.ref_conf, verbose=False, device="cpu")[0]
    ref_boxes = res.boxes.xyxy.cpu().numpy().round(2).tolist()
    ref_cls = res.boxes.cls.cpu().numpy().astype(int).tolist()
    ref_conf = res.boxes.conf.cpu().numpy().round(4).tolist()
    names = {str(k): v for k, v in (res.names or {}).items()}

    # 2) 原始输出：自己 letterbox + onnxruntime，拿到未后处理的张量
    onnx = args.model
    if onnx.lower().endswith((".pt", ".pth")):
        tmp = os.path.join(os.path.dirname(os.path.abspath(args.out)) or ".", "_tmp_fixture_export")
        os.makedirs(tmp, exist_ok=True)
        onnx = str(y.export(format="onnx", imgsz=args.imgsz, opset=17, simplify=False,
                            dynamic=False, half=False, device="cpu", verbose=False))
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx, providers=["CPUExecutionProvider"])
    bgr = cv2.imread(args.image, cv2.IMREAD_COLOR)
    H, W = bgr.shape[:2]
    pad, r, dw, dh = letterbox(bgr, args.imgsz)
    x = np.ascontiguousarray((pad[:, :, ::-1].astype(np.float32) / 255).transpose(2, 0, 1)[None])
    outs = sess.run(None, {sess.get_inputs()[0].name: x})
    preds, protos = outs[0], (outs[1] if len(outs) > 1 else None)

    # 3) 按最大类别分裁到前 K 个锚点（保持真实重叠，体积降到 KB 级）
    p = preds[0]                      # [4+nc+numMask, anchors]
    channels, anchors = p.shape
    # numMask：有第二个输出（原型）才是 32，否则纯检测模型是 0 —— 不能用 (C-36) 反推
    numMask = 32 if (protos is not None and channels - 4 - 32 > 0) else 0
    nc = channels - 4 - numMask
    if nc <= 0:
        raise SystemExit("通道数 %d 与 numMask=%d 不匹配，算出的类别数为 %d" % (channels, numMask, nc))
    score = p[4:4 + nc].max(axis=0)
    keep = np.argsort(-score)[:args.topk]
    keep.sort()
    pruned = np.ascontiguousarray(p[:, keep])       # [C, K]
    dims = [1, int(channels), int(len(keep))]

    fixture = {
        "note": "真实模型输出的前 K 个锚点（按最大类别分裁剪）。只含数字，不含图片。"
                "由 tools/detect-make-fixture.py 生成，可重跑复核。",
        "model": os.path.basename(args.model),
        "task": getattr(y, "task", None),
        "imgsz": args.imgsz,
        "image": {"file": os.path.basename(args.image), "W": int(W), "H": int(H)},
        "classes": names,
        "dims": dims,
        "numMask": int(numMask),
        "preds_b64": base64.b64encode(pruned.astype("<f4").tobytes()).decode(),
        "protos": None if protos is None else {"dims": [int(v) for v in protos.shape]},
        "reference": {
            "source": "ultralytics predict(conf=%.2f)" % args.ref_conf,
            "conf": args.ref_conf,
            "boxes": ref_boxes, "classes": ref_cls, "scores": ref_conf,
            "note": "原图坐标；单测里用 IoU 对照被测实现的框，不要求逐位相等（后处理顺序/取整略有差异）",
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, separators=(",", ":"))
    print("写出 %s（%.1f KB，裁剪后 %d 个锚点，参考框 %d 个）"
          % (args.out, os.path.getsize(args.out) / 1024, len(keep), len(ref_boxes)))
    print("参考框：" + json.dumps(list(zip(ref_cls, ref_conf, ref_boxes))[:8], ensure_ascii=False))


if __name__ == "__main__":
    main()

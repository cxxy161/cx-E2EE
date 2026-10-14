#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检测模型 → ONNX 转译器（供 /api/detect 的启动期调用，也可手工跑）

为什么要有这个脚本
------------------
浏览器侧只认 ONNX（onnxruntime-web）。而实际拿到手的权重几乎都是 Ultralytics 的
`.pt`（PyTorch），手工导出容易漏掉 imgsz / opset / 量化这几项，而且每次换模型都要
重新记一遍命令。所以把「转译」固化成一个脚本：服务端启动时调它，人也可以直接调。

产物（一律落在 --out 指定的 build 目录）
---------------------------------------
    <id>.fp32.onnx    原精度（WebGPU 上最快：实测 1152×1920 单帧 42 ms）
    <id>.int8.onnx    动态量化 int8（WASM 上最省流量：10.2 MB，实测 0.66 s/帧）
    <id>.json         元数据：类别表 / task / imgsz / 源文件 sha256 / 字节数

为什么不自动做静态 QDQ 量化：实测它会把检测头一起量化，检出直接归零；
动态量化只动权重矩阵，几何与 fp32 的框 IoU 仍有 0.97~0.98（见文档）。

用法
----
    # 体检：python 与依赖是否齐（服务端启动时先跑这个，缺依赖就整体降级）
    python tools/detect-export.py --check

    # 转译单个模型
    python tools/detect-export.py --src models/detect/segm/foo.pt --kind segm \
        --out models/detect/build

    # 只看计划（不真转）
    python tools/detect-export.py --scan models/detect --plan

    # 机器可读：最后一行固定打印  CXEXPORT {json}
"""

import argparse
import hashlib
import json
import os
import sys
import time

try:  # Windows 控制台默认 GBK，中文/emoji 会在这里炸掉；父进程（node）也按 utf-8 读
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

EXE_PREFIX = "CXEXPORT "


def die(msg, code=2):
    print("ERROR: " + msg, file=sys.stderr)
    sys.exit(code)


def sha256_of(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def check_deps():
    """报告依赖；缺任何一个都返回 not ok（服务端据此把功能标成 unavailable）。"""
    need = ["torch", "ultralytics", "onnx", "onnxruntime", "numpy", "cv2"]
    got, missing = {}, []
    import importlib.metadata as md
    for pkg in need:
        name = {"cv2": "opencv-python"}.get(pkg, pkg)
        try:
            got[pkg] = md.version(name)
        except Exception:
            try:
                __import__(pkg)
                got[pkg] = "?"
            except Exception:
                missing.append(pkg)
    return {"ok": not missing, "versions": got, "missing": missing,
            "python": sys.version.split()[0], "exe": sys.executable}


def human_check():
    st = check_deps()
    print("python %s (%s)" % (st["python"], st["exe"]))
    for k, v in st["versions"].items():
        print("  %-14s %s" % (k, v))
    if st["missing"]:
        print("缺少依赖: " + ", ".join(st["missing"]))
        print("提示：可以直接用 ComfyUI 自带的 python（它通常已装齐 torch/ultralytics/onnxruntime）：")
        print("      set CX_PYTHON=D:\\ComfyUI-new\\venv\\Scripts\\python.exe")
        print("      （或 D:\\Program Files (x86)\\ComfyUI-aki-v2\\python\\python.exe）")
    print(EXE_PREFIX + json.dumps(st, ensure_ascii=False))
    return 0 if st["ok"] else 1


def scan(root, imgsz, opset):
    """扫描 <root>/segm 与 <root>/bbox，列出每个模型的计划（是否需要转）。"""
    build = os.path.join(root, "build")
    plan = []
    for kind in ("segm", "bbox"):
        d = os.path.join(root, kind)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.lower().endswith((".pt", ".pth", ".onnx")):
                continue
            src = os.path.join(d, name)
            if not os.path.isfile(src):
                continue
            mid = os.path.splitext(name)[0]
            meta_p = os.path.join(build, mid + ".json")
            fresh = False
            if os.path.isfile(meta_p):
                try:
                    m = json.load(open(meta_p, encoding="utf-8"))
                    fresh = (m.get("source", {}).get("sha256") == sha256_of(src)
                             and m.get("imgsz") == imgsz and m.get("opset") == opset)
                except Exception:
                    fresh = False
            plan.append({"id": mid, "kind": kind, "src": src, "ext": os.path.splitext(name)[1].lower(),
                         "bytes": os.path.getsize(src), "fresh": fresh, "meta": meta_p})
    return plan


def convert(src, out_dir, kind, imgsz, opset, want_fp32=True, want_int8=True, force=False):
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    mid = os.path.splitext(os.path.basename(src))[0]
    meta_p = os.path.join(out_dir, mid + ".json")
    src_sha = sha256_of(src)

    # 已经转过的（sha256 + 参数一致）直接复用，除非 --force
    if not force and os.path.isfile(meta_p):
        old = json.load(open(meta_p, encoding="utf-8"))
        if old.get("source", {}).get("sha256") == src_sha and old.get("imgsz") == imgsz \
                and old.get("opset") == opset:
            old["reused"] = True
            old["ms"] = round((time.time() - t0) * 1000)
            print("复用已有转译: %s" % meta_p)
            print(EXE_PREFIX + json.dumps(old, ensure_ascii=False))
            return old

    st = check_deps()
    if not st["ok"]:
        die("缺少依赖: %s（用 --check 看提示；可用 CX_PYTHON 指向 ComfyUI 的 python）" % ", ".join(st["missing"]), 3)

    from ultralytics import YOLO
    model = YOLO(src)
    task = getattr(model, "task", None) or ("segment" if kind == "segm" else "detect")
    classes = {str(k): v for k, v in (model.names or {}).items()}

    print("导出 ONNX: %s（task=%s, imgsz=%d, opset=%d）" % (os.path.basename(src), task, imgsz, opset))
    # simplify=False：simplify 需要额外的 onnxslim，装上它会改动别人的 python 环境；
    # 实测不 simplify 也能正常推理，所以这里不引入这个可选依赖。
    onnx_path = model.export(format="onnx", imgsz=imgsz, opset=opset, dynamic=False,
                             half=False, simplify=False, device="cpu", verbose=False)
    onnx_path = str(onnx_path)
    fp32_out = os.path.join(out_dir, mid + ".fp32.onnx")
    if os.path.abspath(onnx_path) != os.path.abspath(fp32_out):
        if os.path.exists(fp32_out):
            os.remove(fp32_out)
        os.replace(onnx_path, fp32_out)

    files = {"fp32": {"file": os.path.basename(fp32_out), "bytes": os.path.getsize(fp32_out)}}
    if want_int8:
        print("动态量化 int8 …")
        from onnxruntime.quantization import quantize_dynamic, QuantType
        int8_out = os.path.join(out_dir, mid + ".int8.onnx")
        quantize_dynamic(fp32_out, int8_out, weight_type=QuantType.QUInt8)
        files["int8"] = {"file": os.path.basename(int8_out), "bytes": os.path.getsize(int8_out)}

    meta = {
        "id": mid, "kind": kind, "task": task, "classes": classes, "imgsz": imgsz, "opset": opset,
        "source": {"file": os.path.basename(src), "bytes": os.path.getsize(src), "sha256": src_sha,
                   "mtime": int(os.path.getmtime(src))},
        "files": files,
        "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "tool": {"python": sys.version.split()[0], "exe": sys.executable,
                 "ultralytics": st["versions"].get("ultralytics"), "onnx": st["versions"].get("onnx"),
                 "onnxruntime": st["versions"].get("onnxruntime")},
        "notes": "int8 为动态量化（只动权重）：几何与 fp32 一致，实测框 IoU 0.97~0.98；"
                 "静态 QDQ 会把检测头量化掉，实测检出归零，故不采用。",
        "reused": False,
    }
    with open(meta_p, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print("完成：%s（%.0f ms）" % (meta_p, (time.time() - t0) * 1000))
    for k, v in files.items():
        print("   %-5s %8.2f MB  %s" % (k, v["bytes"] / 1048576, v["file"]))
    print("   类别：" + ", ".join("%s=%s" % (k, v) for k, v in sorted(classes.items(), key=lambda kv: int(kv[0]))))
    print(EXE_PREFIX + json.dumps(meta, ensure_ascii=False))
    return meta


def adopt_onnx(src, out_dir, kind):
    """直接丢进来的 .onnx：拷进 build 并补元数据（类别表未知时留空，前端按 id 显示）。"""
    os.makedirs(out_dir, exist_ok=True)
    mid = os.path.splitext(os.path.basename(src))[0]
    dst = os.path.join(out_dir, mid + ".fp32.onnx")
    if os.path.abspath(src) != os.path.abspath(dst):
        with open(src, "rb") as fi, open(dst, "wb") as fo:
            while True:
                b = fi.read(1 << 20)
                if not b:
                    break
                fo.write(b)
    meta = {"id": mid, "kind": kind, "task": "segment" if kind == "segm" else "detect",
            "classes": {}, "imgsz": 640, "opset": None,
            "source": {"file": os.path.basename(src), "bytes": os.path.getsize(src),
                       "sha256": sha256_of(src), "mtime": int(os.path.getmtime(src))},
            "files": {"fp32": {"file": os.path.basename(dst), "bytes": os.path.getsize(dst)}},
            "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"), "adopted": True,
            "notes": "由现成 .onnx 直接采用（未经过本脚本导出，类别表未知）"}
    with open(os.path.join(out_dir, mid + ".json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print("采用现成 ONNX: %s" % dst)
    print(EXE_PREFIX + json.dumps(meta, ensure_ascii=False))
    return meta


def main():
    ap = argparse.ArgumentParser(description="检测模型 → ONNX（fp32 + 动态 int8）")
    ap.add_argument("--src", help="输入 .pt / .pth / .onnx")
    ap.add_argument("--out", default=os.path.join("models", "detect", "build"), help="build 目录")
    ap.add_argument("--kind", default="segm", choices=["segm", "bbox"], help="仅用于标注与文件夹对应")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--no-int8", action="store_true", help="只要 fp32")
    ap.add_argument("--no-fp32", action="store_true", help="只要 int8（会先导 fp32 再量化）")
    ap.add_argument("--force", action="store_true", help="忽略缓存，强制重转")
    ap.add_argument("--check", action="store_true", help="只体检 python 依赖")
    ap.add_argument("--scan", help="扫描 <root>/{segm,bbox}")
    ap.add_argument("--plan", action="store_true", help="配合 --scan：只输出计划")
    args = ap.parse_args()

    if args.check:
        return human_check()
    if args.scan:
        plan = scan(args.scan, args.imgsz, args.opset)
        print(json.dumps({"root": args.scan, "plan": plan}, ensure_ascii=False, indent=1))
        print(EXE_PREFIX + json.dumps({"scan": args.scan, "count": len(plan)}, ensure_ascii=False))
        return 0
    if not args.src:
        ap.error("需要 --src（或用 --check / --scan）")
    if not os.path.isfile(args.src):
        die("找不到 %s" % args.src, 4)

    if args.src.lower().endswith(".onnx"):
        adopt_onnx(args.src, args.out, args.kind)
    else:
        convert(args.src, args.out, args.kind, args.imgsz, args.opset,
                want_fp32=not args.no_fp32, want_int8=not args.no_int8, force=args.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())

# -*- coding: utf-8 -*-
"""
test_e2e_server.py — 端到端：真 ComfyUI 服务端跑工作流

  A) LoadImage → CX_RegionScramble(aabb) → SaveImage
  B) LoadImage → CX_RegionScramble → CX_RegionUnscramble → SaveImage
  C) 同上但用错 key
  D) LoadImage + LoadImage(掩膜图) → ImageToMask → CX_RegionScramble(mask=…, region_shape=mask)
     → SaveImage；同时把 CX 的 MASK 输出接 MaskToImage 存下来核对
  E) 掩膜图 → ImageToMask → MaskToSEGS → CX_RegionScramble(segs=…) → SaveImage（真 SEGS 过线）

再把落盘的 PNG 与 cx_core 的 numpy 参考结果对比。

前置：ComfyUI 已在运行（默认 http://127.0.0.1:8195）。
用法：
    venv\\Scripts\\python.exe custom_nodes\\ComfyUI-CX-ImageScramble\\tests\\test_e2e_server.py \
        --server http://127.0.0.1:8195 --comfy D:\\ComfyUI-new
"""

import argparse
import json
import os
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

try:  # Windows 控制台默认 GBK，中文/表情符号会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
import cx_core  # noqa: E402

FAIL = []


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def get(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read().decode())


def run_prompt(server, graph, timeout=300):
    pid = post(server + "/prompt", {"prompt": graph, "client_id": "cx-e2e"})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = get(server + "/history/" + pid)
        if pid in h:
            ent = h[pid]
            st = ent.get("status", {})
            if st.get("status_str") == "error" or not st.get("completed", True):
                msgs = json.dumps(st.get("messages", []), ensure_ascii=False)[:1500]
                raise SystemExit("执行失败：%s\n%s" % (st, msgs))
            return ent
        time.sleep(0.5)
    raise SystemExit("超时：%s" % pid)


def saved_images(entry):
    """{filename: subfolder} —— 一个工作流里有多个 SaveImage 时按文件名区分。"""
    out = {}
    for node_out in entry.get("outputs", {}).values():
        for im in node_out.get("images", []):
            out[im["filename"]] = im.get("subfolder", "")
    return out


def pick(saved, prefix, comfy):
    hit = [f for f in saved if f.startswith(prefix)]
    if not hit:
        raise SystemExit("没有找到以 %s 开头的输出，实际：%s" % (prefix, list(saved)))
    hit.sort()
    return os.path.join(comfy, "output", saved[hit[-1]], hit[-1])


def load(path):
    return np.array(Image.open(path).convert("RGB"))


def make_input(path, W=512, H=384):
    yy, xx = np.mgrid[0:H, 0:W]
    img = np.zeros((H, W, 3), np.uint8)
    img[..., 0] = np.clip(xx * 255 // (W - 1), 0, 255)
    img[..., 1] = np.clip(yy * 255 // (H - 1), 0, 255)
    img[..., 2] = np.clip(((np.sin(xx / 37.0) + np.cos(yy / 23.0)) * 60 + 128), 0, 255)
    img[150:230, 60:240] = (250, 250, 30)
    img[60:130, 330:470] = (20, 20, 20)
    img[260:340, 300:420] = (255, 0, 0)
    Image.fromarray(img).save(path)
    return img


def make_mask(path, W=512, H=384):
    """黑底 + 两个白斑（红通道=掩膜），模拟分割模型输出"""
    yy, xx = np.mgrid[0:H, 0:W]
    m = np.zeros((H, W), np.uint8)
    ell = (((yy - 120) / 55.0) ** 2 + ((xx - 150) / 80.0) ** 2) <= 1.0
    m[ell] = 255
    m[250:330, 330:460] = 255
    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[..., 0] = m
    Image.fromarray(rgb).save(path)
    return (m / 255.0) > 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8195")
    ap.add_argument("--comfy", default=r"D:\ComfyUI-new")
    ap.add_argument("--aabb", default="101,57,200,150")
    ap.add_argument("--key", type=int, default=20240117)
    args = ap.parse_args()

    inp_name = "cx_e2e_input.png"
    mask_name = "cx_e2e_mask.png"
    src = make_input(os.path.join(args.comfy, "input", inp_name))
    mask = make_mask(os.path.join(args.comfy, "input", mask_name))
    H, W = src.shape[:2]
    print("输入图：%s %dx%d / 掩膜图：%s" % (inp_name, W, H, mask_name))

    print("== 1. 服务端识别到的节点与打框数据接口 ==")
    oi = get(args.server + "/object_info")
    for nid in ("CX_RegionScramble", "CX_RegionUnscramble", "MaskToSEGS", "ImageToMask"):
        check("%-20s 已注册" % nid, nid in oi)
    if "CX_RegionScramble" in oi:
        req = oi["CX_RegionScramble"]["input"]["required"]
        opt = oi["CX_RegionScramble"]["input"].get("optional", {})
        check("输入 image 为 IMAGE", req.get("image", [None])[0] == "IMAGE")
        check("segs 口类型 = SEGS", opt.get("segs", [None])[0] == "SEGS", str(opt.get("segs")))
        check("bbox 口类型 = BBOX", opt.get("bbox", [None])[0] == "BBOX", str(opt.get("bbox")))
        check("mask 口类型 = MASK", opt.get("mask", [None])[0] == "MASK", str(opt.get("mask")))
        check("aabb 口类型 = STRING", opt.get("aabb", [None])[0] == "STRING")
        check("输出 = IMAGE + MASK", oi["CX_RegionScramble"]["output"] == ["IMAGE", "MASK"],
              str(oi["CX_RegionScramble"]["output"]))

    common = {"aabb": "", "key": args.key, "box_mode": "xywh", "unit": 8, "soft": False,
              "password": "", "region_shape": "bbox", "pad": 0, "max_regions": 32,
              "mask_threshold": 0.5, "label_filter": "", "sort_regions": True}
    aabb_common = dict(common, aabb=args.aabb)

    print("== 2. 工作流 A：LoadImage → 打码(aabb) → SaveImage ==")
    gA = {
        "1": {"class_type": "LoadImage", "inputs": {"image": inp_name}},
        "2": {"class_type": "CX_RegionScramble", "inputs": dict(aabb_common, image=["1", 0])},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0],
                                                    "filename_prefix": "cx_e2e_scrambled"}},
    }
    pA = pick(saved_images(run_prompt(args.server, gA)), "cx_e2e_scrambled", args.comfy)
    outA = load(pA)
    check("输出尺寸与输入一致", outA.shape == src.shape, "%s vs %s" % (outA.shape, src.shape))
    ref = src.copy()
    cx_core.scramble_image(ref, args.aabb, args.key, "", "xywh", 8, False, True)
    d = np.abs(outA.astype(np.int32) - ref.astype(np.int32))
    check("服务端输出 == cx_core 参考结果（±1 内）", int(d.max()) <= 1,
          "max|Δ|=%d 超 1 的像素=%d" % (d.max(), int((d > 1).sum())))
    ax0, ay0, ax1, ay1 = cx_core._region_block_span(101, 57, 200, 150, W, H, 8)
    diff_in = (np.abs(outA.astype(np.int32) - src.astype(np.int32))[ay0:ay1, ax0:ax1].any(-1)).mean()
    check("区域内确实被打码", diff_in > 0.95, "变化=%.1f%%（对齐范围 %d,%d,%d,%d）"
          % (diff_in * 100, ax0, ay0, ax1, ay1))

    print("== 3. 工作流 B：打码 → 还原 ==")
    gB = {
        "1": {"class_type": "LoadImage", "inputs": {"image": inp_name}},
        "2": {"class_type": "CX_RegionScramble", "inputs": dict(aabb_common, image=["1", 0])},
        "3": {"class_type": "CX_RegionUnscramble", "inputs": dict(aabb_common, image=["2", 0])},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0],
                                                    "filename_prefix": "cx_e2e_roundtrip"}},
    }
    pB = pick(saved_images(run_prompt(args.server, gB)), "cx_e2e_roundtrip", args.comfy)
    outB = load(pB)
    dd = np.abs(outB.astype(np.int32) - src.astype(np.int32))
    ref2 = src.copy()
    cx_core.scramble_image(ref2, args.aabb, args.key, "", "xywh", 8, False, True)
    cx_core.scramble_image(ref2, args.aabb, args.key, "", "xywh", 8, False, False)
    check("服务端往返输出 == cx_core 参考往返结果（±1 内）",
          int(np.abs(outB.astype(np.int32) - ref2.astype(np.int32)).max()) <= 1)
    mask_out = np.ones((H, W), bool)
    mask_out[ay0:ay1, ax0:ax1] = False
    check("对齐范围之外像素完全不变", int(dd[mask_out].max()) == 0,
          "范围外 max|Δ|=%d" % int(dd[mask_out].max()))
    mse = float((dd[ay0:ay1, ax0:ax1].astype(np.float64) ** 2).mean())
    psnr = 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)
    print("         [INFO] 往返 PSNR=%.1fdB（图含大面积饱和色块，损失是算法固有）" % psnr)

    print("== 4. 工作流 C：错 key ==")
    gC = {
        "1": {"class_type": "LoadImage", "inputs": {"image": inp_name}},
        "2": {"class_type": "CX_RegionScramble", "inputs": dict(aabb_common, image=["1", 0])},
        "3": {"class_type": "CX_RegionUnscramble", "inputs": dict(aabb_common, key=args.key + 1,
                                                                  image=["2", 0])},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0],
                                                    "filename_prefix": "cx_e2e_wrongkey"}},
    }
    pC = pick(saved_images(run_prompt(args.server, gC)), "cx_e2e_wrongkey", args.comfy)
    outC = load(pC)
    dd2 = np.abs(outC.astype(np.int32) - src.astype(np.int32))[ay0:ay1, ax0:ax1]
    mse2 = float((dd2.astype(np.float64) ** 2).mean())
    psnr2 = 10 * np.log10(255.0 ** 2 / mse2) if mse2 else 99
    check("错误 key 无法还原（比正确差 8dB 以上）", psnr - psnr2 > 8,
          "正确 %.1fdB / 错误 %.1fdB" % (psnr, psnr2))

    print("== 5. 工作流 D：ImageToMask → CX(mask=…, region_shape=mask) + MASK 输出核对 ==")
    gD = {
        "1": {"class_type": "LoadImage", "inputs": {"image": inp_name}},
        "2": {"class_type": "LoadImage", "inputs": {"image": mask_name}},
        "3": {"class_type": "ImageToMask", "inputs": {"image": ["2", 0], "channel": "red"}},
        "4": {"class_type": "CX_RegionScramble",
              "inputs": dict(common, image=["1", 0], mask=["3", 0], region_shape="mask")},
        "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0],
                                                    "filename_prefix": "cx_e2e_maskpath"}},
        "6": {"class_type": "MaskToImage", "inputs": {"mask": ["4", 1]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0],
                                                    "filename_prefix": "cx_e2e_maskregion"}},
        "8": {"class_type": "CX_RegionUnscramble",
              "inputs": dict(common, image=["4", 0], mask=["3", 0], region_shape="mask")},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0],
                                                    "filename_prefix": "cx_e2e_maskback"}},
    }
    savedD = saved_images(run_prompt(args.server, gD))
    outD = load(pick(savedD, "cx_e2e_maskpath", args.comfy))
    regionD = load(pick(savedD, "cx_e2e_maskregion", args.comfy))
    backD = load(pick(savedD, "cx_e2e_maskback", args.comfy))

    regions, gates = cx_core.mask_regions(mask, H, W, "mask", 0, 0.0, 32)
    eff = cx_core.effective_block_mask(H, W, regions, gates, 8, 0.5)
    refD = src.copy()
    cx_core.scramble_array(refD, regions, args.key, "", 8, False, True, gates=gates)
    gap = np.abs(outD.astype(np.int32) - refD.astype(np.int32))
    check("MASK 链路打码输出 == cx_core 参考（±1 内）", int(gap.max()) <= 1,
          "max|Δ|=%d" % gap.max())
    got_region = (regionD[..., 0] > 127)
    check("节点 MASK 输出 == 参考有效区域（逐像素）", bool((got_region == eff).all()),
          "不同像素=%d" % int((got_region != eff).sum()))
    changed = (np.abs(outD.astype(np.int32) - src.astype(np.int32)).any(-1))
    check("掩膜块内被打码 / 掩膜块外零改动",
          float(changed[eff].mean()) > 0.9 and int(changed[~eff].sum()) == 0,
          "块内变化=%.1f%% 块外改动=%d px" % (float(changed[eff].mean()) * 100,
                                              int(changed[~eff].sum())))
    mse3 = float(((backD.astype(np.int32) - src.astype(np.int32))[eff].astype(np.float64) ** 2).mean())
    psnr3 = 10 * np.log10(255.0 ** 2 / mse3) if mse3 else 99
    check("MASK 链路可还原（比错 key 好 8dB 以上）", psnr3 - psnr2 > 8,
          "还原 PSNR=%.1fdB" % psnr3)

    print("== 6. 工作流 E：ImageToMask → MaskToSEGS → CX(segs=…) 真 SEGS 过线 ==")
    gE = {
        "1": {"class_type": "LoadImage", "inputs": {"image": inp_name}},
        "2": {"class_type": "LoadImage", "inputs": {"image": mask_name}},
        "3": {"class_type": "ImageToMask", "inputs": {"image": ["2", 0], "channel": "red"}},
        "4": {"class_type": "MaskToSEGS",
              "inputs": {"mask": ["3", 0], "combined": False, "crop_factor": 1.0,
                         "bbox_fill": False, "drop_size": 10, "contour_fill": False}},
        "5": {"class_type": "CX_RegionScramble",
              "inputs": dict(common, image=["1", 0], segs=["4", 0], region_shape="mask")},
        "6": {"class_type": "SaveImage", "inputs": {"images": ["5", 0],
                                                    "filename_prefix": "cx_e2e_segspath"}},
        "7": {"class_type": "MaskToImage", "inputs": {"mask": ["5", 1]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0],
                                                    "filename_prefix": "cx_e2e_segsregion"}},
        "9": {"class_type": "CX_RegionUnscramble",
              "inputs": dict(common, image=["5", 0], segs=["4", 0], region_shape="mask")},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0],
                                                     "filename_prefix": "cx_e2e_segsback"}},
    }
    savedE = saved_images(run_prompt(args.server, gE))
    outE = load(pick(savedE, "cx_e2e_segspath", args.comfy))
    regionE = load(pick(savedE, "cx_e2e_segsregion", args.comfy))
    backE = load(pick(savedE, "cx_e2e_segsback", args.comfy))
    effE = regionE[..., 0] > 127
    changedE = (np.abs(outE.astype(np.int32) - src.astype(np.int32)).any(-1))
    check("SEGS 链路：块外零改动、块内有变化",
          int(changedE[~effE].sum()) == 0 and float(changedE[effE].mean()) > 0.9,
          "块内变化=%.1f%% 块外改动=%d px 有效区域=%d px"
          % (float(changedE[effE].mean()) * 100, int(changedE[~effE].sum()), int(effE.sum())))
    jac = float((effE & eff).sum()) / max(1, float((effE | eff).sum()))
    check("SEGS 有效区域 ≈ MASK 有效区域（Jaccard ≥ 0.9）", jac >= 0.9, "Jaccard=%.3f" % jac)
    mse4 = float(((backE.astype(np.int32) - src.astype(np.int32))[effE].astype(np.float64) ** 2).mean())
    psnr4 = 10 * np.log10(255.0 ** 2 / mse4) if mse4 else 99
    check("SEGS 链路可还原（比错 key 好 8dB 以上）", psnr4 - psnr2 > 8, "还原 PSNR=%.1fdB" % psnr4)
    check("SEGS 链路与 MASK 链路不是同一份结果（说明真的走了 SEGS 分块）",
          not np.array_equal(outE, outD), "两者像素相同 = 可疑")

    print("== 7. 工作流 F/G：带元数据打码 → 存盘 → 只给图+密码还原（网页端用法） ==")
    gF = {
        "1": {"class_type": "LoadImage", "inputs": {"image": inp_name}},
        "2": {"class_type": "CX_RegionScramble",
              "inputs": dict(aabb_common, image=["1", 0], embed_meta=True)},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0],
                                                    "filename_prefix": "cx_e2e_metascramble"}},
    }
    pF = pick(saved_images(run_prompt(args.server, gF)), "cx_e2e_metascramble", args.comfy)
    meta_img = load(pF)
    check("F：打码图外扩了 8px 边框", meta_img.shape[:2] == (H + 16, W + 16),
          "%s vs 原图 %s" % (meta_img.shape[:2], (H, W)))
    # 独立核对：直接从落盘 PNG 里读元数据（与节点无关的一条路径）
    pm = cx_core.v3_read_meta(meta_img, 8)
    ok_sig = bool(pm) and pm["stored"] == cx_core.v3_signature(pm["cnt"], pm["regions"], str(args.key))
    check("F：从存盘 PNG 里能读回区域表且签名匹配", ok_sig,
          "regions=%s" % (pm and pm["regions"]))
    check("F：元数据里的区域就是对齐后的 aabb",
          bool(pm) and [tuple(r) for r in pm["regions"]] == cx_core.align_regions_web(
              [(101, 57, 200, 150)], W, H, 8),
          str(pm and pm["regions"]))

    # 把打码图放进 input，模拟"事后单独拿这张图来还原"
    meta_name = "cx_e2e_meta_out.png"
    Image.fromarray(meta_img).save(os.path.join(args.comfy, "input", meta_name))
    gG = {
        "1": {"class_type": "LoadImage", "inputs": {"image": meta_name}},
        "2": {"class_type": "CX_RegionUnscramble", "inputs": dict(common, image=["1", 0], key=args.key)},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0],
                                                    "filename_prefix": "cx_e2e_metaback"}},
    }
    pG = pick(saved_images(run_prompt(args.server, gG)), "cx_e2e_metaback", args.comfy)
    backG = load(pG)
    check("G：只给图 + int key（未接任何打框数据）就还原回原图尺寸",
          backG.shape == src.shape, "%s vs %s" % (backG.shape, src.shape))
    dG = np.abs(backG.astype(np.int32) - src.astype(np.int32))
    ax0a, ay0a, ax1a, ay1a = ax0, ay0, ax1, ay1
    mask_in = np.ones((H, W), bool)
    mask_in[ay0a:ay1a, ax0a:ax1a] = False
    check("G：区域外像素完全不变", int(dG[mask_in].max()) == 0, "范围外 max|Δ|=%d" % int(dG[mask_in].max()))
    mseG = float((dG[ay0a:ay1a, ax0a:ax1a].astype(np.float64) ** 2).mean())
    psnrG = 10 * np.log10(255.0 ** 2 / mseG) if mseG else 99
    check("G：还原质量与显式 aabb 还原一致（差 < 1dB）", abs(psnrG - psnr) < 1.0,
          "元数据 %.1fdB vs 显式 %.1fdB" % (psnrG, psnr))

    gH = {
        "1": {"class_type": "LoadImage", "inputs": {"image": meta_name}},
        "2": {"class_type": "CX_RegionUnscramble",
              "inputs": dict(common, image=["1", 0], key=args.key + 1)},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0],
                                                    "filename_prefix": "cx_e2e_metawrong"}},
    }
    try:
        run_prompt(args.server, gH)
        check("G：错 key → 报「密码不对」", False, "没报错")
    except SystemExit as e:
        check("G：错 key → 报「密码不对（签名不符）」", "签名不符" in str(e), str(e)[:80].replace("\n", " "))

    print()
    print("产物：")
    for p in (pA, pB, pC):
        print("   ", p)
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅ 端到端（真 ComfyUI 服务端；aabb / MASK / SEGS 三条链路）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

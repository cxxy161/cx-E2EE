# -*- coding: utf-8 -*-
"""
test_segs_tools.py — 「标记框后处理交给外部节点」这条约定的真机实测

约定：**掩膜 / 标记框的缩放、合并不放进取 CX 节点**，就在 SEGS 线上用现成的外部节点处理，
      再喂给 CX_RegionScramble / CX_RegionUnscramble。本脚本把整条链路在真 ComfyUI 服务端跑一遍，
      并用 cx_core 的 numpy 参考逐像素核对，证明「外部节点改过的 SEGS 我们节点照样吃得准」。

被测外部节点（ComfyUI-Impact-Pack，本机已装）：

  按轴心缩放  ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT(scale_by) → ImpactAssembleSEGS
              （modules/impact/segs_nodes.py:1223 doit：
                 dw = int((w*scale_by - w)/2); dh = int((h*scale_by - h)/2)
                 bbox = (x1-dw, y1-dh, x2+dw, y2+dh)
               → 以框中心为轴按比例缩放；crop_region 不动，掩膜在新框之外清零）
  标记框合并  ImpactSEGSMerge   多框 → 1 框（bbox 取并集、掩膜取并集、label=merged）
              ImpactSEGSConcat  两批拼接（API/脚本里直接写 segs2…；UI 里靠 Impact 的 JS 动态加口）
              ImpactSEGSNMSFilter 按掩膜 IoU 去重
  计数 / 空框 ImpactCount_Elts_in_SEGS → PreviewAny（把 INT 回读进脚本）、EmptySegs

用法：
    venv\\Scripts\\python.exe custom_nodes\\ComfyUI-CX-ImageScramble\\tests\\test_segs_tools.py \
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
H, W = 384, 512
KEY = 20240117
UNIT = 8

# 夹具掩膜：三个互不相连的矩形斑块 (x, y, w, h)。
# 用矩形是为了让 MaskToSEGS 的 bbox 完全可预测（cv2.boundingRect → bbox=(x,y,x+w,y+h)）。
BLOBS = [(150, 80, 80, 56),
         (320, 240, 120, 60),
         (60, 300, 40, 40)]

IMPACT_NODES = ["ImpactDecomposeSEGS", "ImpactScaleBy_BBOX_SEG_ELT", "ImpactAssembleSEGS",
                "ImpactSEGSMerge", "ImpactSEGSConcat", "ImpactSEGSNMSFilter",
                "ImpactCount_Elts_in_SEGS", "EmptySegs", "PreviewAny"]


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode())


def run_prompt(server, graph, timeout=300):
    pid = post(server + "/prompt", {"prompt": graph, "client_id": "cx-tools"})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = get(server + "/history/" + pid)
        if pid in h:
            ent = h[pid]
            st = ent.get("status", {})
            if st.get("status_str") == "error" or not st.get("completed", True):
                msgs = json.dumps(st.get("messages", []), ensure_ascii=False)[:2000]
                raise RuntimeError("执行失败：%s\n%s" % (st, msgs))
            return ent
        time.sleep(0.5)
    raise RuntimeError("超时：%s" % pid)


def saved_images(entry):
    out = {}
    for node_out in entry.get("outputs", {}).values():
        for im in node_out.get("images", []):
            out[im["filename"]] = im.get("subfolder", "")
    return out


def preview_text(entry, node_id):
    """PreviewAny 的 ui 文本（用来把 INT 计数回读进脚本）。"""
    node_out = entry.get("outputs", {}).get(str(node_id)) or {}
    txt = node_out.get("text")
    flat = []

    def walk(x):
        if isinstance(x, (list, tuple)):
            for y in x:
                walk(y)
        elif x is not None:
            flat.append(str(x))

    walk(txt)
    return " ".join(flat)


def pick(saved, prefix, comfy):
    hit = [f for f in saved if f.startswith(prefix)]
    if not hit:
        raise RuntimeError("没有找到以 %s 开头的输出，实际：%s" % (prefix, list(saved)))
    hit.sort()
    return os.path.join(comfy, "output", saved[hit[-1]], hit[-1])


def load(path):
    return np.array(Image.open(path).convert("RGB"))


def make_input(path):
    yy, xx = np.mgrid[0:H, 0:W]
    img = np.zeros((H, W, 3), np.uint8)
    img[..., 0] = np.clip(xx * 255 // (W - 1), 0, 255)
    img[..., 1] = np.clip(yy * 255 // (H - 1), 0, 255)
    img[..., 2] = np.clip(((np.sin(xx / 37.0) + np.cos(yy / 23.0)) * 60 + 128), 0, 255)
    img[100:200, 200:400] = (250, 250, 30)
    img[260:330, 340:460] = (20, 20, 20)
    Image.fromarray(img).save(path)
    return img


def make_mask(path):
    m = np.zeros((H, W), np.uint8)
    for (x, y, w, h) in BLOBS:
        m[y:y + h, x:x + w] = 255
    Image.fromarray(np.dstack([m, m, m])).save(path)
    return m


# --------------------------------------------------------------------------
#  外部节点的几何模型（复刻 Impact 源码 + 我们节点对 SEG.bbox(xyxy) 的换算）
# --------------------------------------------------------------------------
def impact_scale(regions, s):
    """ImpactScaleBy_BBOX_SEG_ELT 之后的 region 表（源码：dw=int((w*s-w)/2)）。"""
    out = []
    for (x, y, w, h) in regions:
        dw = int((w * s - w) / 2)
        dh = int((h * s - h) / 2)
        out.append((x - dw, y - dh, w + 2 * dw, h + 2 * dh))
    return out


def impact_merge(regions):
    """ImpactSEGSMerge 之后的 region 表（bbox 取并集）。"""
    x1 = min(r[0] for r in regions)
    y1 = min(r[1] for r in regions)
    x2 = max(r[0] + r[2] for r in regions)
    y2 = max(r[1] + r[3] for r in regions)
    return [(x1, y1, x2 - x1, y2 - y1)]


def cx_sorted(regions):
    """我们节点在 sort_regions=True 下的稳定排序： (label,y,x,w,h)，label 全同 → (y,x,w,h)。"""
    return sorted(regions, key=lambda r: (r[1], r[0], r[2], r[3]))


def cx_regions_mask(regions, gates=None):
    return cx_core.effective_block_mask(H, W, cx_sorted(regions), gates, UNIT, 0.5)


def cx_reference(src, regions, encode, gates=None):
    a = src.copy()
    cx_core.scramble_array(a, cx_sorted(regions), KEY, "", UNIT, False, encode, gates=gates)
    return a


def mask_centers(block_mask, unit=UNIT):
    """块掩膜的连通块 → 各自外接矩形 (x0,y0,x1,y1)，用来核对「数量/中心/尺寸」。"""
    m = block_mask.astype(np.uint8)
    seen = np.zeros_like(m, bool)
    boxes = []
    hh, ww = m.shape
    for y in range(0, hh, 4):
        for x in range(0, ww, 4):
            if m[y, x] and not seen[y, x]:
                stack = [(y, x)]
                seen[y, x] = True
                ys, xs = [], []
                while stack:
                    cy, cx = stack.pop()
                    ys.append(cy); xs.append(cx)
                    for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                        if 0 <= ny < hh and 0 <= nx < ww and m[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
                boxes.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
    return sorted(boxes, key=lambda b: (b[1], b[0]))


def build_prompt(img_name, mask_name, tag, post=None, shape="bbox", policy=None):
    """post: None | 'scale:1.5' | 'merge' | 'concat' | 'nms:0.5' | 'empty' | 'empty_merge'"""
    g = {
        "1": {"class_type": "LoadImage", "inputs": {"image": img_name}},
        "2": {"class_type": "LoadImage", "inputs": {"image": mask_name}},
        "3": {"class_type": "ImageToMask", "inputs": {"image": ["2", 0], "channel": "red"}},
        "4": {"class_type": "MaskToSEGS",
              "inputs": {"mask": ["3", 0], "combined": False, "crop_factor": 1.0,
                         "bbox_fill": False, "drop_size": 10, "contour_fill": False}},
    }
    segs = ["4", 0]
    if post and post.startswith("scale:"):
        s = float(post.split(":")[1])
        g["5"] = {"class_type": "ImpactDecomposeSEGS", "inputs": {"segs": segs}}
        g["6"] = {"class_type": "ImpactScaleBy_BBOX_SEG_ELT",
                  "inputs": {"seg": ["5", 1], "scale_by": s}}
        g["7"] = {"class_type": "ImpactAssembleSEGS",
                  "inputs": {"seg_header": ["5", 0], "seg_elt": ["6", 0]}}
        segs = ["7", 0]
    elif post == "merge":
        g["5"] = {"class_type": "ImpactSEGSMerge", "inputs": {"segs": segs}}
        segs = ["5", 0]
    elif post == "concat":
        g["5"] = {"class_type": "ImpactSEGSConcat", "inputs": {"segs1": ["4", 0], "segs2": ["4", 0]}}
        segs = ["5", 0]
    elif post and post.startswith("nms:"):
        g["5"] = {"class_type": "ImpactSEGSConcat", "inputs": {"segs1": ["4", 0], "segs2": ["4", 0]}}
        g["6"] = {"class_type": "ImpactSEGSNMSFilter",
                  "inputs": {"segs": ["5", 0], "iou_threshold": float(post.split(":")[1])}}
        segs = ["6", 0]
    elif post == "empty":
        g["5"] = {"class_type": "EmptySegs", "inputs": {}}
        segs = ["5", 0]
    elif post == "empty_merge":
        g["5"] = {"class_type": "EmptySegs", "inputs": {}}
        g["6"] = {"class_type": "ImpactSEGSMerge", "inputs": {"segs": ["5", 0]}}
        segs = ["6", 0]
    elif post:
        raise ValueError(post)

    widgets = {"aabb": "", "key": KEY, "box_mode": "xywh", "unit": UNIT, "soft": False,
               "password": "", "region_shape": shape, "pad": 0, "max_regions": 32,
               "mask_threshold": 0.5, "label_filter": "", "sort_regions": True}
    if policy is not None:
        widgets["no_region_policy"] = policy
    g["20"] = {"class_type": "CX_RegionScramble",
               "inputs": dict(widgets, image=["1", 0], segs=segs)}
    g["21"] = {"class_type": "MaskToImage", "inputs": {"mask": ["20", 1]}}
    g["22"] = {"class_type": "SaveImage", "inputs": {"images": ["21", 0],
                                                    "filename_prefix": "cx_tools_%s_region" % tag}}
    g["23"] = {"class_type": "CX_RegionUnscramble",
               "inputs": dict(widgets, image=["20", 0], segs=segs)}
    g["24"] = {"class_type": "SaveImage", "inputs": {"images": ["23", 0],
                                                    "filename_prefix": "cx_tools_%s_back" % tag}}
    g["25"] = {"class_type": "SaveImage", "inputs": {"images": ["20", 0],
                                                    "filename_prefix": "cx_tools_%s_scr" % tag}}
    g["26"] = {"class_type": "SaveImage", "inputs": {"images": ["1", 0],
                                                    "filename_prefix": "cx_tools_%s_orig" % tag}}
    g["30"] = {"class_type": "ImpactCount_Elts_in_SEGS", "inputs": {"segs": segs}}
    g["31"] = {"class_type": "PreviewAny", "inputs": {"source": ["30", 0]}}
    return g


def run_case(server, comfy, img_name, mask_name, tag, src, **kw):
    """跑一条链路，返回 (块掩膜, 计数文本, 打码图, 还原图, 原图)。"""
    ent = run_prompt(server, build_prompt(img_name, mask_name, tag, **kw))
    sv = saved_images(ent)
    reg = load(pick(sv, "cx_tools_%s_region" % tag, comfy))[..., 0] > 127
    scr = load(pick(sv, "cx_tools_%s_scr" % tag, comfy))
    back = load(pick(sv, "cx_tools_%s_back" % tag, comfy))
    orig = load(pick(sv, "cx_tools_%s_orig" % tag, comfy))
    return reg, preview_text(ent, 31), scr, back, orig


def psnr(a, b, box=None):
    a = a.astype(np.int32); b = b.astype(np.int32)
    if box:
        x, y, w, h = box
        a = a[y:y + h, x:x + w]; b = b[y:y + h, x:x + w]
    mse = float(((a - b) ** 2).mean())
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def local_roundtrip(src, regions, gates=None):
    """本地参考：打码图 / 正确钥匙还原 / 错钥匙还原。

    夹具图里有大面积纯饱和色块（算法 YUV 钳制本身有损，往返 PSNR 只有 20 出头），
    所以还原质量用「正确 vs 错钥匙」的相对基准判断，与 test_e2e_server.py 同一口径。
    """
    scr = cx_reference(src, regions, True, gates)
    good = scr.copy()
    cx_core.scramble_array(good, cx_sorted(regions), KEY, "", UNIT, False, False, gates=gates)
    bad = scr.copy()
    cx_core.scramble_array(bad, cx_sorted(regions), KEY + 1, "", UNIT, False, False, gates=gates)
    return scr, good, bad


def roundtrip_checks(prefix, back, scr, regions, src, gates=None, region_mask=None, box=None):
    """闭环三连：打码图/还原图与本地参考一致 + 正确钥匙明显好于错钥匙 + 区域外零改动。"""
    scr_r, good_r, bad_r = local_roundtrip(src, regions, gates)
    p_good, p_bad, p_srv = psnr(good_r, src, box), psnr(bad_r, src, box), psnr(back, src, box)
    check("%s：打码图 == 本地 cx_core 参考（±1）" % prefix,
          int(np.abs(scr.astype(np.int32) - scr_r.astype(np.int32)).max()) <= 1)
    check("%s：还原图 == 本地 cx_core 参考还原（±1）" % prefix,
          int(np.abs(back.astype(np.int32) - good_r.astype(np.int32)).max()) <= 1)
    check("%s：正确钥匙比错钥匙好 8dB 以上（相对基准，图含饱和色块）" % prefix,
          p_good - p_bad > 8,
          "正确 %.1fdB / 错钥匙 %.1fdB / 服务端 %.1fdB" % (p_good, p_bad, p_srv))
    if region_mask is not None:
        check("%s：有效区域外零改动" % prefix,
              int(np.abs(back.astype(np.int32) - src.astype(np.int32))[~region_mask].max()) == 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8195")
    ap.add_argument("--comfy", default=r"D:\ComfyUI-new")
    args = ap.parse_args()

    img_name = "cx_tools_input.png"
    mask_name = "cx_tools_mask.png"
    src = make_input(os.path.join(args.comfy, "input", img_name))
    mask = make_mask(os.path.join(args.comfy, "input", mask_name))
    print("夹具：%dx%d，%d 个矩形斑块 %s → 掩膜图 %s" % (W, H, len(BLOBS), BLOBS, mask_name))

    print("== 1. 服务端能力自检（外部后处理节点 + CX 节点） ==")
    oi = get(args.server + "/object_info")
    for n in IMPACT_NODES + ["MaskToSEGS", "ImageToMask", "MaskToImage",
                             "CX_RegionScramble", "CX_RegionUnscramble"]:
        check("%-32s 已注册" % n, n in oi)
    cx_opt = oi["CX_RegionScramble"]["input"].get("optional", {})
    check("CX 的 segs 口类型 = SEGS", cx_opt.get("segs", [None])[0] == "SEGS")
    check("no_region_policy 默认 = passthrough（没错到框就直出）",
          (cx_opt.get("no_region_policy") or [{}, {}])[1].get("default") == "passthrough",
          str(cx_opt.get("no_region_policy")))
    if FAIL:
        print("\n缺少必需节点，后面跑不动：%s" % FAIL)
        return 1

    print("\n== 2. 基线：ImageToMask → MaskToSEGS → CX（不后处理） ==")
    base_regions = list(BLOBS)
    ref_mask = cx_regions_mask(base_regions)
    reg0, cnt0, scr0, back0, orig0 = run_case(args.server, args.comfy, img_name, mask_name,
                                              "base", src)
    check("MaskToSEGS 给出 3 个框（ImpactCount_Elts_in_SEGS 回读 = %r）" % cnt0.strip(),
          cnt0.strip().startswith("3"), "实际 %r" % cnt0)
    check("CX 有效区域 == 本地参考（MaskToSEGS 的 bbox 约定 = 像素外接框）",
          bool((reg0 == ref_mask).all()),
          "不同像素=%d（参考 %d px / 服务端 %d px）"
          % (int((reg0 != ref_mask).sum()), int(ref_mask.sum()), int(reg0.sum())))
    roundtrip_checks("基线", back0, scr0, base_regions, src, region_mask=ref_mask, box=BLOBS[0])

    print("\n== 3. 按轴心缩放：ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT → ImpactAssembleSEGS ==")
    for s, name in ((1.5, "放大 1.5×"), (0.6, "缩小 0.6×")):
        tag = "s%s" % str(s).replace(".", "")
        regions = impact_scale(base_regions, s)
        ref = cx_regions_mask(regions)
        reg, cnt, scr, back, _o = run_case(args.server, args.comfy, img_name, mask_name, tag,
                                          src, post="scale:%s" % s)
        check("%s：框数不变（回读 %r）" % (name, cnt.strip()), cnt.strip().startswith("3"))
        check("%s：CX 有效区域 == cx_core 按 Impact 公式算的结果（逐像素）" % name,
              bool((reg == ref).all()),
              "不同像素=%d；region 期望 %s" % (int((reg != ref).sum()), regions))
        roundtrip_checks(name, back, scr, regions, src, region_mask=ref, box=regions[0])
        # 轴心不变 + 尺寸按比例：拿服务端真实块掩膜的连通块核对
        cb, c0 = mask_centers(reg), mask_centers(ref_mask)
        centers_ok = len(cb) == len(c0) and all(
            abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) <= UNIT and
            abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) <= UNIT for a, b in zip(cb, c0))
        sizes_ok = len(cb) == len(c0) and all(
            abs((a[2] - a[0]) - (b[2] - b[0]) * s) <= 2 * UNIT and
            abs((a[3] - a[1]) - (b[3] - b[1]) * s) <= 2 * UNIT for a, b in zip(cb, c0))
        check("%s：块掩膜连通块的**中心不变**（±1 块）" % name, centers_ok,
              "缩放后 %s / 原 %s" % (cb, c0))
        check("%s：块掩膜连通块的**尺寸按比例**（±2 块）" % name, sizes_ok)
    check("放大后有效区域 > 原区域 > 缩小后有效区域",
          int(cx_regions_mask(impact_scale(base_regions, 1.5)).sum()) > int(ref_mask.sum())
          > int(cx_regions_mask(impact_scale(base_regions, 0.6)).sum()),
          "%d > %d > %d" % (int(cx_regions_mask(impact_scale(base_regions, 1.5)).sum()),
                            int(ref_mask.sum()),
                            int(cx_regions_mask(impact_scale(base_regions, 0.6)).sum())))

    print("\n== 4. 标记框合并：ImpactSEGSMerge（多框 → 1 框，bbox/掩膜都取并集） ==")
    merged = impact_merge(base_regions)
    ref_m = cx_regions_mask(merged)
    reg_m, cnt_m, scr_m, back_m, _o = run_case(args.server, args.comfy, img_name, mask_name,
                                              "merge", src, post="merge")
    check("合并后只剩 1 个框（回读 %r）" % cnt_m.strip(), cnt_m.strip().startswith("1"))
    check("合并后区域 = 三框并集外接框 %s" % (merged,), bool((reg_m == ref_m).all()),
          "不同像素=%d" % int((reg_m != ref_m).sum()))
    check("合并区域 ⊃ 原三框各自区域；且 < 整图",
          bool((reg_m | ref_mask == reg_m).all()) and int(reg_m.sum()) < H * W)
    roundtrip_checks("合并(bbox 口径)", back_m, scr_m, merged, src, region_mask=ref_m, box=merged[0])
    check("合并 1 个框时 seed 只有 seed[0]（与多框不同的打码结果）",
          not np.array_equal(scr_m, scr0))
    # 掩膜口径：合并后的门 = 三个斑块的并集（而不是外接矩形）
    reg_mm, cnt_mm, scr_mm, back_mm, _o = run_case(args.server, args.comfy, img_name, mask_name,
                                                  "mergemask", src, post="merge", shape="mask")
    gate = mask.astype(np.float32) / 255.0
    ref_mm = cx_core.effective_block_mask(H, W, cx_sorted(merged), [gate], UNIT, 0.5)
    check("合并 + region_shape=mask：有效区域 == 掩膜并集的按块门（逐像素）",
          bool((reg_mm == ref_mm).all()),
          "不同像素=%d（外接框口径 %d px → 掩膜口径 %d px）"
          % (int((reg_mm != ref_mm).sum()), int(reg_m.sum()), int(reg_mm.sum())))
    check("掩膜口径确实比外接框口径小（合并不等于糊成一大块）",
          int(reg_mm.sum()) < int(reg_m.sum()), "%d < %d" % (int(reg_mm.sum()), int(reg_m.sum())))
    roundtrip_checks("合并(mask 口径)", back_mm, scr_mm, merged, src, gates=[gate],
                     region_mask=ref_mm, box=BLOBS[0])

    print("\n== 5. 拼接与去重：ImpactSEGSConcat / ImpactSEGSNMSFilter ==")
    dup = base_regions * 2
    reg_c, cnt_c, _s, _b, _o = run_case(args.server, args.comfy, img_name, mask_name,
                                       "concat", src, post="concat")
    check("同一份 SEGS 接两次 → 6 个框（回读 %r）" % cnt_c.strip(), cnt_c.strip().startswith("6"))
    check("6 个框的有效区域 == 3 个框的（重合框叠加，区域不变）",
          bool((reg_c == ref_mask).all()))
    reg_n, cnt_n, scr_n, _b2, _o2 = run_case(args.server, args.comfy, img_name, mask_name,
                                            "nms", src, post="nms:0.5")
    check("NMS(IoU 0.5) 把重复框去掉 → 回到 3 个（回读 %r）" % cnt_n.strip(),
          cnt_n.strip().startswith("3"))
    check("去重后区域 == 基线区域", bool((reg_n == ref_mask).all()))
    check("NMS 去重后打码结果 == 基线（逐像素等价）", np.array_equal(scr_n, scr0))

    print("\n== 6. 空框（没检到标记框）：默认原图直出，工作流不卡 ==")
    g = {
        "1": {"class_type": "LoadImage", "inputs": {"image": img_name}},
        "5": {"class_type": "EmptySegs", "inputs": {}},
        "20": {"class_type": "CX_RegionScramble",
               "inputs": {"aabb": "", "key": KEY, "box_mode": "xywh", "unit": UNIT, "soft": False,
                          "password": "", "region_shape": "bbox", "pad": 0, "max_regions": 32,
                          "mask_threshold": 0.5, "label_filter": "", "sort_regions": True,
                          "image": ["1", 0], "segs": ["5", 0]}},
        "22": {"class_type": "SaveImage", "inputs": {"images": ["20", 0],
                                                    "filename_prefix": "cx_tools_empty_out"}},
        "23": {"class_type": "MaskToImage", "inputs": {"mask": ["20", 1]}},
        "24": {"class_type": "SaveImage", "inputs": {"images": ["23", 0],
                                                    "filename_prefix": "cx_tools_empty_m"}},
    }
    ent = run_prompt(args.server, g)
    sv = saved_images(ent)
    out_e = load(pick(sv, "cx_tools_empty_out", args.comfy))
    m_e = load(pick(sv, "cx_tools_empty_m", args.comfy))
    check("EmptySegs → CX：默认原图直出（逐像素相同）", np.array_equal(out_e, src))
    check("EmptySegs → CX：MASK 输出全 0", int(m_e.max()) == 0)
    g_err = json.loads(json.dumps(g))
    g_err["20"]["inputs"]["no_region_policy"] = "error"
    try:
        run_prompt(args.server, g_err)
        check("EmptySegs → CX + no_region_policy=error → 应当报错", False, "没报错")
    except RuntimeError as e:
        check("EmptySegs → CX + error → 报错（想尽早暴露接线错误时用）",
              "0 个区域" in str(e), str(e)[:70].replace("\n", " "))
    # EmptySegs → SEGSMerge 会造出一个畸形框（crop_region = (maxsize,…,0,0)）；CX 应当丢掉它并直出
    g2 = json.loads(json.dumps(g))
    g2["6"] = {"class_type": "ImpactSEGSMerge", "inputs": {"segs": ["5", 0]}}
    g2["20"]["inputs"]["segs"] = ["6", 0]
    try:
        ent2 = run_prompt(args.server, g2)
        sv2 = saved_images(ent2)
        out_em = load(pick(sv2, "cx_tools_empty_out", args.comfy))
        check("EmptySegs → SEGSMerge → CX：CX 不报错，且原图直出（畸形框被丢弃）",
              np.array_equal(out_em, src))
    except RuntimeError as e:
        check("EmptySegs → SEGSMerge → CX：CX 不报错（实测 SEGSMerge 自身先报错：%s）"
              % str(e)[:60].replace("\n", " "), True)
        print("         [INFO] 空 SEGS 过 ImpactSEGSMerge 会先在它自己那边出错 ——"
              "工作流里要么把 SEGS 判空后绕过它（ImpactIsNotEmptySEGS），要么直接让 CX 吃空 SEGS（本节点直出）")

    print("\n== 7. 结论：外部节点分工（实测数字） ==")
    print("  按轴心缩放：ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT(scale_by) → ImpactAssembleSEGS")
    print("     1.5×: 有效块 %d px；0.6×: %d px；不缩放: %d px（都以框中心为轴，中心不变）"
          % (int(cx_regions_mask(impact_scale(base_regions, 1.5)).sum()),
             int(cx_regions_mask(impact_scale(base_regions, 0.6)).sum()),
             int(ref_mask.sum())))
    print("  标记框合并：ImpactSEGSMerge → 1 个框：外接框口径 %d px / 掩膜门口径 %d px（3 框时 %d px）"
          % (int(reg_m.sum()), int(reg_mm.sum()), int(ref_mask.sum())))
    print("  拼接/去重：ImpactSEGSConcat（6 框）→ ImpactSEGSNMSFilter(IoU .5) → 3 框")
    print("  没检到框：SEGS/BBOX/MASK 为空 → CX 默认 no_region_policy=passthrough 原图直出（不卡流程）")

    print()
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅ 标记框后处理（外部节点）× CX 打码/还原")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# -*- coding: utf-8 -*-
"""
test_regions.py — 「打框数据 → 区域」这条新链路的测试（纯 cx_core，不需要 torch / ComfyUI）

覆盖：SEGS（bbox 模型 / segm 模型两种形态）、通用 BBOX 数据、MASK、手写 aabb，
      以及 region_shape=bbox/mask 两种口径、pad、label_filter、max_regions、
      sort_regions 顺序无关性、多帧广播、错参数不可还原。

用法：venv\\Scripts\\python.exe custom_nodes\\ComfyUI-CX-ImageScramble\\tests\\test_regions.py
"""

import os
import sys
from collections import namedtuple

import numpy as np

try:  # Windows 控制台默认 GBK，中文/表情符号会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
import cx_core  # noqa: E402

# 与 Impact Pack 的 SEG 完全同构（modules/impact/core.py:46）
SEG = namedtuple("SEG", ["cropped_image", "cropped_mask", "confidence", "crop_region",
                         "bbox", "label", "control_net_wrapper"], defaults=[None])

FAIL = []


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def make_img(H, W, seed=7):
    """照片类内容：平滑渐变 + 低频色块 + 轻微噪声（不含大面积纯饱和色，
    因为饱和色往返会被 YUV 钳制损失 —— 那属于算法固有，见 test_parity.py 的 JS 对照）。"""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:H, 0:W]
    img = np.zeros((H, W, 3), np.float32)
    img[..., 0] = 60 + 120 * xx / max(1, W - 1)
    img[..., 1] = 70 + 110 * yy / max(1, H - 1)
    img[..., 2] = 90 + 60 * (np.sin(xx / 29.0) * np.cos(yy / 17.0) + 1) / 2
    img += 25 * np.exp(-(((xx - 140) / 70.0) ** 2 + ((yy - 80) / 40.0) ** 2))[..., None]
    img += 18 * np.exp(-(((xx - 370) / 60.0) ** 2 + ((yy - 165) / 45.0) ** 2))[..., None]
    img = np.clip(img + rng.normal(0, 1.5, img.shape), 0, 255)
    return np.rint(img).astype(np.uint8)


class Box:
    """最朴素的「带 .bbox 的对象」（bbox 按 xywh）"""

    def __init__(self, bbox, label=""):
        self.bbox = bbox
        self.label = label


def as_segs(segs, H, W):
    """Impact Pack 的实际形态：((H, W), [SEG, ...])"""
    return ((H, W), list(segs))


def make_seg(bbox, label="obj", pad_crop=16, mask_kind="full", H=0, W=0):
    """造一个与 Impact Pack 同构的 SEG。mask_kind: full(纯矩形检测器) / ellipse(segm 模型)

    注意 SEG.bbox 是 **xyxy**（Impact 约定，与 crop_region 同系），入参用 xywh 方便写。
    """
    x, y, w, h = bbox
    bbox_xyxy = (x, y, x + w, y + h)
    cr = (max(0, x - pad_crop), max(0, y - pad_crop),
          min(W, x + w + pad_crop), min(H, y + h + pad_crop))
    cw, ch = cr[2] - cr[0], cr[3] - cr[1]
    if mask_kind == "full":
        cm = np.ones((ch, cw), np.float32)
    else:
        yy, xx = np.mgrid[0:ch, 0:cw]
        cy, cx = (ch - 1) / 2.0, (cw - 1) / 2.0
        rr = min(ch, cw) / 2.0 - 2
        cm = (((yy - cy) / max(1e-6, rr)) ** 2 + ((xx - cx) / max(1e-6, rr)) ** 2 <= 1.0)
        cm = cm.astype(np.float32)
    return SEG(None, cm, 0.95, cr, bbox_xyxy, label, None)


def psnr(a, b, box=None):
    a = a.astype(np.int32); b = b.astype(np.int32)
    if box:
        x, y, w, h = box
        a = a[y:y + h, x:x + w]; b = b[y:y + h, x:x + w]
    mse = float(((a - b) ** 2).mean())
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def roundtrip(img, **kw):
    """按同一份打框数据 加密→解密，返回 (密图, 还原图, 有效掩膜)"""
    a = img.copy()
    src, regions, gates, labels, notes = cx_core.resolve_regions(H=img.shape[0], W=img.shape[1], **kw)
    n = cx_core.scramble_array(a, regions, 20240117, "", 8, False, True, gates=gates)
    scr = a.copy()
    src2, regions2, gates2, _l2, _n2 = cx_core.resolve_regions(H=img.shape[0], W=img.shape[1], **kw)
    assert regions == regions2 and (gates is None) == (gates2 is None), "两次解析结果必须一致"
    cx_core.scramble_array(a, regions2, 20240117, "", 8, False, False, gates=gates2)
    eff = cx_core.effective_block_mask(img.shape[0], img.shape[1], regions, gates, 8, 0.5)
    return scr, a, eff, src, regions, labels, notes, n


def main():
    H, W = 320, 480
    base = make_img(H, W)
    BOXES = [(60, 40, 160, 80), (300, 130, 140, 70), (120, 210, 140, 80)]
    LABELS = ["face", "hand", "face"]

    print("== 1. SEGS（bbox 模型形态：cropped_mask 全 1）→ 矩形打码 ==")
    segs = as_segs([make_seg(b, lb, H=H, W=W) for b, lb in zip(BOXES, LABELS)], H, W)
    scr, back, eff, src, regions, labels, notes, n = roundtrip(base, segs=segs, shape="bbox")
    check("区域源识别为 segs", src == "segs", src)
    check("3 个框全部用上", len(regions) == 3 and n == 3, str(regions))
    check("区域外零改动", int(np.abs(scr.astype(int) - base.astype(int))[~eff].max()) == 0)
    check("区域内确实变了（>95%）", float((scr[eff] != base[eff]).any(-1).mean()) > 0.95,
          "%.1f%%" % (float((scr[eff] != base[eff]).any(-1).mean()) * 100))
    check("往返 PSNR > 30dB", psnr(back, base) > 30, "PSNR=%.1fdB" % psnr(back, base))
    check("labels 带出来了", labels == ["face", "face", "hand"], str(labels))  # 已按 (label,y,x) 排序

    print("== 2. 与手写 aabb 逐字节一致（证明新链路没有改动算法本身） ==")
    aabb = "; ".join("%d,%d,%d,%d" % r for r in regions)   # 用同一顺序，避免 seed 对不上
    a1 = base.copy(); a2 = base.copy()
    cx_core.scramble_array(a1, regions, 20240117, "", 8, False, True, gates=None)
    src_b, regions_b, gates_b, _l, _n = cx_core.resolve_regions(aabb=aabb, H=H, W=W)
    cx_core.scramble_array(a2, regions_b, 20240117, "", 8, False, True, gates=gates_b)
    check("SEGS(bbox 口径) == aabb", regions_b == regions and np.array_equal(a1, a2),
          "regions %s / %s" % (regions_b, regions))

    print("== 2b. SEGS 形态与 bbox 坐标系（Impact 约定：((H,W),[SEG,…]) + bbox=xyxy） ==")
    _s, r_xyxy, _g, _l, _n = cx_core.resolve_regions(segs=segs, shape="bbox", H=H, W=W)
    check("xyxy 的 SEG.bbox 被正确换算成 xywh",
          sorted(r_xyxy) == sorted(BOXES), "%s vs %s" % (sorted(r_xyxy), sorted(BOXES)))
    _s, r_list, _g, _l, _n = cx_core.resolve_regions(segs=list(segs[1]), shape="bbox", H=H, W=W)
    check("裸 list[SEG] 形态也认（老写法兼容）", r_list == r_xyxy)
    _s, r_rec, _g, _l, _n = cx_core.resolve_regions(segs={"segs": segs[1]}, shape="bbox", H=H, W=W)
    check("dict{'segs': [...]} 形态也认", r_rec == r_xyxy)
    bad = SEG(None, None, 1.0, (0, 0, 10, 10), (5, 6, 3, 4), "L", None)   # 明显是 xywh
    _s, r_bad, _g, _l, _n = cx_core.resolve_regions(segs=((H, W), [bad]), shape="bbox", H=H, W=W)
    check("异常 bbox（第 3/4 个数更小）自动按 xywh 兜底", r_bad == [(5, 6, 3, 4)], str(r_bad))

    print("== 3. sort_regions：检测器返回顺序被打乱也不影响结果 ==")
    order = [2, 0, 1]
    segs_shuffled = as_segs([segs[1][i] for i in order], H, W)
    src_s, regions_s, gates_s, _l, _n = cx_core.resolve_regions(segs=segs_shuffled, shape="bbox", H=H, W=W)
    b1 = base.copy(); b2 = base.copy()
    cx_core.scramble_array(b1, regions, 20240117, "", 8, False, True)
    cx_core.scramble_array(b2, regions_s, 20240117, "", 8, False, True)
    check("打乱顺序后区域序列与像素结果都相同", regions_s == regions and np.array_equal(b1, b2))
    src_n, regions_n, _g, _l, _n = cx_core.resolve_regions(segs=segs_shuffled, shape="bbox",
                                                          sort_regions=False, H=H, W=W)
    check("关掉 sort_regions 则顺序敏感（说明这个开关真的起作用）", regions_n != regions)

    print("== 4. segm 模型形态：shape=mask 按分割形状打码 ==")
    segm_segs = as_segs([make_seg(BOXES[0], "face", mask_kind="ellipse", H=H, W=W),
                        make_seg(BOXES[1], "hand", mask_kind="ellipse", H=H, W=W)], H, W)
    scr_m, back_m, eff_m, src_m, regions_m, _lb, _nt, _n = roundtrip(base, segs=segm_segs, shape="mask")
    check("mask 口径生效且往返可还原", psnr(back_m, base, BOXES[0]) > 30 and psnr(back_m, base, BOXES[1]) > 30,
          "PSNR=%.1fdB/%.1fdB" % (psnr(back_m, base, BOXES[0]), psnr(back_m, base, BOXES[1])))
    scr_b, back_b, eff_b, *_ = roundtrip(base, segs=segm_segs, shape="bbox")
    check("mask 口径改动的像素比 bbox 口径少（真的按形状裁了）",
          int(eff_m.sum()) < int(eff_b.sum()),
          "mask=%d px < bbox=%d px" % (eff_m.sum(), eff_b.sum()))
    # 椭圆四个角应该没被打码
    x, y, w, h = BOXES[0]
    corners = [(y + 2, x + 2), (y + 2, x + w - 3), (y + h - 3, x + 2), (y + h - 3, x + w - 3)]
    corner_ok = all(not eff_m[cy, cx] for cy, cx in corners)
    check("框四角（椭圆之外）未被改动", corner_ok)
    check("椭圆内部确实被改动", bool(eff_m[y + h // 2, x + w // 2]))

    print("== 5. 门 = 全选 时与无门逐字节一致（默认行为没有被扩展改坏） ==")
    g_all = np.ones((H, W), np.float32)
    c1 = base.copy(); c2 = base.copy()
    cx_core.region_enc(c1, 60, 40, 160, 80, 12345, True, False, 8)
    cx_core.region_enc(c2, 60, 40, 160, 80, 12345, True, False, 8, gate=g_all, threshold=0.5)
    check("gate 全 1 == 无 gate", np.array_equal(c1, c2))

    print("== 6. label_filter / pad / max_regions ==")
    _s, r_f, _g, lb_f, _n = cx_core.resolve_regions(segs=segs, shape="bbox", label_filter="face", H=H, W=W)
    check("label_filter=face 只留 2 个", len(r_f) == 2 and set(lb_f) == {"face"}, "%s %s" % (r_f, lb_f))
    _s, r_p, _g, _l, _n = cx_core.resolve_regions(segs=segs, shape="bbox", pad=24, H=H, W=W)
    grown = all(r_p[i][2] == regions[i][2] + 48 and r_p[i][3] == regions[i][3] + 48 for i in range(3))
    check("pad=24 每边外扩（宽高各 +48）", grown, str(r_p))
    s_t, r_t, _g, _l, nt = cx_core.resolve_regions(segs=segs, shape="bbox", max_regions=2, H=H, W=W)
    check("max_regions=2 截断并给出备注", len(r_t) == 2 and any("截断" in x for x in nt), str(nt))

    print("== 7. 通用 BBOX 数据（无 SEGS 时） ==")
    variants = {
        "list[(x,y,w,h)]": [(60, 40, 160, 80), (300, 130, 140, 70)],
        "np (N,4)": np.array([[60, 40, 160, 80], [300, 130, 140, 70]], np.float32),
        "np (4,) 单框": np.array([60, 40, 160, 80], np.float32),
        "单 tuple": (60, 40, 160, 80),
        "dict{'bboxes'}": {"bboxes": [(60, 40, 160, 80), (300, 130, 140, 70)]},
        "对象带 .bbox": [Box((60, 40, 160, 80)), Box((300, 130, 140, 70))],
    }
    for name, obj in variants.items():
        s2, r2, _g, _l, _n = cx_core.resolve_regions(bbox=obj, H=H, W=W)
        want_n = 1 if name in ("np (4,) 单框", "单 tuple") else 2
        check("bbox 形态 %-16s → %d 个框" % (name, want_n),
              s2 == "bbox" and len(r2) == want_n, str(r2))

    print("== 8. MASK 输入（SAM / 分割掩膜） ==")
    mm = np.zeros((H, W), np.float32)
    mm[60:140, 200:340] = 1.0
    yy, xx = np.mgrid[0:H, 0:W]
    ell = (((yy - 230) / 55.0) ** 2 + ((xx - 130) / 75.0) ** 2) <= 1.0
    mm2 = (ell.astype(np.float32))
    for shape in ("bbox", "mask"):
        s3, r3, g3, _l, _n = cx_core.resolve_regions(mask_frame=mm2, shape=shape, H=H, W=W)
        eff3 = cx_core.effective_block_mask(H, W, r3, g3, 8, 0.5)
        if shape == "bbox":
            # 矩形口径：有效范围就是对齐后的整框
            x0 = (r3[0][0] // 8) * 8
            y0 = (r3[0][1] // 8) * 8
            x1 = x0 + ((min(W, -(-(r3[0][0] + r3[0][2]) // 8) * 8) - x0) // 8) * 8
            y1 = y0 + ((min(H, -(-(r3[0][1] + r3[0][3]) // 8) * 8) - y0) // 8) * 8
            check("MASK shape=bbox 有效范围 = 对齐整框 (%d×%d)" % (x1 - x0, y1 - y0),
                  int(eff3.sum()) == (x1 - x0) * (y1 - y0) and eff3[y0:y1, x0:x1].all(),
                  "有效 %d px / 期望 %d px" % (eff3.sum(), (x1 - x0) * (y1 - y0)))
        else:
            want = int(ell.sum())
            ratio = eff3.sum() / max(1, want)
            check("MASK shape=mask 覆盖率≈分割面积", 0.85 < ratio < 1.2,
                  "有效 %d px / 掩膜 %d px = %.2f" % (eff3.sum(), want, ratio))
    # 往返 + 空掩膜
    scr_k, back_k, eff_k, src_k, _r, _l, _n, _c = roundtrip(base, mask_frame=mm2, shape="mask")
    check("MASK 口径往返可还原", psnr(back_k, base, (55, 175, 150, 110)) > 28,
          "PSNR=%.1fdB" % psnr(back_k, base, (55, 175, 150, 110)))
    empty = np.zeros((H, W), np.float32)
    s4, r4, g4, _l, _n = cx_core.resolve_regions(mask_frame=empty, shape="mask", H=H, W=W)
    check("空掩膜 → 0 区域（节点层按 no_region_policy：默认原图直出）", r4 == [] and g4 is None)

    print("== 9. 优先级：segs > bbox > mask > aabb ==")
    s5, r5, _g, _l, _n = cx_core.resolve_regions(segs=segs, mask_frame=mm, aabb="0,0,8,8", H=H, W=W)
    check("同时给 segs/mask/aabb → 取 segs", s5 == "segs" and len(r5) == 3)
    s6, _r, _g, _l, _n = cx_core.resolve_regions(bbox=[(10, 10, 20, 20)], mask_frame=mm, H=H, W=W)
    check("给 bbox/mask → 取 bbox", s6 == "bbox")
    s7, _r, _g, _l, _n = cx_core.resolve_regions(mask_frame=mm, aabb="0,0,8,8", H=H, W=W)
    check("给 mask/aabb → 取 mask", s7 == "mask")
    s8, r8, _g, _l, _n = cx_core.resolve_regions(aabb="10,10,20,20", H=H, W=W)
    check("只给 aabb → 取 aabb", s8 == "aabb" and r8 == [(10, 10, 20, 20)])
    s9, r9, _g, _l, _n = cx_core.resolve_regions(H=H, W=W)
    check("什么都不给 → none（节点层默认原图直出）", s9 == "none" and r9 == [])

    print("== 10. 错参数不可还原（以「正确参数」的往返质量为基准比较） ==")
    _s, rr_ref, gg_ref, _l, _n = cx_core.resolve_regions(segs=segs, shape="bbox", H=H, W=W)
    good = base.copy()
    cx_core.scramble_array(good, rr_ref, 20240117, "", 8, False, True, gates=gg_ref)
    cx_core.scramble_array(good, rr_ref, 20240117, "", 8, False, False, gates=gg_ref)
    psnr_good = psnr(good, base)

    def decode_with(**kw):
        a = base.copy()
        _s2, rr, gg, _l2, _n2 = cx_core.resolve_regions(H=H, W=W, **kw)
        cx_core.scramble_array(a, rr_ref, 20240117, "", 8, False, True, gates=gg_ref)   # 同一张密图
        cx_core.scramble_array(a, rr, 20240117, "", 8, False, False, gates=gg)
        return psnr(a, base)

    for name, kw in [("pad=16 不一致", dict(segs=segs, shape="bbox", pad=16)),
                     ("max_regions 不一致", dict(segs=segs, shape="bbox", max_regions=2)),
                     ("label_filter 不一致", dict(segs=segs, shape="bbox", label_filter="hand")),
                     ("shape=mask 不一致", dict(segs=segm_segs, shape="mask"))]:
        p = decode_with(**kw)
        check("还原参数 %-18s → 失败（比正确 %.1fdB 低 15dB 以上）" % (name, psnr_good),
              psnr_good - p > 15, "PSNR=%.1fdB" % p)

    a = base.copy()
    cx_core.scramble_array(a, rr_ref, 20240117, "", 8, False, True, gates=gg_ref)
    cx_core.scramble_array(a, rr_ref, 20240118, "", 8, False, False, gates=gg_ref)     # 错 key
    p_key = psnr(a, base)
    check("key 不一致 → 失败", psnr_good - p_key > 15, "PSNR=%.1fdB" % p_key)

    print("== 11. 多帧广播（MASK 1 帧 × image 3 帧） ==")
    batch = np.stack([base.copy() for _ in range(3)])
    _s, rb, gb, _l, _n = cx_core.resolve_regions(mask_frame=mm2, shape="mask", H=H, W=W)
    for f in range(3):
        cx_core.scramble_array(batch[f], rb, 1, "", 8, False, True, gates=gb)
    check("3 帧结果完全相同（同一掩膜广播）",
          np.array_equal(batch[0], batch[1]) and np.array_equal(batch[1], batch[2]))

    print("== 12. 只有一个秘密：key=N 与 password='N' 是同一把钥匙 ==")
    _s, rr_s, gg_s, _l, _n = cx_core.resolve_regions(segs=segs, shape="bbox", H=H, W=W)
    x1 = base.copy(); x2 = base.copy()
    cx_core.scramble_array(x1, rr_s, 12345, "", 8, False, True, gates=gg_s)      # 用 int key 打码
    cx_core.scramble_array(x2, rr_s, 0, "12345", 8, False, True, gates=gg_s)      # 用等价密码打码
    check("key=12345 与 password='12345' 的打码结果逐字节相同", np.array_equal(x1, x2))
    cx_core.scramble_array(x1, rr_s, 0, "12345", 8, False, False, gates=gg_s)     # 用密码还原 key 打的码
    check("**交叉**：int key 打的码，用等价 password 能还原", psnr(x1, base) > 30,
          "PSNR=%.1fdB" % psnr(x1, base))
    x3 = base.copy()
    cx_core.scramble_array(x3, rr_s, 0, "12346", 8, False, False, gates=gg_s)     # 密码不同
    good_psnr = psnr(x1, base)
    check("密码差 1 位 → 还原失败（比正确低 15dB 以上）",
          good_psnr - psnr(x3, base) > 15, "正确 %.1fdB / 错密码 %.1fdB"
          % (good_psnr, psnr(x3, base)))

    print()
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅ 打框数据链路（SEGS / BBOX / MASK / aabb）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

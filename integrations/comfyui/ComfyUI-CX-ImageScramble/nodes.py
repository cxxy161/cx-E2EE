# -*- coding: utf-8 -*-
"""
nodes.py — CX 图片区域混淆（打码 / 还原）ComfyUI 节点定义

输入形态：**直接吃检测模型输出的打框数据**
    segs  (SEGS)  ← UltralyticsDetectorProvider 的 bbox 模型 / segm 模型，
                     经 Impact 的 *Detector (SEGS) 节点汇成 SEGS
    bbox  (BBOX)  ← 通用框数据（(N,4) 张量 / [(x,y,w,h),...] / 带 .bbox 的对象）
    mask  (MASK)  ← 分割掩膜（SAM / 分割模型 / MaskEditor）
    aabb  (STRING)← 手写兜底（与 cx-E2EE 网页端同格式）
优先级：segs > bbox > mask > aabb（同时连多个时只用最高优先级那个）。

算法全部在 cx_core.py（与 cx-E2EE 网页端逐位等价的移植 + 块级门扩展）。
"""

from __future__ import annotations

import numpy as np
import torch
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from . import cx_core

CATEGORY = "CX-E2EE/图片混淆"
SEGS_TYPE = "SEGS"     # Impact Pack：list[SEG(namedtuple)]
BBOX_TYPE = "BBOX"     # 通用框数据类型（有则自动可连）

_KEY_DOC = (
    "整数形式的密钥。**它不是独立密码**：密码只有一个，见下面 password。\n"
    "整数形式的密钥。**它不是独立密码**：密码只有一个，见下面 password。\n"
    "密码留空时才用它，等价于 password='<这个整数>'（key=12345 与 password='12345' 的种子完全相同）。\n"
    "与 cx-E2EE 网页端互通请直接用 password 填网页端密码。"
    "与 cx-E2EE 网页端互通请直接用 password 填网页端密码。"
)
_PASSWORD_DOC = (
    "（可选）**唯一密码**。网页端加密和解密都只用这一个密码，本节点也一样：\n"
    "  区域 seed = IA.hash(密码 + '#' + 区域序号)   ← 与网页端一字不差\n"
    "填了它，上面的 int (key) 就被忽略（控制台会明确提示，不再静默）。"
)
_UNIT_DOC = (
    "置换单元边长（像素）。8 = 网页端 PNG 无损路径；16 = JPEG 拍屏鲁棒路径。\n"
    "还原时必须与打码时一致，否则得到噪声。"
)
_SOFT_DOC = (
    "JPEG 友好亮度域（网页端 flag bit3）。网页端输出 JPEG（质量<100）时是开的；\n"
    "输出 PNG 时是关的。还原时必须与打码时一致。"
)
_AABB_DOC = (
    "手写轴对齐包围盒（没接打框数据时才用）。单区域 4 个数字，多区域用 ; 或换行分隔。\n"
    "  xywh 模式（默认）：x,y,w,h    例：100,50,64,64\n"
    "  xyxy 模式：x1,y1,x2,y2      例：100,50,164,114\n"
    "支持 [[..],[..]]、空格分隔等宽松写法；留空 = 不用手写框。"
)
_SHAPE_DOC = (
    "bbox：只用框的矩形范围做块置换（＝网页端行为，可与网页端互通）。\n"
    "mask：再用掩膜（segs.cropped_mask 或 mask 输入）做块级门，只打码掩膜覆盖的块\n"
    "      —— segm 模型/SAM 的分割形状级打码；纯 bbox 模型退化成矩形。"
)
_SEGS_DOC = (
    "检测模型输出的 SEGS（bbox 模型 / segm 模型都汇成它）。\n"
    "框会按 unit 对齐到块，可用 pad 外扩、label_filter 过滤、max_regions 截断。\n"
    "还原时要接**同一份** SEGS（建议把检测结果复用，不要重跑）。"
)
_BBOX_DOC = "通用框数据：[(x,y,w,h),...] / (N,4) 张量 / 带 .bbox 的对象列表 / dict{'bboxes':...}。"
_MASK_DOC = (
    "掩膜（SAM / 分割模型 / MaskEditor）。取非零区外接框做区域；\n"
    "shape=mask 时按掩膜形状逐块打码。批次：1 帧广播到整批，或与 image 帧数相同。"
)
_PAD_DOC = "框四边外扩像素（检测框常偏紧，外扩 4~16 能盖住边缘）。"
_THRESH_DOC = "块级门阈值：块内掩膜占比 ≥ 该值的块才参与打码（0.5 = 多数表决）。"
_LABEL_DOC = "只取这些 label（逗号/空格分隔，不区分大小写）。留空 = 全部。"
_SORT_DOC = "按 (label,y,x,w,h) 稳定排序后再分配 seed，让结果与检测器返回顺序无关（建议开）。"
_MAXR_DOC = "最多使用多少个区域（超出按稳定排序截断，控制台会给提示）。"
_META_DOC = (
    "把区域表写进外扩 8px 边框（LSB），输出＝网页端那种「自带怎么还原」的 PNG 打码图：\n"
    "  还原只需要 这张图 + 同一个密码，不用再接打框数据。\n"
    "注意：必须 PNG 无损保存、不要缩放/再压缩，否则 LSB 会被抹掉；\n"
    "     元数据只存矩形区域（会强制 region_shape=bbox、unit=8、soft=False）。"
)
_POLICY_DOC = (
    "打框数据解析出 0 个区域时怎么办：\n"
    "  error       = 直接报错（默认，配置错了会立刻暴露）；\n"
    "  passthrough = 原图直出 + 控制台告警（检测模型在某帧没检到东西时，不中断整批）。"
)
_MODES_DOC = "aabb 里四个数字怎么解释：xywh=(x,y,宽,高) / xyxy=(x1,y1,x2,y2)"


def _to_uint8(image: torch.Tensor) -> np.ndarray:
    a = image.to(torch.float32).detach().cpu().numpy()
    return np.clip(np.rint(a * 255.0), 0.0, 255.0).astype(np.uint8)


def _mask_to_numpy(mask) -> np.ndarray:
    if isinstance(mask, torch.Tensor):
        m = mask.detach().to("cpu").float().numpy()
    else:
        m = np.asarray(mask, dtype=np.float32)
    if m.ndim == 2:
        m = m[None, ...]
    if m.ndim == 4:
        m = m[:, 0]
    return np.ascontiguousarray(m)


def _fmt_regions(regions, labels, limit=8):
    items = ["(%d,%d,%d,%d)%s" % (x, y, w, h, ("[%s]" % lb) if lb else "")
             for (x, y, w, h), lb in zip(regions[:limit], (labels or [""] * len(regions))[:limit])]
    if len(regions) > limit:
        items.append("…共 %d 个" % len(regions))
    return " ".join(items)


def _run(image, segs, bbox, mask, aabb, box_mode, shape, pad, threshold, label_filter,
         sort_regions, max_regions, no_region_policy, embed_meta, key, password, unit, soft,
         encode, label):
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError("image 必须是 (B,H,W,C) 的 IMAGE 张量，收到 %r" % (type(image),))
    B, H, W, C = image.shape
    if C < 1:
        raise ValueError("image 通道数非法：%r" % (image.shape,))
    unit = int(unit)
    if unit not in cx_core.UNIT_CHOICES:
        raise ValueError("unit 只能是 %s，收到 %r" % (list(cx_core.UNIT_CHOICES), unit))
    shape = str(shape or "bbox").strip().lower()
    if shape not in cx_core.SHAPES:
        raise ValueError("region_shape 只能是 %s，收到 %r" % (list(cx_core.SHAPES), shape))
    aabb = "" if aabb is None else str(aabb)
    pad = max(0, int(pad))
    max_regions = max(1, int(max_regions))
    threshold = float(threshold)

    arr = _to_uint8(image)
    squeeze = False
    if C == 1:
        arr = np.repeat(arr, 3, axis=3)
        squeeze = True

    masks = None
    notes = []
    if mask is not None:
        masks = _mask_to_numpy(mask)
        if masks.shape[1] != H or masks.shape[2] != W:
            raise ValueError("MASK 尺寸 %r 与 IMAGE 尺寸 (%d,%d) 不一致"
                             % (tuple(masks.shape[1:]), H, W))
        if masks.shape[0] not in (1, B):
            raise ValueError("MASK 帧数 %d 必须为 1（广播）或与 IMAGE 批次 %d 相同"
                             % (masks.shape[0], B))
    has_other = (segs is not None) or (bbox is not None) or bool(aabb.strip())
    if masks is not None and has_other:
        notes.append("同时连了 mask 与 segs/bbox/aabb → 按优先级只用 segs/bbox/aabb，mask 忽略")

    # ------------------------------------------------------------------
    #  元数据模式（与网页端同款用法）
    #   写：embed_meta=True → 外扩 8px 边框 + 区域表 LSB，输出自带"怎么还原"
    #   读：没接任何打框数据 → 自己从图里读区域表 + 校验密码签名
    # ------------------------------------------------------------------
    meta_no_src = (segs is None) and (bbox is None) and (masks is None) and not aabb.strip()
    if (encode and embed_meta) or ((not encode) and meta_no_src):
        MB = cx_core.META_B_PNG
        if encode:
            if shape != "bbox":
                raise ValueError("embed_meta=True 时 region_shape 必须是 bbox："
                                 "网页端元数据只存矩形区域表，掩膜门无法在还原端复现")
            if int(unit) != MB or bool(soft):
                print("[CX][注意] 元数据模式固定 unit=8 / soft=False（网页端 PNG 口径），"
                      "已忽略 unit=%s soft=%s" % (unit, soft))
            if int(max_regions) > cx_core.AABB_MAX_REGIONS:
                print("[CX][注意] 元数据最多存 %d 个区域（网页端上限），max_regions %d → %d"
                      % (cx_core.AABB_MAX_REGIONS, int(max_regions), cx_core.AABB_MAX_REGIONS))
                max_regions = cx_core.AABB_MAX_REGIONS
            _src, regs, _g, _lb, _nt = cx_core.resolve_regions(
                segs=segs, bbox=bbox,
                mask_frame=(masks[0] if (masks is not None and not has_other) else None),
                aabb=aabb, box_mode=box_mode, shape="bbox", pad=pad,
                label_filter=label_filter, H=H, W=W, max_regions=int(max_regions),
                sort_regions=bool(sort_regions))
            if not regs:
                if str(no_region_policy).strip().lower() == "passthrough":
                    print("[CX] 元数据模式：0 个区域 → passthrough 原图直出")
                    return image, torch.zeros((B, H, W), dtype=torch.float32, device=image.device)
                raise ValueError("没有可用的区域数据，无法写元数据（连接 segs/bbox/mask 或填 aabb）")
            frames, effs = _run_meta_write(image, arr, regs, key, password, MB, label)
            return _fin_meta(frames, effs, image, squeeze)
        else:
            frames, effs = _run_meta_read(arr, key, password, MB, label)
            return _fin_meta(frames, effs, image, squeeze)

    eff = np.zeros((B, H, W), bool)
    done_total = 0
    src_used, regions0, labels0 = cx_core.SOURCE_NONE, [], []

    if masks is not None and not has_other:
        # MASK 逐帧解析（每帧的框/掩膜可以不同）
        for b in range(B):
            frame = masks[0 if masks.shape[0] == 1 else b]
            src, regions, gates, labels, nt = cx_core.resolve_regions(
                mask_frame=frame, shape=shape, pad=pad, H=H, W=W,
                max_regions=max_regions, sort_regions=bool(sort_regions))
            if b == 0:
                src_used, labels0 = src, labels
                notes.extend(nt)
            if not regions:
                continue
            done_total += cx_core.scramble_array(
                arr[b], regions, key, password, unit, bool(soft), bool(encode),
                gates=gates, threshold=threshold)
            eff[b] = cx_core.effective_block_mask(H, W, regions, gates, unit, threshold)
            if b == 0:
                regions0 = regions
    else:
        src_used, regions, gates, labels, notes = cx_core.resolve_regions(
            segs=segs, bbox=bbox, aabb=aabb, box_mode=box_mode, shape=shape, pad=pad,
            label_filter=label_filter, H=H, W=W, max_regions=max_regions,
            sort_regions=bool(sort_regions))
        if not regions:
            if str(no_region_policy).strip().lower() == "passthrough":
                print("[CX] %s: 打框数据解析出 0 个区域 → passthrough 原图直出（%s）"
                      % (label, "aabb=%r 解析后为空" % aabb if aabb.strip() else "未连接 segs/bbox/mask"))
                return image, torch.zeros((B, H, W), dtype=torch.float32, device=image.device)
            raise ValueError(
                "没有可用的区域数据：请连接 segs / bbox / mask，或在 aabb 里写坐标"
                + ("（已给的 aabb=%r 解析后为空）" % aabb if aabb.strip() else "")
                + "；若希望空框时原图直出，把 no_region_policy 设为 passthrough")
        regions0, labels0 = regions, labels
        per_frame = 0
        for b in range(B):
            per_frame = cx_core.scramble_array(
                arr[b], regions, key, password, unit, bool(soft), bool(encode),
                gates=gates, threshold=threshold)
        done_total = per_frame * B
        eff[:] = cx_core.effective_block_mask(H, W, regions, gates, unit, threshold)

    if done_total == 0:
        if str(no_region_policy).strip().lower() == "passthrough":
            print("[CX] %s: 没有任何有效区域 → passthrough 原图直出" % label)
            return image, torch.zeros((B, H, W), dtype=torch.float32, device=image.device)
        raise ValueError("打框数据解析后没有任何有效区域（label 过滤掉了？框太小？框在图像外？）")

    secret_from, warn = cx_core.describe_secret(key, password)
    if warn:
        print("[CX][注意] " + warn)
    if regions0:
        seed_desc = "seed[0]=%d" % cx_core.region_seed(key, password, 0)
    else:
        seed_desc = "seed=—"
    secret_show = ("密码'%s'" % str(password)) if password else ("整数 %d" % int(key or 0))
    print("[CX] %s: %d×%d×%d 帧, 区域源=%s, %d 个区域, shape=%s pad=%d unit=%d soft=%d thr=%.2f\n"
          "     密码来源=%s（唯一秘密 = %s）, %s\n     区域: %s%s"
          % (label, W, H, B, src_used, len(regions0), shape, pad, unit, int(bool(soft)),
             threshold, secret_from, secret_show, seed_desc,
             _fmt_regions(regions0, labels0),
             ("\n     备注: " + "；".join(notes)) if notes else ""))

    if squeeze:
        arr = arr[..., :1]
    out_img = torch.from_numpy(np.ascontiguousarray(arr.astype(np.float32) / 255.0)).to(image.device)
    out_mask = torch.from_numpy(eff.astype(np.float32)).to(image.device)
    return out_img, out_mask


# --------------------------------------------------------------------------
#  V3 元数据模式：打码图自带区域表 → 还原只需要 图 + 密码（与网页端一致的用法）
# --------------------------------------------------------------------------
def _fin_meta(frames, effs, like, squeeze):
    """把 (B,H,W,C) uint8 帧 + 有效掩膜 打包成输出张量。"""
    out = np.stack(frames, axis=0)
    if squeeze:
        out = out[..., :1]
    img = torch.from_numpy(np.ascontiguousarray(out.astype(np.float32) / 255.0)).to(like.device)
    mask = torch.from_numpy(np.stack(effs, axis=0).astype(np.float32)).to(like.device)
    return img, mask


def _run_meta_write(image, arr, regions, key, password, B, label):
    """打码并把区域表写进外扩边框：输出 = 网页端 PNG 打码图（(H+2B)×(W+2B)）。"""
    secret = cx_core.secret_text(key, password)
    H, W = arr.shape[1], arr.shape[2]
    aligned = cx_core.align_regions_web(regions, W, H, B)
    if not aligned:
        raise ValueError("区域按 unit 对齐后为空（框比一个块还小？）")
    shifted = [(x + B, y + B, w, h) for (x, y, w, h) in aligned]
    frames, effs = [], []
    for b in range(arr.shape[0]):
        p = cx_core.pad_with_border(arr[b], B)
        cx_core.scramble_array(p, shifted, key, password, B, False, True)
        if not cx_core.v3_write_meta(p, aligned, secret, B):
            raise ValueError("边框装不下元数据（区域太多？）")
        frames.append(p)
        effs.append(cx_core.effective_block_mask(p.shape[0], p.shape[1], shifted, None, B, 0.5))
    print("[CX] %s（元数据模式）: %d×%d → %d×%d, %d 个区域写入 %dpx 边框\n"
          "     还原只需「这张图 + 密码」；签名=%d, %s"
          % (label, W, H, W + 2 * B, H + 2 * B, len(aligned), B,
             cx_core.v3_signature(len(aligned), aligned, secret),
             cx_core.describe_secret(key, password)[0]))
    return frames, effs


def _run_meta_read(arr, key, password, B, label):
    """只给图 + 密码：从边框读回区域表 → 校验密码签名 → 逆变换 → 裁掉边框。"""
    secret = cx_core.secret_text(key, password)
    frames, effs = [], []
    for b in range(arr.shape[0]):
        pm = cx_core.v3_read_meta(arr[b], B)
        if pm is None:
            raise ValueError(
                "这张图里没有 CX V3 打码元数据（边框 LSB）。请确认它是「带元数据的打码图」"
                "并且全程无损（PNG、未缩放）；否则就要显式接 segs/bbox/mask/aabb 再还原。")
        if pm["stored"] != cx_core.v3_signature(pm["cnt"], pm["regions"], secret):
            raise ValueError("密码不对：元数据签名不符（当前密码来源=%s，唯一秘密=%s）"
                             % (cx_core.describe_secret(key, password)[0],
                                ("'%s'" % password) if password else int(key or 0)))
        regs = [(x + B, y + B, w, h) for (x, y, w, h) in pm["regions"]]
        cx_core.scramble_array(arr[b], regs, key, password, B, bool(pm["flag"] & 8), False)
        eff = cx_core.effective_block_mask(arr.shape[1], arr.shape[2], regs, None, B, 0.5)
        frames.append(np.ascontiguousarray(arr[b][B:-B, B:-B]))
        effs.append(np.ascontiguousarray(eff[B:-B, B:-B]))
    print("[CX] %s（读元数据模式）: 从图里读到 %d 个区域，签名校验通过，已裁掉 %dpx 边框\n"
          "     区域: %s"
          % (label, len(regs), B,
             " ".join("(%d,%d,%d,%d)" % r for r in pm["regions"][:8])))
    return frames, effs


def _common_optional_inputs(with_boxes=True, with_meta=False):
    """两个节点共用的可选参数（顺序即 UI 顺序）。"""
    ins = []
    if with_boxes:
        ins += [
            io.Custom(SEGS_TYPE).Input("segs", optional=True, tooltip=_SEGS_DOC),
            io.Custom(BBOX_TYPE).Input("bbox", optional=True, tooltip=_BBOX_DOC),
            io.Mask.Input("mask", optional=True, tooltip=_MASK_DOC),
        ]
    ins += [
        io.String.Input("aabb", multiline=True, default="", optional=True, tooltip=_AABB_DOC),
        io.Int.Input("key", default=0, min=-2147483648, max=2147483647, step=1,
                     display_mode=io.NumberDisplay.number,
                     display_name="int (key · 密码留空时才用)", tooltip=_KEY_DOC),
        io.Combo.Input("region_shape", options=list(cx_core.SHAPES), default="bbox",
                       tooltip=_SHAPE_DOC),
        io.Int.Input("pad", default=0, min=0, max=512, step=1, advanced=True, tooltip=_PAD_DOC),
        io.Int.Input("max_regions", default=32, min=1, max=256, step=1, advanced=True,
                     tooltip=_MAXR_DOC),
        io.Float.Input("mask_threshold", default=0.5, min=0.0, max=1.0, step=0.05,
                       advanced=True, tooltip=_THRESH_DOC),
        io.String.Input("label_filter", default="", multiline=False, advanced=True,
                        tooltip=_LABEL_DOC),
        io.Boolean.Input("sort_regions", default=True, advanced=True, tooltip=_SORT_DOC),
        io.Combo.Input("unit", options=list(cx_core.UNIT_CHOICES), default=8, advanced=True,
                       tooltip=_UNIT_DOC),
        io.Boolean.Input("soft", default=False, advanced=True, tooltip=_SOFT_DOC),
        io.String.Input("password", default="", multiline=False, advanced=True,
                        display_name="password（唯一密钥）", tooltip=_PASSWORD_DOC),
        io.Combo.Input("box_mode", options=list(cx_core.BOX_MODES), default="xywh",
                       advanced=True, tooltip=_MODES_DOC),
        # ↓ 以下两项是后加的：**必须留在末尾**，否则已保存工作流里的控件值会整体位移
        io.Combo.Input("no_region_policy", options=["error", "passthrough"], default="error",
                       optional=True, advanced=True, tooltip=_POLICY_DOC),
    ]
    if with_meta:
        ins.append(io.Boolean.Input("embed_meta", default=False, optional=True,
                                    tooltip=_META_DOC))
    return ins


class CXRegionScramble(io.ComfyNode):
    """按打框数据（SEGS/BBOX/MASK）把图片对应区域打成不可读乱码（cx-E2EE V3 区域打码算法）。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CX_RegionScramble",
            display_name="CX 图片区域混淆（打码）",
            category=CATEGORY,
            description="直接吃检测模型输出的打框数据：SEGS（bbox/segm 模型）、BBOX、MASK，"
                        "或手写 aabb。框内做 unit×unit 块置换 + YUV 域扰动，不可读。\n"
                        "第二个输出是「实际被改动的区域掩膜」，接 MaskPreview 可直接核对打框对不对。\n"
                        "还原用「CX 图片区域还原」，参数与打框数据必须完全一致。",
            search_aliases=["打码", "混淆", "scramble", "obfuscate", "马赛克", "区域置换",
                            "seg", "segs", "bbox", "detector", "yolo", "sam", "mask",
                            "cx E2EE", "censor", "region"],
            inputs=[io.Image.Input("image", tooltip="输入图像（支持批次，逐帧处理）")]
                   + _common_optional_inputs(with_boxes=True, with_meta=True),
            outputs=[
                io.Image.Output(display_name="IMAGE"),
                io.Mask.Output(display_name="MASK", tooltip="实际被改动的区域掩膜（可视化核对用）"),
            ],
        )

    @classmethod
    def execute(cls, image, segs=None, bbox=None, mask=None, aabb="", key=0,
                region_shape="bbox", pad=0, max_regions=32, mask_threshold=0.5,
                label_filter="", sort_regions=True, no_region_policy="error",
                embed_meta=False, unit=8, soft=False,
                password="", box_mode="xywh") -> io.NodeOutput:
        img, m = _run(image, segs, bbox, mask, aabb, box_mode, region_shape, pad,
                      mask_threshold, label_filter, sort_regions, max_regions, no_region_policy,
                      embed_meta, key, password, unit, soft, True, "区域打码")
        return io.NodeOutput(img, m)


class CXRegionUnscramble(io.ComfyNode):
    """按同一份打框数据 + key 还原（区域重叠时按网页端语义倒序还原）。"""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="CX_RegionUnscramble",
            display_name="CX 图片区域还原",
            category=CATEGORY,
            description="还原「CX 图片区域混淆」处理过的图。\n"
                        "必须与打码时**完全相同**：打框数据（同一份 SEGS/BBOX/MASK 或同一段 aabb）、"
                        "key/password、region_shape、pad、max_regions、label_filter、sort_regions、"
                        "mask_threshold、unit、soft。\n"
                        "建议把检测结果缓存复用，不要重跑检测器（框变了就对不上）。",
            search_aliases=["还原", "解混淆", "unscramble", "descramble", "还原打码",
                            "segs", "bbox", "mask", "cx E2EE"],
            inputs=[io.Image.Input("image", tooltip="被打码的图像（支持批次）")]
                   + _common_optional_inputs(with_boxes=True),
            outputs=[
                io.Image.Output(display_name="IMAGE"),
                io.Mask.Output(display_name="MASK", tooltip="使用到的区域掩膜（可视化核对用）"),
            ],
        )

    @classmethod
    def execute(cls, image, segs=None, bbox=None, mask=None, aabb="", key=0,
                region_shape="bbox", pad=0, max_regions=32, mask_threshold=0.5,
                label_filter="", sort_regions=True, no_region_policy="error",
                embed_meta=False, unit=8, soft=False,
                password="", box_mode="xywh") -> io.NodeOutput:
        img, m = _run(image, segs, bbox, mask, aabb, box_mode, region_shape, pad,
                      mask_threshold, label_filter, sort_regions, max_regions, no_region_policy,
                      False, key, password, unit, soft, False, "区域还原")
        return io.NodeOutput(img, m)


class CXImageScrambleExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [CXRegionScramble, CXRegionUnscramble]


async def comfy_entrypoint() -> CXImageScrambleExtension:
    return CXImageScrambleExtension()

# -*- coding: utf-8 -*-
"""
cx_core.py — CX-E2EE「图片区域混淆 / 区域打码」算法核（Python + NumPy）

来源：cx-E2EE 项目 src/image-crypto.js 的 V3 区域打码路径
      IA.hash / IA.rng / IA.perm / IA.regionEnc（PNG 路径 unit=8；Jpeg 鲁棒路径 unit=16）

本移植目标是 **逐位等价**：同一张图、同一 aabb、同一 key，
本模块输出与浏览器端 regionEnc 的输出字节完全相同（见 tests/js_parity/）。

算法（单区域）：
  1. 区域按 unit 对齐成 bx×by 个 unit×unit 块（加密端左/上 floor、右/下回落到完整块）；
  2. seed → xorshift32 PRNG → Fisher-Yates 置换表 p[bl]，块级位置置换；
  3. 每块一组扰动参数（由同一 PRNG 派生）：ns 亮度偏移(±40 或 soft 下 ±16)、
     fU/fV 色度分量取反、sw U/V 互换；
  4. 像素域：RGB → YUV，Y 压缩到 [50,205]（soft：[20,235]）再加 ns，色度按参数翻转，
     YUV → RGB，写入 Uint8Clamped 语义（四舍五入到偶 + 钳制）。
  解密为完全逆过程（块置换取逆、扰动顺序取逆、Y 展开），故 unit/soft 必须与加密一致。

注意：JS 的位运算全部按 ToInt32/ToUint32 语义，本文件用 _i32/_u32/_imul/_xor 精确复刻，
      所以置换表与扰动参数在两种语言下逐元素相同。
"""

from __future__ import annotations

import math
import re

import numpy as np

__all__ = [
    "AABB_MAX_REGIONS",
    "UNIT_CHOICES",
    "BOX_MODES",
    "SHAPES",
    "SOURCE_PRIORITY",
    "cx_hash",
    "secret_text",
    "region_seed",
    "describe_secret",
    "parse_aabb",
    "region_enc",
    "scramble_array",
    "scramble_image",
    # 打框数据 → 区域
    "as_seg_list",
    "segs_regions",
    "bbox_data_regions",
    "mask_regions",
    "aabb_regions",
    "resolve_regions",
    "effective_block_mask",
    "clamp_rect",
]

AABB_MAX_REGIONS = 12          # 与网页端一致：最多 12 个区域
UNIT_CHOICES = (8, 16, 32, 64)  # 8=PNG 无损路径；16=JPEG 拍屏鲁棒路径
BOX_MODES = ("xywh", "xyxy")


# --------------------------------------------------------------------------
# JS 数值语义（ToInt32 / ToUint32 / Math.imul / ^ / >>>）
# --------------------------------------------------------------------------
def _u32(x) -> int:
    return int(x) & 0xFFFFFFFF


def _i32(x) -> int:
    v = int(x) & 0xFFFFFFFF
    return v - 0x100000000 if v >= 0x80000000 else v


def _xor(a, b) -> int:
    return _i32(_u32(a) ^ _u32(b))


def _imul(a, b) -> int:
    """Math.imul(a,b)：ToInt32(a)*ToInt32(b) 截断到 int32。"""
    return _i32(_u32(a) * _u32(b))


def _ushr(a, n: int) -> int:
    """a >>> n"""
    return _u32(a) >> n


# --------------------------------------------------------------------------
# IA.hash —— 与网页端逐字符一致（UTF-16 code unit，非 Unicode 码点）
# --------------------------------------------------------------------------
def _utf16_units(s: str):
    b = s.encode("utf-16-le", "surrogatepass")
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


def cx_hash(s: str) -> int:
    """cx-E2EE IA.hash(s)：返回 h1+h2+h3+h4（JS Number，可能超出 int32 范围）。"""
    h1, h2, h3, h4 = 1779033703, 3144134277, 1013904242, 2773480762
    for k in _utf16_units(s):
        h1 = _xor(h2, _imul(_xor(h1, k), 597399067))
        h2 = _xor(h3, _imul(_xor(h2, k), 2869860233))
        h3 = _xor(h4, _imul(_xor(h3, k), 951274213))
        h4 = _xor(h1, _imul(_xor(h4, k), 2716044179))
    return h1 + h2 + h3 + h4


def secret_text(key, password: str) -> str:
    """
    **唯一秘密**的文本形式。

    网页端自始至终只用**一个密码** k，区域 seed = `IA.hash(k + '#' + 区域序号)`；
    本节点把它统一成「一个秘密」：
        password 非空 → 秘密就是 password 本身（与网页端一字不差）
        password 为空 → 秘密是 int key 的十进制字符串（纯整数场景的写法糖）
    因此 `key=12345` 与 `password="12345"` 得到**完全相同**的种子，不是两个密钥。
    """
    pw = "" if password is None else str(password)
    return pw if pw else str(int(key))


def region_seed(key, password: str, index: int) -> int:
    """
    第 index 个区域的 seed = IA.hash(唯一秘密 + '#' + index)（与网页端同一套推导）。

    返回值按 ToInt32 规范化（下游只取 mod 2^32，故等价）。
    """
    return _i32(cx_hash("%s#%d" % (secret_text(key, password), index)))


def describe_secret(key, password: str):
    """
    返回 (实际生效的来源, 提示语或 None)。
    给 password 又给非 0 的 key 时，明确告诉你 key 被忽略 —— 而不是静默。
    """
    pw = "" if password is None else str(password)
    k = int(key or 0)
    if pw and k != 0:
        return "password", (
            "同时给了 password=%r 和 key=%d：只使用 password，key 被忽略"
            "（两者本就是同一个秘密的两种写法，key=%d 等价于 password=\"%d\"）" % (pw, k, k, k)
        )
    return ("password" if pw else "int key"), None


# --------------------------------------------------------------------------
# IA.rng / IA.perm
# --------------------------------------------------------------------------
def _rng(a):
    """JS 的 xorshift32 变体：state 以 double 累加、按 ToInt32 参与位运算。"""
    state = int(a)
    while True:
        state = state + 0x6D2B79F5
        t = _i32(state)
        t = _imul(_xor(t, _ushr(t, 15)), t | 1)
        t = _xor(t, t + _imul(_xor(t, _ushr(t, 7)), t | 61))
        yield _ushr(_xor(t, _ushr(t, 14)), 0) / 4294967296.0


def _perm(length: int, seed: int):
    """IA.perm：Fisher-Yates，返回 list[int]（等价 Uint32Array）。"""
    r = _rng(seed)
    p = list(range(length))
    for i in range(length - 1, 0, -1):
        j = math.floor(next(r) * (i + 1))
        p[i], p[j] = p[j], p[i]
    return p


# --------------------------------------------------------------------------
# aabb 解析
# --------------------------------------------------------------------------
_NUM_RE = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")


def parse_aabb(text: str, box_mode: str = "xywh", img_w: int = 0, img_h: int = 0,
               max_regions: int = AABB_MAX_REGIONS):
    """
    解析 aabb 字符串 → [(x, y, w, h), ...]（已按图像边界钳制）。

    语法（宽松）：
      - 单区域：  "100,50,64,64"
      - 多区域：  "100,50,64,64; 200,100,32,32"（分隔符 ; | 换行 均可）
      - 括号/空格随意："[[100 50 64 64], [200,100,32,32]]"
      - 空串 / "all" / "full" → 整张图
    box_mode:
      - "xywh"：x,y,w,h（网页端 MOB.regions 的格式，默认）
      - "xyxy"：x1,y1,x2,y2
    """
    mode = (box_mode or "xywh").strip().lower()
    if mode not in BOX_MODES:
        raise ValueError("box_mode 只能是 %s，收到 %r" % (list(BOX_MODES), box_mode))
    text = "" if text is None else str(text)
    raw = text.strip()
    if raw == "" or raw.lower() in ("all", "full", "*"):
        return [(0, 0, int(img_w), int(img_h))]

    cleaned = re.sub(r"\]\s*[,;]?\s*\[", ";", raw)   # "]["/"] , [" → 区域分隔
    cleaned = re.sub(r"[\[\](){}]", " ", cleaned)
    tokens = [t for t in re.split(r"[;\n|]+", cleaned) if t.strip()]
    out = []
    for i, tok in enumerate(tokens):
        nums = _NUM_RE.findall(tok)
        if len(nums) != 4:
            # 宽松：一段里写满 8/12 个数字时按每 4 个切分（"10 10 20 20 30 30 10 10"）
            if len(nums) > 4 and len(nums) % 4 == 0:
                groups = [nums[k:k + 4] for k in range(0, len(nums), 4)]
            else:
                raise ValueError(
                    "aabb 第 %d 段需要 4 个数字（%s），实际解析到 %d 个：%r"
                    % (i + 1, "x,y,w,h" if mode == "xywh" else "x1,y1,x2,y2", len(nums), tok.strip())
                )
        else:
            groups = [nums]
        for g in groups:
            a, b, c, d = (int(round(float(v))) for v in g)
            if mode == "xywh":
                x, y, w, h = a, b, c, d
            else:
                x, y, w, h = a, b, c - a, d - b
            if w <= 0 or h <= 0:
                raise ValueError("aabb 第 %d 段宽/高必须 > 0，实际 %dx%d" % (i + 1, w, h))
            # 钳制到图像边界（网页端 MOB.norm 同样钳制）
            x0 = max(0, min(x, img_w))
            y0 = max(0, min(y, img_h))
            x2 = max(0, min(x + w, img_w))
            y2 = max(0, min(y + h, img_h))
            if x2 <= x0 or y2 <= y0:
                continue  # 完全在图像外 → 跳过
            out.append((x0, y0, x2 - x0, y2 - y0))

    if not out:
        raise ValueError("aabb 解析后没有落在图像内的区域，请检查坐标：%r" % text)
    if len(out) > int(max_regions):
        raise ValueError("aabb 区域数量 %d 超过上限 %d（网页端元数据上限为 %d）"
                         % (len(out), int(max_regions), AABB_MAX_REGIONS))
    return out


# --------------------------------------------------------------------------
# 区域块置换 + YUV 扰动（regionEnc 的等价实现）
# --------------------------------------------------------------------------
_BLOCK_CHUNK = 4096  # 每次处理的块数（控制峰值内存，不影响结果）


def _region_block_span(x, y, w, h, W, H, unit):
    """regionEnc 的块对齐规则（左/上 floor，右/下 ceil 后回落完整块）。"""
    u = unit
    x0 = (x // u) * u
    y0 = (y // u) * u
    x1 = min(W, -(-(x + w) // u) * u)
    y1 = min(H, -(-(y + h) // u) * u)
    x1 = x0 + ((x1 - x0) // u) * u
    y1 = y0 + ((y1 - y0) // u) * u
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _block_transform(src, ns, fU, fV, sw, encode: bool, soft: bool):
    """
    src: (bl, u*u, 3) float64；ns/fU/fV/sw 均为 (bl,)（按块广播）
    返回 float64，未做 uint8 取整（调用方统一 rint+clamp+astype）。
    """
    R = src[..., 0]
    G = src[..., 1]
    B = src[..., 2]
    # JS: Y = .299*R + .587*G + .114*B（左结合，这里保持同序）
    Y = 0.299 * R + 0.587 * G + 0.114 * B
    U = -0.147 * R - 0.289 * G + 0.436 * B
    V = 0.615 * R - 0.515 * G - 0.1 * B

    ns_b = ns[:, None]
    fU_b = fU[:, None]
    fV_b = fV[:, None]
    sw_b = sw[:, None]

    if encode:
        # CM：亮度动态范围压缩（soft 时加宽，抗 JPEG 逐块量化误差）
        if soft:
            Y = 20.0 + (Y / 255.0) * 215.0
        else:
            Y = 50.0 + (Y / 255.0) * 155.0
        Y = Y + ns_b
        U2 = np.where(sw_b, V, U)
        V2 = np.where(sw_b, U, V)
        U2 = np.where(fU_b, -U2, U2)
        V2 = np.where(fV_b, -V2, V2)
    else:
        V2 = np.where(fV_b, -V, V)
        U2 = np.where(fU_b, -U, U)
        U2, V2 = np.where(sw_b, V2, U2), np.where(sw_b, U2, V2)
        Y = Y - ns_b
        # EX：逆 CM 并钳制
        if soft:
            Y = np.clip((Y - 20.0) / 215.0, 0.0, 1.0) * 255.0
        else:
            Y = np.clip((Y - 50.0) / 155.0, 0.0, 1.0) * 255.0

    R2 = Y + 1.14 * V2
    G2 = Y - 0.395 * U2 - 0.581 * V2
    B2 = Y + 2.032 * U2
    return np.stack((R2, G2, B2), axis=-1)


def region_enc(arr_u8, x, y, w, h, seed, encode: bool, soft: bool, unit: int = 8,
               gate=None, threshold: float = 0.5):
    """
    就地对 3 通道 uint8 数组执行 / 逆执行区域混淆（等价 IA.regionEnc）。

    arr_u8 : (H, W, 3) uint8，**会被原地修改**
    seed   : int（区域 seed，见 region_seed）
    encode : True=打码，False=还原
    soft   : JPEG 友好亮度域（网页端 flag bit3）
    unit   : 8（PNG）或 16（JPEG 拍屏鲁棒）
    gate   : None 或 (H, W) 的 bool/float 掩膜 —— 「块级门」。
             把 gate 按 unit 分块取均值，均值 >= threshold 的块才参与置换。
             None = 区域内所有块都参与（＝网页端行为，逐位等价）。
             门只决定「哪些块参与」，置换表建在参与块之间：
             **同一份 gate 才能还原**（分割掩膜形状级打码）。
    返回   : True=已处理，False=区域退化（太小/在图像外/门全灭）
    """
    H, W = arr_u8.shape[0], arr_u8.shape[1]
    unit = int(unit)
    if unit <= 0:
        raise ValueError("unit 必须为正整数，收到 %r" % unit)
    span = _region_block_span(int(x), int(y), int(w), int(h), W, H, unit)
    if span is None:
        return False
    x0, y0, x1, y1 = span
    u = unit
    bx = (x1 - x0) // u
    by = (y1 - y0) // u
    bl = bx * by

    region = arr_u8[y0:y1, x0:x1, :3].astype(np.float64)
    blocks = (
        region.reshape(by, u, bx, u, 3)
        .transpose(0, 2, 1, 3, 4)
        .reshape(bl, u * u, 3)
    )

    # 块级门：把 gate 按块取均值，>= threshold 的块进入置换集合
    if gate is None:
        sel = None          # None = 全部块，走与网页端完全相同的下标序列
        k = bl
    else:
        g = np.asarray(gate)
        if g.shape[0] < y1 or g.shape[1] < x1:
            raise ValueError("gate 尺寸 %r 小于区域右/下边界 (%d,%d)" % (g.shape, x1, y1))
        blk = g[y0:y1, x0:x1].astype(np.float32, copy=False).reshape(by, u, bx, u)
        selbool = blk.mean(axis=(1, 3)) >= float(threshold)
        k = int(selbool.sum())
        if k == 0:
            return False
        if k == bl:
            sel = None      # 门把整框都选上了 → 退化成普通矩形区域
        else:
            sel = np.flatnonzero(selbool.ravel()).astype(np.intp)

    seed = _i32(seed)
    p = _perm(k, seed)
    nr = _rng(seed + 999)
    cm = np.fromiter((math.floor(next(nr) * 1e6) for _ in range(k)), dtype=np.int64, count=k)

    p_arr = np.asarray(p, dtype=np.intp)
    # 扰动参数按「循环下标 t」索引，取 cm[p[t]]（与 JS 的 rw = cm[E ? di : si] 等价）
    cm_i = cm[p_arr]
    if soft:
        ns = (cm_i % 33) - 16
    else:
        ns = (cm_i % 81) - 40
    fU = (cm_i & 0x100) != 0
    fV = (cm_i & 0x200) != 0
    sw = (cm_i & 0x400) != 0

    if sel is None:
        src_e, dst_e = np.arange(bl, dtype=np.intp), p_arr
        src_d, dst_d = p_arr, np.arange(bl, dtype=np.intp)
    else:
        src_e, dst_e = sel, sel[p_arr]
        src_d, dst_d = sel[p_arr], sel

    out = blocks.copy()   # 未参与的块原样带过（门模式下必须保留）
    for s in range(0, k, _BLOCK_CHUNK):
        e = min(k, s + _BLOCK_CHUNK)
        if encode:
            # 目标块 dst_e[t] ← 源块 src_e[t]（源读原始数据，故可整块向量化）
            out[dst_e[s:e]] = _block_transform(
                blocks[src_e[s:e]], ns[s:e], fU[s:e], fV[s:e], sw[s:e], True, soft
            )
        else:
            # 目标块 dst_d[t] ← 源块 src_d[t]
            out[dst_d[s:e]] = _block_transform(
                blocks[src_d[s:e]], ns[s:e], fU[s:e], fV[s:e], sw[s:e], False, soft
            )

    # Uint8ClampedArray 语义：round-half-to-even + 钳制 [0,255]
    out = np.clip(np.rint(out), 0.0, 255.0).astype(np.uint8)
    arr_u8[y0:y1, x0:x1, :3] = (
        out.reshape(by, bx, u, u, 3).transpose(0, 2, 1, 3, 4).reshape(by * u, bx * u, 3)
    )
    return True


def scramble_array(arr_u8, regions, key=0, password: str = "", unit: int = 8,
                   soft: bool = False, encode: bool = True, gates=None,
                   threshold: float = 0.5):
    """
    对 (H,W,C) uint8 数组按多个区域执行混淆/还原（原地）。C>=3 时只动前 3 通道。

    regions : [(x, y, w, h), ...]
    gates   : None 或与 regions 等长的列表，每项 None 或 (H,W) 掩膜（见 region_enc）
    多区域顺序与网页端一致：
      加密 idx=0..n-1 顺序处理；解密倒序处理（区域重叠时才能正确还原）。
    """
    if arr_u8.ndim != 3 or arr_u8.shape[2] < 3:
        raise ValueError("需要 (H, W, C>=3) 的 uint8 数组，收到 %r" % (arr_u8.shape,))
    if gates is not None and len(gates) != len(regions):
        raise ValueError("gates 长度 %d 与 regions 长度 %d 不一致" % (len(gates), len(regions)))
    idxs = range(len(regions) - 1, -1, -1) if not encode else range(len(regions))
    done = 0
    for i in idxs:
        x, y, w, h = regions[i]
        gate = None if gates is None else gates[i]
        seed = region_seed(key, password, i)
        if region_enc(arr_u8, x, y, w, h, seed, encode, soft, unit, gate, threshold):
            done += 1
    return done


def scramble_image(arr_u8, aabb: str, key=0, password: str = "", box_mode: str = "xywh",
                   unit: int = 8, soft: bool = False, encode: bool = True):
    """便捷入口：(H,W,C) uint8 + aabb 字符串 → 原地处理，返回处理到的区域数。"""
    if arr_u8.ndim != 3:
        raise ValueError("需要 (H, W, C) 的 uint8 数组，收到 %r" % (arr_u8.shape,))
    H, W = arr_u8.shape[0], arr_u8.shape[1]
    regions = parse_aabb(aabb, box_mode, W, H)
    return scramble_array(arr_u8, regions, key, password, unit, soft, encode)


# ==========================================================================
#  打框数据 → 区域
#  SEGS（UltralyticsDetectorProvider 的 bbox / segm 模型都汇成 SEGS）
#  / 通用 BBOX 数据 / MASK 掩膜 / 手写 aabb
# ==========================================================================
SOURCE_SEGS = "segs"
SOURCE_BBOX = "bbox"
SOURCE_MASK = "mask"
SOURCE_AABB = "aabb"
SOURCE_NONE = "none"
SOURCE_PRIORITY = (SOURCE_SEGS, SOURCE_BBOX, SOURCE_MASK, SOURCE_AABB)
SHAPES = ("bbox", "mask")

_NUM_TYPES = (int, float, np.integer, np.floating)


def _to_numpy(x):
    """torch.Tensor / numpy / 标量 → numpy（不 import torch，靠鸭子类型）。"""
    if x is None:
        return None
    if hasattr(x, "detach"):          # torch.Tensor
        x = x.detach().to("cpu")
        x = x.numpy() if not x.requires_grad else x.numpy()
    return np.asarray(x)


def _fit(arr2d, h: int, w: int):
    """把二维数组按最近邻塞进 (h, w)（形状已一致时直接返回）。"""
    a = _to_numpy(arr2d)
    a = np.squeeze(a)
    if a.ndim != 2:
        raise ValueError("掩膜应为二维，收到 shape=%r" % (a.shape,))
    ch, cw = a.shape
    if (ch, cw) == (h, w):
        return a
    if h <= 0 or w <= 0 or ch <= 0 or cw <= 0:
        return np.zeros((max(h, 0), max(w, 0)), a.dtype)
    yi = np.minimum((np.arange(h) * ch) // h, ch - 1)
    xi = np.minimum((np.arange(w) * cw) // w, cw - 1)
    return a[np.ix_(yi, xi)]


def clamp_rect(x, y, w, h, W: int, H: int, pad: int = 0):
    """按 pad 外扩后钳制到图像内；退化返回 None。"""
    try:
        x = float(x); y = float(y); w = float(w); h = float(h)
    except (TypeError, ValueError):
        return None
    if not np.isfinite([x, y, w, h]).all():
        return None
    ax0 = int(round(x)) - int(pad)
    ay0 = int(round(y)) - int(pad)
    ax1 = int(round(x + w)) + int(pad)
    ay1 = int(round(y + h)) + int(pad)
    ax0 = max(0, min(ax0, W)); ay0 = max(0, min(ay0, H))
    ax1 = max(0, min(ax1, W)); ay1 = max(0, min(ay1, H))
    if ax1 <= ax0 or ay1 <= ay0:
        return None
    return (ax0, ay0, ax1 - ax0, ay1 - ay0)


def _item_rect_label(item):
    """从 SEG namedtuple / 带 .bbox 的对象 / dict / 4 元组 / ndarray 行 里取 (x,y,w,h,label)。"""
    label = ""
    if isinstance(item, dict):
        b = item.get("bbox", item.get("box"))
        label = str(item.get("label", "") or "")
    else:
        b = getattr(item, "bbox", None)
        label = str(getattr(item, "label", "") or "")
        if b is None and isinstance(item, (list, tuple)) and len(item) == 4 \
                and all(isinstance(v, _NUM_TYPES) for v in item):
            b = item
    if b is None and not isinstance(item, (str, bytes)):
        # 裸的 4 元素序列：numpy 行 / torch 行 / 普通 list
        try:
            a = _to_numpy(item).reshape(-1)
        except Exception:  # noqa: BLE001
            a = None
        if a is not None and a.size >= 4 and isinstance(a[0], _NUM_TYPES):
            b = a
    if b is None:
        return None
    arr = _to_numpy(b).reshape(-1)
    if arr.size < 4:
        return None
    return (float(arr[0]), float(arr[1]), float(arr[2]), float(arr[3]), label)


def as_seg_list(segs):
    """
    SEGS → list[SEG]。

    Impact Pack 的实际形态是 **`((H, W), [SEG, ...])` 元组**
    （见 core.mask_to_segs / detectors 里的返回值），旧代码里也有裸 `list[SEG]` 的写法，两种都收。
    """
    if segs is None:
        return []
    if isinstance(segs, dict) and "segs" in segs:
        segs = segs["segs"]
    for attr in ("segs", "items"):
        if not isinstance(segs, (list, tuple)) and hasattr(segs, attr):
            segs = getattr(segs, attr)
            break
    if isinstance(segs, tuple) and len(segs) == 2 and isinstance(segs[1], (list, tuple)):
        first = segs[0]
        looks_like_shape = (
            first is None
            or isinstance(first, np.ndarray)
            or (isinstance(first, (list, tuple)) and len(first) == 2
                and all(isinstance(v, _NUM_TYPES) for v in first))
        )
        if looks_like_shape:
            segs = segs[1]
    if isinstance(segs, tuple):
        segs = list(segs)
    if not isinstance(segs, list):
        raise ValueError("SEGS 输入应为 ((H,W), [SEG,...]) 或 list[SEG]，收到 %r" % (type(segs),))
    return segs


def _seg_rect(bbox, label=""):
    """
    SEG.bbox → (x, y, w, h)。

    **Impact Pack 的 SEG.bbox 是 (x1, y1, x2, y2)**（与 crop_region 同坐标系，
    见 utils.make_crop_region / core.mask_to_segs），这里按 xyxy 换算；
    若遇到明显不合 xyxy 的数据（第 3/4 个数比第 1/2 个还小）则按 xywh 兜底。
    """
    a = _to_numpy(bbox).reshape(-1)
    if a.size < 4:
        return None
    x1, y1, x2, y2 = (float(a[0]), float(a[1]), float(a[2]), float(a[3]))
    if x2 < x1 or y2 < y1:
        return (x1, y1, x2, y2, label)          # 已经是 xywh
    return (x1, y1, x2 - x1, y2 - y1, label)    # xyxy → xywh


def _label_ok(label: str, wanted) -> bool:
    if not wanted:
        return True
    return label.strip().lower() in wanted


def _parse_label_filter(label_filter: str):
    if not label_filter:
        return None
    parts = [p.strip().lower() for p in re.split(r"[,;|\s]+", str(label_filter)) if p.strip()]
    return set(parts) or None


def segs_regions(segs, H: int, W: int, pad: int = 0, label_filter: str = "",
                 shape: str = "bbox", max_regions: int = 32, sort_regions: bool = True):
    """
    SEGS → (regions, gates, labels)。bbox 模型与 segm 模型都走这里。

    shape="bbox"：只用 seg.bbox 的矩形（gate=None，等价网页端矩形打码）
    shape="mask"：额外用 seg.cropped_mask（放在 seg.crop_region 上）拼一张全图掩膜做块级门，
                  segm 模型就能按分割形状打码；纯 bbox 检测器的 cropped_mask 通常是整块 1，退化成矩形。
    """
    lst = as_seg_list(segs)
    if shape not in SHAPES:
        raise ValueError("shape 只能是 %s，收到 %r" % (list(SHAPES), shape))
    want = _parse_label_filter(label_filter)
    kept = []
    skipped_label = 0
    for it in lst:
        if isinstance(it, dict):
            bbox = it.get("bbox", it.get("box"))
            label = str(it.get("label", "") or "")
        else:
            bbox = getattr(it, "bbox", None)
            label = str(getattr(it, "label", "") or "")
        if bbox is None:
            continue
        rl = _seg_rect(bbox, label)       # Impact: bbox 是 xyxy
        if rl is None:
            continue
        if not _label_ok(rl[4], want):
            skipped_label += 1
            continue
        rect = clamp_rect(rl[0], rl[1], rl[2], rl[3], W, H, pad)
        if rect is None:
            continue
        kept.append((rect, rl[4], it))

    if sort_regions:
        # 让 seed 与检测顺序解耦：同一批框即使被检测器打乱顺序，加/解密仍一致
        kept.sort(key=lambda t: (t[1], t[0][1], t[0][0], t[0][2], t[0][3]))

    truncated = 0
    if max_regions and len(kept) > max_regions:
        truncated = len(kept) - max_regions
        kept = kept[:max_regions]

    regions = [t[0] for t in kept]
    labels = [t[1] for t in kept]
    gates = None
    if shape == "mask" and regions:
        gate = np.zeros((H, W), np.float32)
        for rect, _lb, it in kept:
            cm = getattr(it, "cropped_mask", None)
            if cm is None and isinstance(it, dict):
                cm = it.get("cropped_mask")
            cr = getattr(it, "crop_region", None)
            if cr is None and isinstance(it, dict):
                cr = it.get("crop_region")
            if cm is None:
                continue
            if cr is not None:
                a = _to_numpy(cr).reshape(-1)
                x1, y1, x2, y2 = (int(a[0]), int(a[1]), int(a[2]), int(a[3])) if a.size >= 4 else \
                                 (rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3])
            else:
                x1, y1, x2, y2 = rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]
            x1 = max(0, min(x1, W)); y1 = max(0, min(y1, H))
            x2 = max(0, min(x2, W)); y2 = max(0, min(y2, H))
            if x2 <= x1 or y2 <= y1:
                continue
            sub = np.clip(_fit(cm, y2 - y1, x2 - x1).astype(np.float32, copy=False), 0.0, 1.0)
            np.maximum(gate[y1:y2, x1:x2], sub, out=gate[y1:y2, x1:x2])
        gates = [gate] * len(regions)
    return regions, gates, labels, truncated, skipped_label


def bbox_data_regions(bbox, H: int, W: int, pad: int = 0, max_regions: int = 32,
                      box_mode: str = "xywh"):
    """
    通用 BBOX 数据 → regions。
    接受：单框 / 框列表 [(x,y,w,h), ...] / torch (N,4) 或 (4,) /
          带 .bbox 的对象列表 / dict{"bboxes": ...}。
    box_mode：xywh（默认）或 xyxy（与节点的 box_mode 同一个开关）。
    """
    if bbox is None:
        return [], 0
    xyxy = str(box_mode or "xywh").strip().lower() == "xyxy"
    items = bbox
    if hasattr(items, "bboxes") and not isinstance(items, (list, tuple)):
        items = items.bboxes
    if isinstance(items, dict):
        items = items.get("bboxes", items.get("boxes", items.get("bbox", [])))
    if not isinstance(items, (list, tuple)):
        arr = _to_numpy(items)
        items = [arr] if arr.ndim == 1 else list(arr)
    elif len(items) == 4 and all(isinstance(v, _NUM_TYPES) for v in items):
        items = [items]

    regions, truncated = [], 0
    for it in items:
        rl = _item_rect_label(it)
        if rl is None:
            continue
        if xyxy:
            rl = (rl[0], rl[1], rl[2] - rl[0], rl[3] - rl[1], rl[4])
        rect = clamp_rect(rl[0], rl[1], rl[2], rl[3], W, H, pad)
        if rect is None:
            continue
        regions.append(rect)
    if max_regions and len(regions) > max_regions:
        truncated = len(regions) - max_regions
        regions = regions[:max_regions]
    return regions, truncated


def mask_regions(mask_frame, H: int, W: int, shape: str = "bbox", pad: int = 0,
                 threshold: float = 0.0, max_regions: int = 32):
    """
    单帧 MASK → (regions, gates)。

    shape="mask"：整个掩膜外接框作为区域 + 掩膜本身做块级门（分割形状级打码）
    shape="bbox" ：只取掩膜非零区的外接框（矩形打码，不做形状门）
    """
    if shape not in SHAPES:
        raise ValueError("shape 只能是 %s，收到 %r" % (list(SHAPES), shape))
    a = _to_numpy(mask_frame)
    a = np.squeeze(a)
    if a.ndim == 3 and a.shape[0] == 1:
        a = a[0]
    if a.ndim != 2:
        raise ValueError("MASK 单帧应为二维，收到 shape=%r" % (a.shape,))
    if a.shape != (H, W):
        a = _fit(a, H, W)
    hit = a > 0.5
    if not hit.any():
        return [], None
    ys, xs = np.nonzero(hit)
    rect = clamp_rect(xs.min(), ys.min(), xs.max() - xs.min() + 1, ys.max() - ys.min() + 1,
                      W, H, pad)
    if rect is None:
        return [], None
    if shape == "mask":
        return [rect], [hit.astype(np.float32)]
    return [rect], None


def aabb_regions(aabb: str, box_mode: str, H: int, W: int, pad: int = 0,
                 max_regions: int = AABB_MAX_REGIONS):
    """手写 aabb 字符串 → regions（pad 外扩）。"""
    regs = parse_aabb(aabb, box_mode, W, H, max_regions=max_regions)
    out = []
    for (x, y, w, h) in regs:
        r = clamp_rect(x, y, w, h, W, H, pad)
        if r is not None:
            out.append(r)
    return out


def resolve_regions(segs=None, bbox=None, mask_frame=None, aabb: str = "",
                    box_mode: str = "xywh", shape: str = "bbox", pad: int = 0,
                    label_filter: str = "", H: int = 0, W: int = 0,
                    max_regions: int = 32, sort_regions: bool = True):
    """
    按优先级把各类打框数据解析成 (source, regions, gates, labels, notes)。
    优先级：segs > bbox > mask > aabb；同时连了多个时只用优先级最高的那个（其余忽略）。
    """
    notes = []
    if segs is not None:
        r, g, lb, tr, sk = segs_regions(segs, H, W, pad, label_filter, shape, max_regions, sort_regions)
        if tr:
            notes.append("超出 max_regions=%d，已按 (label,y,x) 稳定排序后截断 %d 个" % (max_regions, tr))
        if sk:
            notes.append("label 过滤掉 %d 个" % sk)
        return SOURCE_SEGS, r, g, lb, notes
    if bbox is not None:
        r, tr = bbox_data_regions(bbox, H, W, pad, max_regions, box_mode)
        if tr:
            notes.append("超出 max_regions=%d，已截断 %d 个" % (max_regions, tr))
        return SOURCE_BBOX, r, None, [""] * len(r), notes
    if mask_frame is not None:
        r, g = mask_regions(mask_frame, H, W, shape, pad, 0.0, max_regions)
        return SOURCE_MASK, r, g, [""] * len(r), notes
    if str(aabb or "").strip():
        r = aabb_regions(aabb, box_mode, H, W, pad, max_regions)
        return SOURCE_AABB, r, None, [""] * len(r), notes
    return SOURCE_NONE, [], None, [], notes


def effective_block_mask(H: int, W: int, regions, gates=None, unit: int = 8,
                         threshold: float = 0.5):
    """(H,W) bool：真正会被改动的像素范围（用于可视化/预览输出）。"""
    m = np.zeros((H, W), bool)
    for i, (x, y, w, h) in enumerate(regions):
        span = _region_block_span(int(x), int(y), int(w), int(h), W, H, int(unit))
        if span is None:
            continue
        x0, y0, x1, y1 = span
        u = int(unit)
        by, bx = (y1 - y0) // u, (x1 - x0) // u
        g = None if not gates else gates[i]
        if g is None:
            m[y0:y1, x0:x1] = True
            continue
        blk = np.asarray(g)[y0:y1, x0:x1].astype(np.float32, copy=False).reshape(by, u, bx, u)
        sel = blk.mean(axis=(1, 3)) >= float(threshold)
        m[y0:y1, x0:x1] |= np.repeat(np.repeat(sel, u, axis=0), u, axis=1)
    return m


# ==========================================================================
#  V3 元数据（网页端 PNG 路径）：把「区域表 + 签名」以 LSB 写进外扩 8px 边框
#  —— 于是**解密只需要 打码图 + 密码**，与网页端一致（这是网页端的做法：
#     pV3 加密时 metaBytes() → borderOrd() → wMetaPng()；解密时 rMetaPng() →
#     parseMeta() → 用同一密码重算签名比对，不符即「密码错误」）。
#  逐位等价移植自 image-crypto.js 的 metaBytes / parseMeta / borderOrd /
#  wMetaPng / rMetaPng（见 tests/test_meta.py 里与真 JS 的对照）。
# ==========================================================================
META_B_PNG = 8              # 网页端 PNG 路径边框宽度
META_B_JPEG = 64            # 网页端 JPEG/J2 路径边框宽度（本包暂未实现读写）
META_MAGIC = (67, 88)       # "CX"
META_FLAG_PNG = 4           # 网页端非诱饵 PNG：flag = 0 | ((decoySc=1 & 63) << 2) = 4
META_MAX_BYTES = 200        # 读取时最多看多少字节（网页端 rMetaPng 传 200）


def align_regions_web(regions, W: int, H: int, unit: int = 8):
    """
    按网页端 pV3 的规则把区域对齐到 unit 整数块，并对右下边界回落完整块。
    写进元数据的就是这套对齐后的坐标（读侧也用同一套，故必须完全一致）。
    """
    u = int(unit)
    out = []
    for (x, y, w, h) in regions:
        rx = (int(x) // u) * u
        ry = (int(y) // u) * u
        x2 = min(W, -(-(int(x) + int(w)) // u) * u)
        y2 = min(H, -(-(int(y) + int(h)) // u) * u)
        rw = max(0, ((x2 - rx) // u) * u)
        rh = max(0, ((y2 - ry) // u) * u)
        if rw > 0 and rh > 0:
            out.append((rx, ry, rw, rh))
    return out


def v3_signature(count: int, regions, secret: str) -> int:
    """网页端就这个式子：hash('V3|count|r.x,r.y,r.w,r.h&…|密码') >>> 0 & 0xFFFFFF。"""
    s = "V3|%d|%s|%s" % (int(count),
                         "&".join("%d,%d,%d,%d" % (int(r[0]), int(r[1]), int(r[2]), int(r[3]))
                                  for r in regions),
                         secret)
    return _u32(cx_hash(s)) & 0xFFFFFF


def meta_bytes(count: int, regions, secret: str, flag: int = META_FLAG_PNG,
               data_len: int = 0) -> bytes:
    """网页端 metaBytes()：count + 区域表 + 'CX' + 签名(3B) + flag + dataLen(4B, 大端)。"""
    bs = [int(count) & 255]
    for r in regions:
        x, y, w, h = (int(r[0]), int(r[1]), int(r[2]), int(r[3]))
        bs += [x >> 8 & 255, x & 255, y >> 8 & 255, y & 255,
               w >> 8 & 255, w & 255, h >> 8 & 255, h & 255]
    bs += list(META_MAGIC)
    sig = v3_signature(count, regions, secret)
    bs += [sig >> 16 & 255, sig >> 8 & 255, sig & 255]
    bs += [int(flag) & 255, int(data_len) >> 24 & 255, int(data_len) >> 16 & 255,
           int(data_len) >> 8 & 255, int(data_len) & 255]
    return bytes(b & 255 for b in bs)


def parse_meta(bs) -> dict:
    """网页端 parseMeta()：魔数不对 / count 非法返回 None。"""
    if bs is None or len(bs) < 5:
        return None
    cnt = int(bs[0])
    if cnt < 1 or cnt > AABB_MAX_REGIONS:
        return None
    if bs[1 + cnt * 8] != META_MAGIC[0] or bs[2 + cnt * 8] != META_MAGIC[1]:
        return None
    regions = []
    for i in range(cnt):
        o = 1 + i * 8
        regions.append((bs[o] * 256 + bs[o + 1], bs[o + 2] * 256 + bs[o + 3],
                        bs[o + 4] * 256 + bs[o + 5], bs[o + 6] * 256 + bs[o + 7]))
    so = 1 + cnt * 8 + 2
    stored = (int(bs[so]) << 16) | (int(bs[so + 1]) << 8) | int(bs[so + 2])
    flag = int(bs[so + 3]) & 255
    data_len = 0
    if len(bs) > so + 7:
        data_len = ((int(bs[so + 4]) << 24) | (int(bs[so + 5]) << 16)
                    | (int(bs[so + 6]) << 8) | int(bs[so + 7]))
    return {"cnt": cnt, "regions": regions, "stored": stored, "flag": flag,
            "data_len": data_len}


def border_order(cw: int, ch: int, B: int = META_B_PNG) -> np.ndarray:
    """网页端 borderOrd()：顶→右→底→左 的像素序号流（返回扁平像素下标 y*cw+x）。"""
    cw, ch, B = int(cw), int(ch), int(B)
    pts = []
    for x in range(cw):
        for y in range(B):
            pts.append(y * cw + x)                      # 顶
    for y in range(B, ch - B):
        for x in range(cw - B, cw):
            pts.append(y * cw + x)                      # 右
    for x in range(cw - 1, -1, -1):
        for y in range(ch - B, ch):
            pts.append(y * cw + x)                      # 底
    for y in range(ch - B - 1, B - 1, -1):
        for x in range(B):
            pts.append(y * cw + x)                      # 左
    return np.asarray(pts, dtype=np.int64)


def write_meta_png(arr_u8, order: np.ndarray, bs: bytes) -> bool:
    """网页端 wMetaPng()：每字节写 8 个像素的 **R 通道最低位**（高位在前）。"""
    need = len(bs) * 8
    if need > len(order):
        return False
    flat = arr_u8.reshape(-1, arr_u8.shape[-1]) if arr_u8.ndim == 3 else arr_u8.reshape(-1, 1)
    bits = []
    for b in bs:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    idx = order[:need]
    flat[idx, 0] = (flat[idx, 0] & 254) | np.asarray(bits, dtype=np.uint8)
    return True


def read_meta_png(arr_u8, order: np.ndarray, max_bytes: int = META_MAX_BYTES) -> bytes:
    """网页端 rMetaPng()：读 R 通道 LSB → 字节。"""
    flat = arr_u8.reshape(-1, arr_u8.shape[-1]) if arr_u8.ndim == 3 else arr_u8.reshape(-1, 1)
    n = min(len(order), int(max_bytes) * 8)
    bits = (flat[order[:n], 0] & 1).astype(np.uint8)
    out = bytearray()
    for i in range(0, len(bits) - 7, 8):
        v = 0
        for j in range(8):
            v = (v << 1) | int(bits[i + j])
        out.append(v)
    return bytes(out)


def pad_with_border(img_u8, B: int = META_B_PNG):
    """
    网页端 pV3 的边框构造：四边向外拉伸原图边缘，原图居中。
    （JS 用 canvas drawImage 做横向插值，这里最近邻 —— 只影响边框装饰色；
      元数据写在 R 通道 LSB 上，与装饰色无关，像素与网页端的差异仅限边框。）
    """
    B = int(B)
    h, w = img_u8.shape[0], img_u8.shape[1]
    cw, ch = w + 2 * B, h + 2 * B
    c = img_u8.shape[2] if img_u8.ndim == 3 else 1
    src = img_u8.reshape(h, w, c)
    out = np.empty((ch, cw, c), dtype=img_u8.dtype)

    def _edge_row(row):                          # 一行 → 左右各外延 B 像素到整宽
        return np.concatenate([np.repeat(row[0:1], B, axis=0), row,
                               np.repeat(row[-1:], B, axis=0)], axis=0)

    out[0:B, :] = _edge_row(src[0, :, :])        # 上：第 0 行拉伸铺满整宽
    out[ch - B:ch, :] = _edge_row(src[h - 1, :, :])   # 下：最后一行
    out[B:B + h, 0:B] = src[:, 0:1]              # 左：第 0 列拉伸
    out[B:B + h, cw - B:cw] = src[:, w - 1:w]    # 右：最后一列拉伸
    out[B:B + h, B:B + w] = src                   # 原图居中
    return out


def v3_write_meta(arr_u8, regions, secret: str, B: int = META_B_PNG,
                  flag: int = META_FLAG_PNG, data_len: int = 0) -> bool:
    """把区域表写进 arr_u8（外扩后的画布）的边框 LSB。"""
    cw, ch = arr_u8.shape[1], arr_u8.shape[0]
    bs = meta_bytes(len(regions), regions, secret, flag, data_len)
    return write_meta_png(arr_u8, border_order(cw, ch, B), bs)


def v3_read_meta(arr_u8, B: int = META_B_PNG):
    """从可能带边框的画布里读回 {cnt, regions, stored, flag, data_len} 或 None。"""
    cw, ch = arr_u8.shape[1], arr_u8.shape[0]
    return parse_meta(read_meta_png(arr_u8, border_order(cw, ch, B)))

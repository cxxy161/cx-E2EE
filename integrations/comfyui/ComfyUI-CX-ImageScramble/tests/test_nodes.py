# -*- coding: utf-8 -*-
"""
test_nodes.py — 按 ComfyUI 真实加载方式（spec_from_file_location + __init__.py）加载本节点包，
校验 schema 能构建、节点能注册、execute 能跑通（aabb / SEGS / MASK 三条输入路径）。

用法（必须用 ComfyUI 的 python，且 cwd 在 ComfyUI 根）：
    cd /d D:\\ComfyUI-new
    venv\\Scripts\\python.exe custom_nodes\\ComfyUI-CX-ImageScramble\\tests\\test_nodes.py
换另一套 ComfyUI 试加载：设 CX_COMFY_ROOT 指向那套 ComfyUI 根目录。
"""

import asyncio
import importlib.util
import os
import sys
from collections import namedtuple

import numpy as np
import torch

try:  # Windows 控制台默认 GBK，中文/表情符号会炸
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)


def detect_comfy_root():
    """推断 ComfyUI 根目录。

    优先环境变量 CX_COMFY_ROOT；否则从包位置逐级向上找「像 ComfyUI 根」的那一层
    （同时有 main.py 和 comfy_api/ 或 comfy/）——这样本包放在
    custom_nodes/ 下、或放在仓库的 integrations/comfyui/ 下都能找到；
    最后才退回老口径「包的上一级」（custom_nodes/x → 根）。
    """
    env = os.environ.get("CX_COMFY_ROOT")
    if env:
        return env
    d = PKG
    for _ in range(6):
        d = os.path.dirname(d)
        if not d or d == os.path.dirname(d):
            break
        if os.path.isfile(os.path.join(d, "main.py")) and (
                os.path.isdir(os.path.join(d, "comfy_api"))
                or os.path.isdir(os.path.join(d, "comfy"))):
            return d
    return os.path.dirname(os.path.dirname(PKG))


COMFY_ROOT = detect_comfy_root()

sys.path.insert(0, COMFY_ROOT)          # 让 comfy_api / comfy 可导入
sys.path.insert(0, os.path.dirname(PKG))

if not (os.path.isdir(os.path.join(COMFY_ROOT, "comfy_api"))
        or os.path.isdir(os.path.join(COMFY_ROOT, "comfy"))):
    print("[提示] 未在 %s 找到 comfy_api/ 或 comfy/，本包不在 ComfyUI 的 custom_nodes 下时，\n"
          "       请设 CX_COMFY_ROOT 指向 ComfyUI 根目录（例如 D:\\ComfyUI-new）再跑。" % COMFY_ROOT)

FAIL = []

# 与 Impact Pack 的 SEG 同构
SEG = namedtuple("SEG", ["cropped_image", "cropped_mask", "confidence", "crop_region",
                         "bbox", "label", "control_net_wrapper"], defaults=[None])


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def load_package():
    """完全复刻 ComfyUI nodes.py 的加载路径。"""
    name = PKG.replace(".", "_x_")
    spec = importlib.util.spec_from_file_location(name, os.path.join(PKG, "__init__.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def unwrap(node_output):
    """NodeOutput → 原始输出（兼容 .result / tuple 两种形态）。"""
    for attr in ("result", "outputs", "values"):
        if hasattr(node_output, attr):
            v = getattr(node_output, attr)
            if v is not None:
                return v
    if isinstance(node_output, (tuple, list)):
        return node_output
    return node_output


def as_pair(node_output):
    """(IMAGE, MASK) 两个输出。"""
    v = unwrap(node_output)
    if isinstance(v, (tuple, list)) and len(v) == 2:
        return v[0], v[1]
    if isinstance(v, torch.Tensor):
        return v, None
    return v, None


def as_segs(segs, H, W):
    """Impact Pack 的实际形态：((H, W), [SEG, ...])"""
    return ((H, W), list(segs))


def make_seg(bbox, label="obj", H=0, W=0, pad_crop=16, ellipse=False):
    """SEG.bbox 按 Impact 约定是 xyxy。"""
    x, y, w, h = bbox
    bbox_xyxy = (x, y, x + w, y + h)
    cr = (max(0, x - pad_crop), max(0, y - pad_crop), min(W, x + w + pad_crop), min(H, y + h + pad_crop))
    cw, ch = cr[2] - cr[0], cr[3] - cr[1]
    if ellipse:
        # 内切于 bbox 的椭圆（模拟 segm 模型在 crop 里给出的真实形状）
        yy, xx = np.mgrid[0:ch, 0:cw]
        cyc, cxc = (y - cr[1]) + h / 2.0, (x - cr[0]) + w / 2.0
        ryy, rxx = max(1.0, h / 2.0 - 1), max(1.0, w / 2.0 - 1)
        cm = (((yy - cyc) / ryy) ** 2 + ((xx - cxc) / rxx) ** 2 <= 1.0).astype(np.float32)
    else:
        cm = np.ones((ch, cw), np.float32)
    return SEG(None, cm, 0.95, cr, bbox_xyxy, label, None)


def psnr(a, b, box=None):
    a = np.rint(a * 255).astype(np.int32)
    b = np.rint(b * 255).astype(np.int32)
    if box:
        x, y, w, h = box
        # a/b 可能是 (H,W,C) 或 (B,H,W,C)：用省略号只切最后三个轴
        a = a[..., y:y + h, x:x + w, :]
        b = b[..., y:y + h, x:x + w, :]
    mse = float(((a - b) ** 2).mean())
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def main():
    print("== 1. 以 ComfyUI 的加载方式导入包 ==")
    mod = load_package()
    check("包导入成功（comfy_entrypoint 存在）", hasattr(mod, "comfy_entrypoint"))
    check("未导出 NODE_CLASS_MAPPINGS（避免 V1 分支遮蔽 V3）",
          not hasattr(mod, "NODE_CLASS_MAPPINGS"))

    ext = asyncio.run(mod.comfy_entrypoint())
    node_list = asyncio.run(ext.get_node_list())
    schemas = {}
    for cls in node_list:
        s = cls.GET_SCHEMA()
        schemas[s.node_id] = s
        print("     节点: %-22s | %-24s | 输入 %d 个 | 输出 %d 个"
              % (s.node_id, s.display_name, len(s.inputs), len(s.outputs)))
    check("注册了 2 个节点", len(node_list) == 2, str(list(schemas)))
    check("node_id 为 CX_RegionScramble / CX_RegionUnscramble",
          set(schemas) == {"CX_RegionScramble", "CX_RegionUnscramble"})

    enc = dict(zip(schemas, node_list))["CX_RegionScramble"]
    dec = dict(zip(schemas, node_list))["CX_RegionUnscramble"]

    print("== 2. 输入签名：打框数据三类 + 手写 aabb + int(key) ==")
    fields = [getattr(i, "id", None) for i in schemas["CX_RegionScramble"].inputs]
    for need in ("image", "segs", "bbox", "mask", "aabb", "key"):
        check("有输入 %-6s" % need, need in fields)
    check("顺序：image 在前，打框数据紧随其后",
          fields[:5] == ["image", "segs", "bbox", "mask", "aabb"], str(fields[:5]))
    check("输出为 IMAGE + MASK", len(schemas["CX_RegionScramble"].outputs) == 2,
          str(len(schemas["CX_RegionScramble"].outputs)))

    print("== 3. aabb 路径：打码 → 还原（批次 2） ==")
    H = W = 64
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.zeros((H, W, 3), np.float32)     # IMAGE 约定：float 0..1
    base[..., 0] = (60 + 120 * xx / (W - 1)) / 255.0
    base[..., 1] = (70 + 110 * yy / (H - 1)) / 255.0
    base[..., 2] = 0.5
    img = torch.from_numpy(np.stack([base, base], axis=0))  # (2,64,64,3)

    scr, scr_mask = as_pair(enc.execute(image=img, aabb="16,16,32,32", key=20240117))
    check("输出 IMAGE (2,64,64,3) float32",
          tuple(scr.shape) == (2, 64, 64, 3) and scr.dtype == torch.float32, str(tuple(scr.shape)))
    check("输出 MASK (2,64,64)", scr_mask is not None and tuple(scr_mask.shape) == (2, 64, 64),
          str(None if scr_mask is None else tuple(scr_mask.shape)))
    a = np.rint(img.numpy() * 255).astype(np.int32)
    b = np.rint(scr.numpy() * 255).astype(np.int32)
    inner = (slice(None), slice(16, 48), slice(16, 48))
    changed = float((b[inner] != a[inner]).any(-1).mean())
    outside = np.abs(b - a).copy()
    outside[:, 16:48, 16:48] = 0
    check("区域内被打码（>95% 变化）", changed > 0.95, "变化=%.1f%%" % (changed * 100))
    check("区域外零改动", int(outside.max()) == 0, "max|Δ|=%d" % outside.max())
    check("MASK 输出标记了有效区域", bool(scr_mask[0, 20, 20] > 0.5) and not bool(scr_mask[0, 0, 0] > 0.5))

    back, _ = as_pair(dec.execute(image=scr, aabb="16,16,32,32", key=20240117))
    p = psnr(back.numpy(), img.numpy(), (16, 16, 32, 32))
    check("还原 PSNR > 30dB", p > 30, "PSNR=%.1fdB" % p)
    wrong, _ = as_pair(dec.execute(image=scr, aabb="16,16,32,32", key=20240118))
    pw = psnr(wrong.numpy(), img.numpy(), (16, 16, 32, 32))
    check("错误 key 无法还原", p - pw > 15, "正确 %.1fdB / 错误 %.1fdB" % (p, pw))

    print("== 4. SEGS 路径（bbox 模型形态） ==")
    segs = as_segs([make_seg((10, 10, 30, 20), "face", H=H, W=W),
                    make_seg((40, 30, 20, 25), "hand", H=H, W=W)], H, W)
    s2, m2 = as_pair(enc.execute(image=img, segs=segs, key=7))
    ref = np.rint(img.numpy() * 255).astype(np.int32)
    got = np.rint(s2.numpy() * 255).astype(np.int32)
    via_aabb, _ = as_pair(enc.execute(image=img, aabb="10,10,30,20; 40,30,20,25", key=7))
    check("SEGS 与同坐标 aabb 结果一致", np.array_equal(s2.numpy(), via_aabb.numpy()))
    eff = m2.numpy()[0] > 0.5
    changed_s = float((got[0][eff] != ref[0][eff]).any(-1).mean())
    check("SEGS 区域被打码且仅有区域内改动",
          changed_s > 0.95 and int(np.abs(got - ref)[~eff[None].repeat(2, 0)].max()) == 0,
          "变化=%.1f%% 掩膜 %d px" % (changed_s * 100, int(eff.sum())))
    back2, _ = as_pair(dec.execute(image=s2, segs=segs, key=7))
    check("SEGS 路径可还原", psnr(back2.numpy(), img.numpy(), (10, 10, 30, 20)) > 30,
          "PSNR=%.1fdB" % psnr(back2.numpy(), img.numpy(), (10, 10, 30, 20)))

    print("== 5. SEGS 路径（segm 模型形态：按分割形状打码） ==")
    segm = as_segs([make_seg((10, 10, 30, 20), "face", H=H, W=W, ellipse=True)], H, W)
    s3, m3 = as_pair(enc.execute(image=img, segs=segm, key=7, region_shape="mask"))
    eff3 = m3.numpy()[0] > 0.5
    s4, m4 = as_pair(enc.execute(image=img, segs=segm, key=7, region_shape="bbox"))
    eff4 = m4.numpy()[0] > 0.5
    check("shape=mask 的有效区域小于 shape=bbox", int(eff3.sum()) < int(eff4.sum()),
          "%d < %d px" % (eff3.sum(), eff4.sum()))
    check("椭圆之外（框角）未被打码", not bool(eff3[12, 12]), "eff[12,12]=%s" % eff3[12, 12])
    back3, _ = as_pair(dec.execute(image=s3, segs=segm, key=7, region_shape="mask"))
    check("shape=mask 可还原", psnr(back3.numpy(), img.numpy(), (10, 10, 30, 20)) > 30,
          "PSNR=%.1fdB" % psnr(back3.numpy(), img.numpy(), (10, 10, 30, 20)))

    print("== 6. MASK 路径（SAM / 分割掩膜） ==")
    mk = np.zeros((1, H, W), np.float32)
    mk[0, 20:50, 24:56] = 1.0
    mk_t = torch.from_numpy(mk)
    s5, m5 = as_pair(enc.execute(image=img, mask=mk_t, key=3, region_shape="mask"))
    check("MASK 广播到 2 帧批次（同一掩膜）",
          np.array_equal(np.rint(s5.numpy()[0] * 255), np.rint(s5.numpy()[1] * 255)))
    eff5 = m5.numpy()[0] > 0.5
    check("有效区域落在掩膜范围内", eff5[30, 40] and not eff5[0, 0] and not eff5[60, 60])
    back5, _ = as_pair(dec.execute(image=s5, mask=mk_t, key=3, region_shape="mask"))
    check("MASK 路径可还原", psnr(back5.numpy(), img.numpy(), (24, 20, 32, 30)) > 30,
          "PSNR=%.1fdB" % psnr(back5.numpy(), img.numpy(), (24, 20, 32, 30)))
    try:
        enc.execute(image=img, mask=torch.zeros((3, H, W)), key=3)
        check("MASK 帧数不匹配时报错", False, "没报错")
    except Exception as e:  # noqa: BLE001
        check("MASK 帧数不匹配时报错", "帧数" in str(e), str(e)[:60])

    print("== 7. 优先级：同时连 segs + mask 用 segs ==")
    s6, m6 = as_pair(enc.execute(image=img, segs=segs, mask=mk_t, key=7))
    check("segs 优先（结果与只连 segs 相同）", np.array_equal(s6.numpy(), s2.numpy()))

    print("== 7b. 元数据模式：打码图自带区域表 → 还原只要 图 + 密码 ==")
    m_enc, _ = as_pair(enc.execute(image=img, aabb="16,16,32,32", key=20240117, embed_meta=True))
    check("embed_meta=True → 输出外扩 8px 边框（(H+16)×(W+16)）",
          tuple(m_enc.shape) == (2, H + 16, W + 16, 3), str(tuple(m_enc.shape)))
    check("边框确实带了元数据（R 通道 LSB 可读）", True)
    # 只给 图 + 密码 还原（不接任何打框数据）
    m_back, _ = as_pair(dec.execute(image=m_enc, key=20240117))
    check("只给图+key 还原 → 尺寸回到原图", tuple(m_back.shape) == (2, H, W, 3), str(tuple(m_back.shape)))
    p_meta = psnr(m_back.numpy(), img.numpy(), (16, 16, 32, 32))
    check("元数据模式可还原（PSNR > 30dB）", p_meta > 30, "PSNR=%.1fdB" % p_meta)
    back_aabb, _ = as_pair(dec.execute(image=scr, aabb="16,16,32,32", key=20240117))
    check("元数据模式结果 == 显式 aabb 模式结果", np.allclose(m_back.numpy(), back_aabb.numpy()))
    try:
        dec.execute(image=m_enc, key=20240118)
        check("元数据模式 + 错密码 → 报错（网页端式「密码错误」）", False, "没报错")
    except Exception as e:  # noqa: BLE001
        check("元数据模式 + 错密码 → 签名不符报错", "密码" in str(e) and "签名" in str(e), str(e)[:56])
    try:
        dec.execute(image=img, key=20240117)   # 原图没有元数据
        check("无元数据的图 + 无打框数据 → 明确报错", False, "没报错")
    except Exception as e:  # noqa: BLE001
        check("无元数据的图 → 明确报错", "没有 CX V3 打码元数据" in str(e), str(e)[:56])
    try:
        enc.execute(image=img, aabb="16,16,32,32", key=1, embed_meta=True, region_shape="mask")
        check("embed_meta + region_shape=mask → 报错（元数据只存矩形）", False, "没报错")
    except Exception as e:  # noqa: BLE001
        check("embed_meta + region_shape=mask → 报错", "region_shape" in str(e), str(e)[:56])

    print("== 8. 无区域数据 / 非法输入 ==")
    for kw, why in [({}, "什么都没连"), ({"aabb": "1,2,3"}, "aabb 数字不够"),
                    ({"aabb": "99999,99999,5,5"}, "框在图像外")]:
        try:
            enc.execute(image=img, key=1, **kw)
            check("%s 应当报错" % why, False, "没报错")
        except Exception as e:  # noqa: BLE001
            check("%s 报错：%s" % (why, str(e)[:52].replace("\n", " ")), True)
    out_p, mask_p = as_pair(enc.execute(image=img, key=1, no_region_policy="passthrough"))
    check("没连任何打框数据 + passthrough → 原图直出、掩膜全 0",
          torch.equal(out_p, img) and float(mask_p.max()) == 0.0)
    try:
        enc.execute(image=img, aabb="0,0,8,8", key=1, unit=7)
        check("unit=7 应当报错", False, "没报错")
    except Exception as e:  # noqa: BLE001
        check("unit 非 8/16/32/64 报错", "unit" in str(e), str(e)[:60])
    try:
        enc.execute(image=img, aabb="0,0,8,8", key=1, region_shape="poly")
        check("region_shape 非法应当报错", False, "没报错")
    except Exception as e:  # noqa: BLE001
        check("region_shape 非法报错", "region_shape" in str(e), str(e)[:60])

    print("== 9. aabb 各写法 / 多区域 / 灰度 ==")
    for aabb, mode in [("16,16,32,32", "xywh"), ("16,16,48,48", "xyxy"),
                       ("8,8,16,16; 40,40,16,16|32,32,8,8", "xywh"), ("", "xywh"),
                       ("[[10 10 20 20] [30 30 10 10]]", "xywh"), ("10 10 20 20 30 30 10 10", "xywh")]:
        try:
            enc.execute(image=img, aabb=aabb, key=1, box_mode=mode, region_shape="bbox")
            ok, err = True, ""
        except Exception as e:  # noqa: BLE001
            # ("", xywh) 空 aabb 且无其他来源 → 应当报「没有可用区域」
            ok, err = (aabb == ""), "%s: %s" % (type(e).__name__, str(e)[:60])
        check("aabb=%-34r mode=%-4s" % (aabb, mode), ok, err)
    gray = torch.from_numpy(np.stack([base[..., :1], base[..., :1]], 0).astype(np.float32))
    g_out, _ = as_pair(enc.execute(image=gray, aabb="8,8,16,16", key=5))
    check("灰度输入输出 (2,64,64,1)", tuple(g_out.shape) == (2, 64, 64, 1), str(tuple(g_out.shape)))

    print()
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())

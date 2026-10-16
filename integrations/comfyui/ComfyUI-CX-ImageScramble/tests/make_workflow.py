# -*- coding: utf-8 -*-
"""
make_workflow.py — 生成「CX 图片区域混淆」示例工作流（UI 格式 + API 格式），并在真服务上验证连线。

三条路线：
  detect  bbox 检测模型：LoadImage → UltralyticsDetectorProvider → BboxDetectorSEGS → CX(segs=…)
  mask    分割掩膜：LoadImage(+掩膜图) → ImageToMask → MaskToSEGS → CX(segs=…)
  aabb    手写坐标：LoadImage → CX(aabb=…)

标记框后处理交给**外部节点**（本包不管框的缩放/合并），两条现成示例：
  boxscale  按轴心缩放：BboxDetectorSEGS → ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT
                        → ImpactAssembleSEGS → CX(segs=…)
  boxmerge  标记框合并：BboxDetectorSEGS → ImpactSEGSMerge → CX(segs=…)
  （实测脚本见 tests/test_segs_tools.py；两个节点的语义与实测数字见包内 README）

控件值顺序不手写：直接从目标服务的 /object_info 取（required→optional 顺序、
socket 类型不算控件），没被覆盖的控件用 schema 默认值，所以不同 ComfyUI 版本都不会错位。

用法：
    venv\\Scripts\\python.exe tests\\make_workflow.py --server http://127.0.0.1:8188 \
        --outdir custom_nodes\\ComfyUI-CX-ImageScramble\\workflows [--copy-to <workflows 目录> ...] [--no-verify]
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)

WIDGET_TYPES = ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO")  # COMBO: 新版序列化
                                                            # ["COMBO", {"options": [...]}] 也是控件
FAIL = []


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode())


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def widget_names(oi, ntype):
    """按 /object_info 的顺序给出该节点的控件名（COMBO 与标量；socket 类型跳过）。"""
    v = oi[ntype]["input"]
    names = []
    for sec in ("required", "optional"):
        for k, val in (v.get(sec) or {}).items():
            t = val[0]
            if isinstance(t, list) or t in WIDGET_TYPES:
                names.append(k)
    return names


def widget_defaults(oi, ntype):
    v = oi[ntype]["input"]
    out = {}
    for sec in ("required", "optional"):
        for k, val in (v.get(sec) or {}).items():
            t = val[0]
            opts = val[1] if len(val) > 1 and isinstance(val[1], dict) else {}
            if isinstance(t, list):
                out[k] = opts.get("default", t[0] if t else "")
            elif t == "COMBO":
                out[k] = opts.get("default", (opts.get("options") or [""])[0])
            elif t == "INT":
                out[k] = opts.get("default", 0)
            elif t == "FLOAT":
                out[k] = opts.get("default", 0.0)
            elif t == "BOOLEAN":
                out[k] = opts.get("default", False)
            elif t == "STRING":
                out[k] = opts.get("default", "")
    return out


class Graph:
    """极简的 ComfyUI 图：既能导出 UI 格式，也能导出 API 格式。"""

    def __init__(self, oi):
        self.oi = oi
        self.nodes = []          # {id, type, pos, size, widgets:{}, inputs:{(name,type,src)}, outputs:[(name,type)]}
        self.links = []
        self.nid = 0
        self.lid = 0

    def add(self, ntype, pos, widgets=None, size=(330, 120), title=None):
        self.nid += 1
        v = self.oi[ntype]
        outs = []
        for i, o in enumerate(v.get("output") or []):
            name = (v.get("output_name") or [])[i] if (v.get("output_name") or []) else o
            outs.append((name or o, o))
        wv = dict(widget_defaults(self.oi, ntype))
        wv.update(widgets or {})
        self.nodes.append({"id": self.nid, "type": ntype, "pos": list(pos), "size": list(size),
                           "widgets": wv, "inputs": [], "outputs": outs, "title": title,
                           "order": len(self.nodes)})
        return self.nid

    def node(self, nid):
        for n in self.nodes:
            if n["id"] == nid:
                return n
        raise KeyError(nid)

    def connect(self, src_id, src_slot, dst_id, dst_name):
        s, d = self.node(src_id), self.node(dst_id)
        if src_slot >= len(s["outputs"]):
            raise ValueError("%s 没有第 %d 个输出" % (s["type"], src_slot))
        otype = s["outputs"][src_slot][1]
        for i, inp in enumerate(d["inputs"]):
            if inp[0] == dst_name:
                raise ValueError("重复连接 %s.%s" % (d["type"], dst_name))
        d["inputs"].append((dst_name, otype, (src_id, src_slot)))
        return self

    def sockets_of(self, ntype):
        """该节点的 socket 输入（名, 声明类型），顺序与 /object_info 一致（required→optional）。"""
        v = self.oi[ntype]["input"]
        out = []
        for sec in ("required", "optional"):
            for k, val in (v.get(sec) or {}).items():
                t = val[0]
                if not (isinstance(t, list) or t in WIDGET_TYPES):
                    out.append((k, t))
        return out

    def sockets_of_names(self, ntype):
        return [n for n, _t in self.sockets_of(ntype)]

    # ---------- 导出 ----------
    def to_ui(self):
        """UI 格式：input 槽位严格按 /object_info 的 socket 声明顺序排，链接槽位号与之对应。"""
        link_id = 0
        links_json = []
        for n in self.nodes:
            n["_ins"] = [{"name": nm, "type": tp, "link": None} for nm, tp in self.sockets_of(n["type"])]
            for name, otype, src in n["inputs"]:
                idx = next(i for i, x in enumerate(n["_ins"]) if x["name"] == name)
                link_id += 1
                n["_ins"][idx]["link"] = link_id
                n["_ins"][idx]["type"] = otype
                links_json.append([link_id, src[0], src[1], n["id"], idx, otype])
            n["_outs"] = [{"name": nm, "type": tp, "links": None, "slot_index": i}
                          for i, (nm, tp) in enumerate(n["outputs"])]
        for lid, snid, sslot, dnid, dslot, _t in links_json:
            src = self.node(snid)["_outs"][sslot]
            src["links"] = (src["links"] or []) + [lid]

        nodes_json = []
        for n in self.nodes:
            node = {
                "id": n["id"], "type": n["type"], "pos": n["pos"], "size": n["size"],
                "flags": {}, "order": n["order"], "mode": 0,
                "inputs": n["_ins"], "outputs": n["_outs"],
                "properties": {"Node name for S&R": n["type"]},
                "widgets_values": [n["widgets"][k] for k in widget_names(self.oi, n["type"])
                                   if k in n["widgets"]],
            }
            if n.get("title"):
                node["title"] = n["title"]
            nodes_json.append(node)
        # extra 里**故意不带 ds**。
        # 前端 dialogService 的 loadGraphData→fitView 是这么写的：
        #   e.extra?.ds ? (this.canvas.ds.offset = e.extra.ds.offset, this.canvas.ds.scale = ...)
        #               : useLitegraphService().fitView()
        # 只要 extra.ds 存在，就会执行 canvas.ds.offset = ...，而
        # DragAndScale.set offset(e){this.state.offset[0]=e[0]} 中任一侧缺字段都会抛
        # TypeError: Cannot read properties of undefined (reading '0')（工作流直接打不开）。
        # 不给 ds 就永远走 useLitegraphService().fitView() 这条安全分支（自动适配视图）。
        # LGraph 自身 extra 初始化为 {}，所以 extra 为空对象也安全。
        return {"last_node_id": self.nid, "last_link_id": link_id, "nodes": nodes_json,
                "links": links_json, "groups": [], "config": {}, "extra": {},
                "version": 0.4}

    def to_api(self):
        """API 格式：required 必须齐全（ComfyUI 的 API 校验不补默认值），optional 里连了的才写。"""
        prompt = {}
        for n in self.nodes:
            v = self.oi[n["type"]]["input"]
            ins = {}
            for sec in ("required", "optional"):
                for k in (v.get(sec) or {}):
                    hit = [x for x in n["inputs"] if x[0] == k]
                    if hit:
                        ins[k] = [str(hit[0][2][0]), hit[0][2][1]]
                    elif k in n["widgets"]:
                        ins[k] = n["widgets"][k]          # 控件值（含 optional 的 aabb 之类）
                    elif sec == "required":
                        raise ValueError("%s.%s 必填但既没控件值也没连线" % (n["type"], k))
            prompt[str(n["id"])] = {"class_type": n["type"], "inputs": ins}
        return prompt


def build_detect(oi, img, model, key):
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330))
    det = g.add("UltralyticsDetectorProvider", (400, 60), {"model_name": model}, (340, 80))
    sg = g.add("BboxDetectorSEGS", (400, 220), {"crop_factor": 1.0, "dilation": 10,
                                                "drop_size": 10, "threshold": 0.5,
                                                "labels": "all"}, (330, 200))
    scr = g.add("CX_RegionScramble", (40, 440), {"key": key, "region_shape": "mask"}, (420, 320))
    save = g.add("SaveImage", (520, 440), {"filename_prefix": "CX_scramble"}, (400, 420))
    m2i = g.add("MaskToImage", (520, 900), {}, (330, 60))
    prev = g.add("PreviewImage", (900, 900), {}, (400, 420))
    back = g.add("CX_RegionUnscramble", (40, 1000), {"key": key, "region_shape": "mask"}, (420, 320))
    prev2 = g.add("PreviewImage", (520, 1000), {}, (400, 420))
    g.connect(ld, 0, sg, "image")
    g.connect(det, 0, sg, "bbox_detector")
    g.connect(ld, 0, scr, "image")
    g.connect(sg, 0, scr, "segs")
    g.connect(scr, 0, save, "images")
    g.connect(scr, 1, m2i, "mask")
    g.connect(m2i, 0, prev, "images")
    g.connect(scr, 0, back, "image")
    g.connect(sg, 0, back, "segs")
    g.connect(back, 0, prev2, "images")
    return g


def build_mask(oi, img, mask_img, key):
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330))
    lm = g.add("LoadImage", (400, 60), {"image": mask_img}, (330, 330))
    i2m = g.add("ImageToMask", (400, 430), {"channel": "red"}, (240, 60))
    m2s = g.add("MaskToSEGS", (700, 430), {"combined": False, "crop_factor": 1.0,
                                           "bbox_fill": False, "drop_size": 10,
                                           "contour_fill": False}, (300, 180))
    scr = g.add("CX_RegionScramble", (40, 520), {"key": key, "region_shape": "mask"}, (420, 320))
    save = g.add("SaveImage", (520, 520), {"filename_prefix": "CX_maskpath"}, (400, 420))
    back = g.add("CX_RegionUnscramble", (40, 900), {"key": key, "region_shape": "mask"}, (420, 320))
    prev2 = g.add("PreviewImage", (520, 900), {}, (400, 420))
    g.connect(lm, 0, i2m, "image")
    g.connect(i2m, 0, m2s, "mask")
    g.connect(ld, 0, scr, "image")
    g.connect(m2s, 0, scr, "segs")
    g.connect(scr, 0, save, "images")
    g.connect(scr, 0, back, "image")
    g.connect(m2s, 0, back, "segs")
    g.connect(back, 0, prev2, "images")
    return g


def build_aabb(oi, img, aabb, key):
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330))
    scr = g.add("CX_RegionScramble", (400, 60), {"aabb": aabb, "key": key,
                                                 "region_shape": "bbox"}, (420, 320))
    save = g.add("SaveImage", (860, 60), {"filename_prefix": "CX_aabbpath"}, (400, 420))
    m2i = g.add("MaskToImage", (860, 520), {}, (330, 60))
    prev = g.add("PreviewImage", (1220, 520), {}, (400, 420))
    back = g.add("CX_RegionUnscramble", (400, 620), {"aabb": aabb, "key": key,
                                                     "region_shape": "bbox"}, (420, 320))
    prev2 = g.add("PreviewImage", (860, 900), {}, (400, 420))
    g.connect(ld, 0, scr, "image")
    g.connect(scr, 0, save, "images")
    g.connect(scr, 1, m2i, "mask")
    g.connect(m2i, 0, prev, "images")
    g.connect(scr, 0, back, "image")
    g.connect(back, 0, prev2, "images")
    return g


def build_meta_write(oi, img, aabb, key):
    """打码 + 写元数据（网页端 PNG 用法）：输出自带区域表，解密只要 图+密码。"""
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330))
    scr = g.add("CX_RegionScramble", (400, 60), {"aabb": aabb, "key": key,
                                                 "region_shape": "bbox",
                                                 "embed_meta": True}, (420, 340))
    save = g.add("SaveImage", (860, 60), {"filename_prefix": "CX_meta_scramble"}, (400, 420))
    m2i = g.add("MaskToImage", (860, 520), {}, (330, 60))
    prev = g.add("PreviewImage", (1220, 520), {}, (400, 420))
    g.connect(ld, 0, scr, "image")
    g.connect(scr, 0, save, "images")
    g.connect(scr, 1, m2i, "mask")
    g.connect(m2i, 0, prev, "images")
    return g


def build_meta_read(oi, meta_img, key):
    """只给「带元数据的打码图 + 密码」还原：不接任何打框数据。"""
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": meta_img}, (330, 330))
    back = g.add("CX_RegionUnscramble", (400, 60), {"key": key}, (420, 320))
    save = g.add("SaveImage", (860, 60), {"filename_prefix": "CX_meta_restored"}, (400, 420))
    m2i = g.add("MaskToImage", (860, 520), {}, (330, 60))
    prev = g.add("PreviewImage", (1220, 520), {}, (400, 420))
    g.connect(ld, 0, back, "image")
    g.connect(back, 0, save, "images")
    g.connect(back, 1, m2i, "mask")
    g.connect(m2i, 0, prev, "images")
    return g


def build_segm_roundtrip(oi, img, model, key, password):
    """
    一体验证工作流：**segm 模型打码** + **纯 图+密码 解码**。
    同一张打码图（元数据写在像素里）直接过手给解码节点，所以一个图跑完就能看到：
      ① segm 模型（框 + 分割掩膜）→ 打码（embed_meta：区域表写进边框）
      ② 解码节点只接「这张图 + 密码」，segs/aabb 一个都没接 → 能还原 = 纯图+密码可行
      ③ 对照：region_shape=mask 的形状级打码（这时解码必须接同一份 SEGS）
    """
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330), "0. 原图")
    det = g.add("UltralyticsDetectorProvider", (400, 60), {"model_name": model}, (360, 80),
                "1. segm 模型")
    sg = g.add("SegmDetectorSEGS", (400, 200), {"crop_factor": 1.0, "dilation": 10,
                                                "drop_size": 10, "threshold": 0.5,
                                                "labels": "all"}, (330, 200),
               "2. segm 检测 → SEGS")
    scr_a = g.add("CX_RegionScramble", (40, 460),
                  {"aabb": "", "key": key, "password": password, "region_shape": "bbox",
                   "embed_meta": True}, (430, 520),
                  "3A. segm 打码（元数据版：区域表写进边框）")
    save_a = g.add("SaveImage", (520, 460), {"filename_prefix": "CX_segm_scrambled"}, (400, 380),
                   "4A. 打码图（自带「怎么还原」）")
    m2i = g.add("MaskToImage", (520, 980), {}, (330, 60), "5A. 实际打码区域 → 预览")
    prev = g.add("PreviewImage", (900, 980), {}, (400, 380), "5A-预览. 实际被打码的块")
    un_a = g.add("CX_RegionUnscramble", (960, 460),
                 {"aabb": "", "key": key, "password": password}, (430, 430),
                 "6A. 解码：只给这张图 + 密码")
    save_b = g.add("SaveImage", (1440, 460), {"filename_prefix": "CX_segm_restored"}, (400, 380),
                   "7A. 还原图（应与原图一致）")
    scr_c = g.add("CX_RegionScramble", (40, 1080),
                  {"aabb": "", "key": key, "password": password, "region_shape": "mask"}, (430, 480),
                  "3B. 对照：按分割形状打码（region_shape=mask）")
    save_c = g.add("SaveImage", (520, 1080), {"filename_prefix": "CX_segm_shape_scrambled"},
                   (400, 380), "4B. 形状版打码图")
    un_c = g.add("CX_RegionUnscramble", (960, 1080),
                 {"aabb": "", "key": key, "password": password, "region_shape": "mask"}, (430, 430),
                 "6B. 形状版解码：必须接同一份 SEGS")
    save_d = g.add("SaveImage", (1440, 1080), {"filename_prefix": "CX_segm_shape_restored"},
                   (400, 380), "7B. 形状版还原图")
    save_e = g.add("SaveImage", (960, 60), {"filename_prefix": "CX_segm_original"}, (400, 260),
                   "8. 原图（与还原图对比用）")

    g.connect(ld, 0, sg, "image")
    g.connect(det, 1, sg, "segm_detector")          # slot 1 = SEGM_DETECTOR
    g.connect(ld, 0, scr_a, "image")
    g.connect(sg, 0, scr_a, "segs")
    g.connect(scr_a, 0, save_a, "images")
    g.connect(scr_a, 1, m2i, "mask")
    g.connect(m2i, 0, prev, "images")
    g.connect(scr_a, 0, un_a, "image")              # ← 解码只拿到这张图
    g.connect(un_a, 0, save_b, "images")
    g.connect(ld, 0, scr_c, "image")
    g.connect(sg, 0, scr_c, "segs")
    g.connect(scr_c, 0, save_c, "images")
    g.connect(scr_c, 0, un_c, "image")
    g.connect(sg, 0, un_c, "segs")                  # ← 形状版必须给同一份 SEGS
    g.connect(un_c, 0, save_d, "images")
    g.connect(ld, 0, save_e, "images")
    return g


def build_boxscale(oi, img, model, key, scale=1.5):
    """
    标记框「按轴心缩放」——由**外部节点**做（我们节点不掺和框的处理）：
      BboxDetectorSEGS → ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT(scale_by)
                      → ImpactAssembleSEGS → CX_RegionScramble / CX_RegionUnscramble
    缩放规则（Impact 源码 modules/impact/segs_nodes.py:1223）：
      dw=int((w*scale_by-w)/2) → bbox=(x1-dw, y1-dh, x2+dw, y2+dh)，即框中心不动、宽高按比例。
    打码与还原必须吃**同一份**缩放后的 SEGS，所以同一条线拉两路。
    """
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330), "0. 原图")
    det = g.add("UltralyticsDetectorProvider", (400, 60), {"model_name": model}, (340, 80),
                "1. bbox 模型")
    sg = g.add("BboxDetectorSEGS", (400, 200), {"crop_factor": 1.0, "dilation": 10,
                                                "drop_size": 10, "threshold": 0.5,
                                                "labels": "all"}, (330, 200),
               "2. 检测 → SEGS（标记框）")
    dec = g.add("ImpactDecomposeSEGS", (780, 200), {}, (280, 60),
                "3. SEGS → (表头 + SEG_ELT 列表)")
    scl = g.add("ImpactScaleBy_BBOX_SEG_ELT", (1100, 200), {"scale_by": scale}, (300, 90),
                "4. 按框中心缩放 %.2f×（外部节点）" % scale)
    asm = g.add("ImpactAssembleSEGS", (1440, 200), {}, (280, 90), "5. 装回 SEGS")
    cnt = g.add("ImpactCount_Elts_in_SEGS", (1440, 340), {}, (280, 60), "6. 框数")
    prv_cnt = g.add("PreviewAny", (1760, 340), {}, (330, 220),
                    "7. 框数（0 = 没检到框 → CX 原图直出，流程不卡）")
    scr = g.add("CX_RegionScramble", (40, 440),
                {"aabb": "", "key": key, "region_shape": "bbox"}, (430, 420),
                "8. 打码（用缩放后的框；pad 留 0，缩放交给上面的节点）")
    save = g.add("SaveImage", (500, 440), {"filename_prefix": "CX_boxscale_scrambled"}, (400, 420),
                 "9. 打码图")
    m2i = g.add("MaskToImage", (500, 900), {}, (330, 60), "10. 实际打码区域")
    prev_m = g.add("PreviewImage", (860, 900), {}, (400, 420), "11. 实际被打码的块（核对框对不对）")
    back = g.add("CX_RegionUnscramble", (960, 440),
                 {"aabb": "", "key": key, "region_shape": "bbox"}, (430, 420),
                 "12. 还原（同一份缩放后的 SEGS）")
    prev_b = g.add("PreviewImage", (1420, 440), {}, (400, 420), "13. 还原图（应与原图一致）")
    save_o = g.add("SaveImage", (960, 60), {"filename_prefix": "CX_boxscale_original"}, (400, 260),
                   "14. 原图（对比用）")
    g.connect(ld, 0, sg, "image")
    g.connect(det, 0, sg, "bbox_detector")
    g.connect(sg, 0, dec, "segs")
    g.connect(dec, 1, scl, "seg")                 # slot 1 = SEG_ELT 列表（自动逐项映射）
    g.connect(dec, 0, asm, "seg_header")          # slot 0 = SEGS_HEADER
    g.connect(scl, 0, asm, "seg_elt")
    g.connect(sg, 0, cnt, "segs")
    g.connect(cnt, 0, prv_cnt, "source")
    g.connect(ld, 0, scr, "image")
    g.connect(asm, 0, scr, "segs")
    g.connect(scr, 0, save, "images")
    g.connect(scr, 1, m2i, "mask")
    g.connect(m2i, 0, prev_m, "images")
    g.connect(scr, 0, back, "image")
    g.connect(asm, 0, back, "segs")
    g.connect(back, 0, prev_b, "images")
    g.connect(ld, 0, save_o, "images")
    return g


def build_boxmerge(oi, img, model, key):
    """
    标记框「合并」——同样由**外部节点**做：
      BboxDetectorSEGS → ImpactSEGSMerge（多框 → 1 框：bbox 取并集、掩膜取并集、label=merged）
                      → CX_RegionScramble / CX_RegionUnscramble
    同时留一条**不合并**的对照支路，一眼能看出合并前后的区别。
    """
    g = Graph(oi)
    ld = g.add("LoadImage", (40, 60), {"image": img}, (330, 330), "0. 原图")
    det = g.add("UltralyticsDetectorProvider", (400, 60), {"model_name": model}, (340, 80),
                "1. bbox 模型")
    sg = g.add("BboxDetectorSEGS", (400, 200), {"crop_factor": 1.0, "dilation": 10,
                                                "drop_size": 10, "threshold": 0.5,
                                                "labels": "all"}, (330, 200),
               "2. 检测 → SEGS（标记框）")
    mrg = g.add("ImpactSEGSMerge", (780, 200), {}, (300, 80),
                "3. 标记框合并：多框 → 1 框（外部节点）")
    cnt = g.add("ImpactCount_Elts_in_SEGS", (780, 340), {}, (280, 60), "4. 合并后的框数（=1）")
    prv_cnt = g.add("PreviewAny", (1100, 340), {}, (330, 220), "5. 框数")
    scr = g.add("CX_RegionScramble", (40, 440),
                {"aabb": "", "key": key, "region_shape": "bbox"}, (430, 420),
                "6. 打码（合并后的框：一个并集外接框）")
    save = g.add("SaveImage", (500, 440), {"filename_prefix": "CX_boxmerge_merged"}, (400, 420),
                 "7. 合并后打码图")
    m2i = g.add("MaskToImage", (500, 900), {}, (330, 60), "8. 合并后实际打码区域")
    prev_m = g.add("PreviewImage", (860, 900), {}, (400, 420), "9. 合并后的打码块")
    back = g.add("CX_RegionUnscramble", (960, 440),
                 {"aabb": "", "key": key, "region_shape": "bbox"}, (430, 420),
                 "10. 还原（同一份合并后 SEGS）")
    prev_b = g.add("PreviewImage", (1420, 440), {}, (400, 420), "11. 还原图（应与原图一致）")
    scr2 = g.add("CX_RegionScramble", (40, 1000),
                 {"aabb": "", "key": key, "region_shape": "mask"}, (430, 440),
                 "12. 对照：合并后的框 + 掩膜口味（region_shape=mask，按分割形状打）")
    m2i2 = g.add("MaskToImage", (500, 1000), {}, (330, 60), "13. 两种口径的有效区域（上=外接框）")
    prev_m2 = g.add("PreviewImage", (860, 1000), {}, (400, 420), "14. 掩膜口径的打码块")
    scr3 = g.add("CX_RegionScramble", (40, 1520),
                 {"aabb": "", "key": key, "region_shape": "bbox"}, (430, 400),
                 "15. 对照：**不合并**的原始框")
    m2i3 = g.add("MaskToImage", (500, 1520), {}, (330, 60), "16. 不合并时的有效区域")
    prev_m3 = g.add("PreviewImage", (860, 1520), {}, (400, 420), "17. 不合并时的打码块（多块）")
    g.connect(ld, 0, sg, "image")
    g.connect(det, 0, sg, "bbox_detector")
    g.connect(sg, 0, mrg, "segs")
    g.connect(mrg, 0, cnt, "segs")
    g.connect(cnt, 0, prv_cnt, "source")
    g.connect(ld, 0, scr, "image")
    g.connect(mrg, 0, scr, "segs")
    g.connect(scr, 0, save, "images")
    g.connect(scr, 1, m2i, "mask")
    g.connect(m2i, 0, prev_m, "images")
    g.connect(scr, 0, back, "image")
    g.connect(mrg, 0, back, "segs")
    g.connect(back, 0, prev_b, "images")
    g.connect(ld, 0, scr2, "image")
    g.connect(mrg, 0, scr2, "segs")
    g.connect(scr2, 1, m2i2, "mask")
    g.connect(m2i2, 0, prev_m2, "images")
    g.connect(ld, 0, scr3, "image")
    g.connect(sg, 0, scr3, "segs")
    g.connect(scr3, 1, m2i3, "mask")
    g.connect(m2i3, 0, prev_m3, "images")
    return g


def verify(server, prompt, label, timeout=600):
    try:
        pid = post(server + "/prompt", {"prompt": prompt, "client_id": "cx-wf"})["prompt_id"]
    except urllib.error.HTTPError as e:
        return False, "提交被拒: " + e.read().decode("utf-8", "replace")[:300]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = get(server + "/history/" + pid)
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error" or not st.get("completed", True):
                for m in st.get("messages", []):
                    if m[0] == "execution_error":
                        return False, "节点 %s 报错: %s" % (m[1].get("node_type"),
                                                          m[1].get("exception_message", "")[:160])
                return False, str(st)[:200]
            return True, "prompt_id=" + pid
        time.sleep(0.5)
    return False, "超时"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8188")
    ap.add_argument("--image", default="ref_1152x1920.jpg", help="被处理的图（需存在于该 ComfyUI 的 input）")
    ap.add_argument("--mask-image", default="cx_demo_mask.png", help="掩膜路线用的掩膜图")
    ap.add_argument("--model", default="bbox/face_yolov8m.pt")
    ap.add_argument("--segm-model", default="segm/person_yolov8m-seg.pt")
    ap.add_argument("--password", default="cx-demo", help="唯一密码（segm 一体工作流用）")
    ap.add_argument("--key", type=int, default=20240117)
    ap.add_argument("--aabb", default="101,57,200,150")
    ap.add_argument("--outdir", default=os.path.join(PKG, "workflows"))
    ap.add_argument("--copy-to", action="append", default=[])
    ap.add_argument("--meta-image", default="cx_meta_demo.png",
                    help="元数据还原路线用的「带元数据打码图」（需存在于 input）")
    ap.add_argument("--only", default="", help="只生成/验证这些：detect,mask,aabb,metawrite,metaread,segm,"
                                              "boxscale,boxmerge")
    ap.add_argument("--box-scale", type=float, default=1.5, help="boxscale 工作流里的缩放倍数")
    ap.add_argument("--skip-verify", default="", help="跳过真机验证的计划（逗号分隔，如 detect）")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()

    oi = get(args.server + "/object_info")
    for n in ("CX_RegionScramble", "CX_RegionUnscramble"):
        if n not in oi:
            raise SystemExit("服务端没加载 %s，先重启那个 ComfyUI" % n)
    os.makedirs(args.outdir, exist_ok=True)

    print("服务端控件顺序（%s）:" % args.server)
    print("  CX_RegionScramble widgets =", widget_names(oi, "CX_RegionScramble"))
    print("  CX_RegionScramble sockets =", Graph(oi).sockets_of_names("CX_RegionScramble"))

    plans = [
        ("cx-e2ee-scramble-detect", "bbox 检测模型（Ultralytics → SEGS）",
         build_detect(oi, args.image, args.model, args.key)),
        ("cx-e2ee-scramble-mask", "分割掩膜（ImageToMask → MaskToSEGS）",
         build_mask(oi, args.image, args.mask_image, args.key)),
        ("cx-e2ee-scramble-aabb", "手写坐标 aabb",
         build_aabb(oi, args.image, args.aabb, args.key)),
        ("cx-e2ee-scramble-meta-write", "打码 + 写元数据（还原只要 图+密码）",
         build_meta_write(oi, args.image, args.aabb, args.key)),
        ("cx-e2ee-scramble-meta-read", "只给 带元数据的图 + 密码 还原",
         build_meta_read(oi, args.meta_image, args.key)),
        ("cx-e2ee-segm-roundtrip", "segm 模型打码 + 纯 图/密码 解码（一体）",
         build_segm_roundtrip(oi, args.image, args.segm_model, args.key, args.password)),
        ("cx-e2ee-scramble-boxscale", "标记框按轴心缩放（外部 Impact 节点）→ 打码/还原",
         build_boxscale(oi, args.image, args.model, args.key, args.box_scale)),
        ("cx-e2ee-scramble-boxmerge", "标记框合并（外部 Impact 节点）→ 打码/还原",
         build_boxmerge(oi, args.image, args.model, args.key)),
    ]
    if args.only:
        want = {x.strip() for x in args.only.split(",") if x.strip()}
        short = {"detect": 0, "mask": 1, "aabb": 2, "metawrite": 3, "metaread": 4, "segm": 5,
                 "boxscale": 6, "boxmerge": 7}
        plans = [plans[short[w]] for w in want if w in short]

    made = []
    for slug, title, g in plans:
        ui = g.to_ui()
        api = g.to_api()
        p_ui = os.path.join(args.outdir, slug + ".json")
        p_api = os.path.join(args.outdir, slug + ".api.json")
        with open(p_ui, "w", encoding="utf-8", newline="\n") as f:
            json.dump(ui, f, ensure_ascii=False, indent=1)
        with open(p_api, "w", encoding="utf-8", newline="\n") as f:
            json.dump(api, f, ensure_ascii=False, indent=1)
        # 前端契约自检：extra 里不能有 ds（有 ds 就会走到 canvas.ds.offset = extra.ds.offset）
        ds = (ui.get("extra") or {}).get("ds", None)
        check("extra 存在且**不含** ds（避开前端 set offset 崩溃点）", "extra" in ui and ds is None,
              str(ui.get("extra")))
        # UI 结构自检：链接两端的节点/槽位都在
        ids = {n["id"] for n in ui["nodes"]}
        bad = [l for l in ui["links"] if l[1] not in ids or l[3] not in ids]
        print("\n== %s（%s） ==" % (slug, title))
        check("UI 图结构自检：%d 节点 / %d 链接，两端都存在" % (len(ui["nodes"]), len(ui["links"])),
              not bad, str(bad))
        check("每条链接的类型与源输出一致",
              all(l[5] == next(x for x in ui["nodes"] if x["id"] == l[1])["outputs"][l[2]]["type"]
                  for l in ui["links"]))
        skip = {x.strip() for x in args.skip_verify.split(",") if x.strip()}
        if not args.no_verify and slug.split("-")[-1] not in skip and slug not in skip:
            ok, msg = verify(args.server, api, slug)
            check("真服务跑通（API 等价图）", ok, msg)
        for d in [args.outdir] + args.copy_to:
            if os.path.abspath(d) != os.path.abspath(args.outdir):
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, slug + ".json"), "w", encoding="utf-8", newline="\n") as f:
                    json.dump(ui, f, ensure_ascii=False, indent=1)
        made.append(p_ui)

    print("\n写出：")
    for p in made:
        print("   ", p)
    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())

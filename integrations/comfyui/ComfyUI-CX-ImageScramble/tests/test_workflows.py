# -*- coding: utf-8 -*-
"""
test_workflows.py — 校验 workflows/ 里生成的示例工作流能不能被 ComfyUI 前端正常打开。

起因：生成的 UI 图里 `extra.ds` 只写了 scale 没写 offset，前端 loadGraphData→fitView 执行
      `canvas.ds.offset = extra.ds.offset`，而 `DragAndScale.set offset(e){this.state.offset[0]=e[0]}`
      → "TypeError: Cannot read properties of undefined (reading '0')"，工作流直接打不开。
      这里把前端会真正访问的字段全部断言一遍，防回归。

用法：
    venv\\Scripts\\python.exe tests\\test_workflows.py                       # 离线结构校验
    venv\\Scripts\\python.exe tests\\test_workflows.py --server http://127.0.0.1:8195
        # 额外：节点类型是否存在于该服务、控件个数/顺序、API 图的必填项是否齐全
"""

import argparse
import glob
import json
import os
import sys
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
WF = os.path.join(PKG, "workflows")
WIDGET_TYPES = ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO")

FAIL = []


def check(name, ok, extra=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + extra) if extra else ""))
    if not ok:
        FAIL.append(name)


def widget_names(oi, ntype):
    v = oi[ntype]["input"]
    out = []
    for sec in ("required", "optional"):
        for k, val in (v.get(sec) or {}).items():
            t = val[0]
            if isinstance(t, list) or t in WIDGET_TYPES:
                out.append(k)
    return out


def socket_names(oi, ntype):
    v = oi[ntype]["input"]
    out = []
    for sec in ("required", "optional"):
        for k, val in (v.get(sec) or {}).items():
            t = val[0]
            if not (isinstance(t, list) or t in WIDGET_TYPES):
                out.append((k, t))
    return out


def check_ui(path, oi=None):
    name = os.path.basename(path)
    d = json.load(open(path, encoding="utf-8"))
    print("== %s ==" % name)
    # 前端 loadGraphData→fitView 只在 extra.ds 存在时才执行 canvas.ds.offset = extra.ds.offset，
    # 而 DragAndScale.set offset(){this.state.offset[0]=e[0]} 任一侧缺字段即抛
    # TypeError: Cannot read properties of undefined (reading '0')。所以我们不写 extra.ds，
    # 强制它走 useLitegraphService().fitView() 这条安全分支。
    ds = (d.get("extra") or {}).get("ds", None)
    if ds is None:
        check("extra 不含 ds（走前端安全分支，不会触发 set offset 崩溃）", True)
    else:
        try:
            _ = ds["offset"][0], ds["scale"]
            ok = isinstance(ds["offset"], list) and len(ds["offset"]) == 2
        except Exception:  # noqa: BLE001
            ok = False
        check("如果非要写 extra.ds，则 offset[2]+scale 必须齐全", ok, str(ds))

    ids = {n["id"] for n in d.get("nodes", [])}
    check("节点非空且 id 唯一", bool(ids) and len(ids) == len(d["nodes"]))
    check("顶层字段齐全（last_node_id/last_link_id/links/groups/config/version）",
          all(k in d for k in ("last_node_id", "last_link_id", "links", "groups", "config", "version")))
    bad = []
    for n in d["nodes"]:
        for k in ("id", "type", "pos", "size", "flags", "order", "mode", "inputs", "outputs",
                  "properties", "widgets_values"):
            if k not in n:
                bad.append((n.get("id"), k))
    check("每个节点都有前端需要的字段", not bad, str(bad[:3]))

    bad = []
    for l in d.get("links", []):
        lid, sn, ss, dn, ds, ty = l
        if sn not in ids or dn not in ids:
            bad.append(("端点不存在", l))
            continue
        s = next(n for n in d["nodes"] if n["id"] == sn)
        t = next(n for n in d["nodes"] if n["id"] == dn)
        if ss >= len(s["outputs"]) or ds >= len(t["inputs"]):
            bad.append(("槽位越界", l))
        elif s["outputs"][ss].get("type") != ty:
            bad.append(("源类型不符", l))
    check("所有链接两端/槽位/类型都对得上", not bad, str(bad[:3]))

    bad = []
    for n in d["nodes"]:
        for i, inp in enumerate(n["inputs"]):
            if inp.get("link") is not None and not any(l[0] == inp["link"] for l in d["links"]):
                bad.append((n["id"], inp.get("name")))
        for o in n["outputs"]:
            for lid in (o.get("links") or []):
                if not any(l[0] == lid for l in d["links"]):
                    bad.append((n["id"], "output link", lid))
    check("inputs/outputs 里引用的 link id 都存在于 links[]", not bad, str(bad[:3]))

    if oi is not None:
        missing = [n["type"] for n in d["nodes"] if n["type"] not in oi]
        check("节点类型都在服务端注册表里", not missing, str(missing))
        bad = []
        for n in d["nodes"]:
            if n["type"] not in oi:
                continue
            exp = widget_names(oi, n["type"])
            got = len(n.get("widgets_values") or [])
            if got > len(exp):
                bad.append((n["type"], got, len(exp)))
            # CX 节点：控件值个数必须正好等于控件数（我们生成时是全量填的）
            if n["type"].startswith("CX_") and got != len(exp):
                bad.append((n["type"], "CX 控件数不符", got, len(exp)))
            exp_sock = [k for k, _ in socket_names(oi, n["type"])]
            got_sock = [i["name"] for i in n["inputs"]]
            if exp_sock != got_sock:
                bad.append((n["type"], "socket 顺序不符", got_sock, exp_sock))
        check("控件个数/顺序与 /object_info 一致（不会整体错位）", not bad, str(bad[:2]))


def check_api(path, oi):
    name = os.path.basename(path)
    print("== %s ===" % name)
    d = json.load(open(path, encoding="utf-8"))
    bad = []
    for nid, node in d.items():
        t = node["class_type"]
        if t not in oi:
            bad.append((nid, t, "类型不存在"))
            continue
        need = list(oi[t]["input"].get("required", {}).keys())
        for k in need:
            if k not in node.get("inputs", {}):
                bad.append((t, "缺必填", k))
        for k, v in node.get("inputs", {}).items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] in d:
                src = d[v[0]]["class_type"]
                if src not in oi:
                    bad.append((t, k, "连的节点类型不存在"))
    check("API 图：必填项齐全、连线节点存在（服务端会跑的就是它）", not bad, str(bad[:3]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="", help="给了就顺带校验 /object_info（控件顺序、必填项）")
    args = ap.parse_args()

    oi = None
    if args.server:
        with urllib.request.urlopen(args.server + "/object_info", timeout=120) as r:
            oi = json.loads(r.read().decode())
        print("已取到 %s 的 /object_info（%d 个节点）\n" % (args.server, len(oi)))

    ui_files = sorted(p for p in glob.glob(os.path.join(WF, "*.json"))
                      if not p.endswith(".api.json"))
    if not ui_files:
        raise SystemExit("workflows/ 下没有 UI 格式的工作流")
    for p in ui_files:
        check_ui(p, oi)
        print()
    for p in sorted(glob.glob(os.path.join(WF, "*.api.json"))):
        if oi is None:
            print("== %s ==（未给 --server，跳过 API 校验）\n" % os.path.basename(p))
            continue
        check_api(p, oi)
        print()

    if FAIL:
        print("结果：%d 项失败 → %s" % (len(FAIL), FAIL))
        return 1
    print("结果：全部通过 ✅ 工作流可被 ComfyUI 正常打开")
    return 0


if __name__ == "__main__":
    sys.exit(main())

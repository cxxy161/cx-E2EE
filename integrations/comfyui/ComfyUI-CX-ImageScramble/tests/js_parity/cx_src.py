# -*- coding: utf-8 -*-
"""
cx_src.py — 定位「真源」 src/image-crypto.js（对照测试的唯一依据）

本包被放在两处都能跑：仓库内（integrations/comfyui/）与 ComfyUI 的 custom_nodes/ 下。
所以 src/image-crypto.js 的路径不能写死，按下列顺序找第一个存在的：

  1. 显式参数（--src / argv）
  2. 环境变量 CX_E2EE_SRC（整个文件的路径）
  3. 环境变量 CX_E2EE_ROOT（仓库根目录）下的 src/image-crypto.js
  4. 从本文件所在目录逐级向上找 6 层，取每层下的 src/image-crypto.js
     （仓库内是 tests/js_parity → tests → 包 → comfyui → integrations → 仓库根）
  5. 本机上出现过的两个 checkout（纯兜底，找不到就报错，不会静默跳过对照）

找不到就抛 FileNotFoundError，并把找过的路径全部列出来 —— 对照测试宁可失败也不许
「假装通过」，因为它证明的就是「本实现与网页端逐位等价」。
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))

FALLBACK_ROOTS = [
    r"D:\project\RedMoon\cx-E2EE",
    r"D:\project\cx-E2EE",
]

REL = os.path.join("src", "image-crypto.js")


def candidates(explicit=None):
    out = []
    if explicit:
        out.append(explicit)
    env_src = os.environ.get("CX_E2EE_SRC")
    if env_src:
        out.append(env_src)
    env_root = os.environ.get("CX_E2EE_ROOT")
    if env_root:
        out.append(os.path.join(env_root, REL))

    d = HERE
    for _ in range(6):
        d = os.path.dirname(d)
        if not d or d == os.path.dirname(d):
            break
        out.append(os.path.join(d, REL))

    for root in FALLBACK_ROOTS:
        out.append(os.path.join(root, REL))

    seen, uniq = set(), []
    for p in out:
        k = os.path.normcase(os.path.abspath(p))
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    return uniq


def resolve(explicit=None):
    for p in candidates(explicit):
        if os.path.isfile(p):
            return os.path.abspath(p)
    raise FileNotFoundError(
        "找不到 src/image-crypto.js（对照测试的真源）。找过：\n  "
        + "\n  ".join(candidates(explicit))
        + "\n请用 --src <路径> 或环境变量 CX_E2EE_SRC / CX_E2EE_ROOT 指定。"
    )


if __name__ == "__main__":
    print(resolve())

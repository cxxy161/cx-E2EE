#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_ref_impl.py — 从 cx-E2EE 的真源码里「原样抽取」JS 实现（不手抄），
生成 tests/js_parity/ref_impl.mjs。

抽取对象：src/image-crypto.js 里 IA 对象的
    hash(s) / rng(a) / perm(len, seed) / regionEnc(d, w, h, reg, seed, E, sort, soft, unit)

用法：
    python make_ref_impl.py [image-crypto.js 路径] [输出 ref_impl.mjs 路径]

不给第一个参数时，用 cx_src.resolve() 自动找 src/image-crypto.js（仓库内 / custom_nodes
两种位置都能找到；也可用环境变量 CX_E2EE_SRC / CX_E2EE_ROOT 指定）。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cx_src  # noqa: E402


def extract_method(src: str, marker_re: str) -> str:
    m = re.search(marker_re, src)
    if not m:
        raise SystemExit("在源码里找不到方法：%s" % marker_re)
    brace = src.index("{", m.end() - 1)
    depth = 0
    i = brace
    while i < len(src):
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                j = i + 1
                while j < len(src) and src[j] in " \t":
                    j += 1
                if j < len(src) and src[j] == ",":
                    j += 1
                return src[m.start():j]
        i += 1
    raise SystemExit("方法体大括号不平衡：%s" % marker_re)


def src_label(p: str) -> str:
    """头部注释里写的源文件路径：能认出来就写成仓库相对形式（不把本机绝对路径写进产物）。

    这就是本包里唯一会把路径带进生成文件的地方，所以这里刻意不写绝对路径 ——
    ref_impl.mjs 是要入库的，换台机器重跑不应该产生无意义的 diff。
    """
    norm = os.path.normpath(p)
    parts = norm.split(os.sep)
    if len(parts) >= 2 and parts[-1] == "image-crypto.js" and parts[-2] == "src":
        return "src/image-crypto.js"
    return norm


def main():
    src_path = sys.argv[1] if len(sys.argv) > 1 else cx_src.resolve()
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "ref_impl.mjs")
    src = open(src_path, encoding="utf-8").read()

    parts = [
        extract_method(src, r"\n\s{4}hash\(s\) \{"),
        extract_method(src, r"\n\s{4}rng\(a\) \{"),
        extract_method(src, r"\n\s{4}perm\(len, seed\) \{"),
        extract_method(src, r"\n\s{4}regionEnc\(d, w, h, reg, seed, E, sort, soft, unit\) \{"),
        extract_method(src, r"\n\s{4}metaBytes\(count, regions, k, flag, dataLen\) \{"),
        extract_method(src, r"\n\s{4}parseMeta\(bs\) \{"),
        extract_method(src, r"\n\s{4}borderOrd\(cw, ch, B\) \{"),
        extract_method(src, r"\n\s{4}wMetaPng\(bs, d, ord\) \{"),
        extract_method(src, r"\n\s{4}rMetaPng\(d, ord, maxB\) \{"),
    ]
    body = "export const IA = {\n" + "\n".join(parts) + "\n};\n"
    header = (
        "// 自动生成 by make_ref_impl.py —— 内容原样抽取自 cx-E2EE/src/image-crypto.js\n"
        "// 抽取源: %s\n" % src_label(src_path)
    )
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + body)
    print("wrote %s (%d bytes, %d methods)"
          % (out_path, len(header) + len(body), len(parts)))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
gen_golden.py — 生成 Golden Vectors（Step 3）

客户端 WASM/JS 内核用本文件产出的向量做**逐 bit 一致性对齐**。

产物（pkg/golden/）：
    golden.json   3 组 prompt：输入 id、逐层 FNV-1a 64 哈希、最终 Top-64
    golden.bin    每组 prompt 的完整 int32 logits（4096 个），便于二分定位

哈希算法：FNV-1a 64（纯整数，JS/WASM 极易实现，无库依赖）
    h = 0xcbf29ce484222325
    for byte in data:  h ^= byte;  h *= 0x100000001b3   (mod 2^64)
    data = 张量按 C 序 int32 小端字节流

⚠ 客户端必须按"先转 int32 小端字节流、再逐字节 FNV"的方式计算，不要对
   Python 整数直接哈希（否则字节序/符号扩展会不一致）。
   本实现用 numpy view 成小端字节，与 JS 的 DataView.setInt32(le) 一致。
"""
from __future__ import annotations

import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from load_fixed import FixedModel  # noqa: E402

PKG = os.path.join(HERE, "pkg")
OUT = os.path.join(PKG, "golden")

# 3 组固定 prompt：覆盖 中文 / 引号对话 / ASCII+数字 三类输入
PROMPTS = [
    {"id": "p1_narrative", "text": "飞船缓缓降落在荒芜的星球表面",
     "note": "纯中文叙事开头"},
    {"id": "p2_dialogue", "text": "“你确定要这么做吗？”她问。",
     "note": "中文引号对话（检验引号 token 编码路径）"},
    {"id": "p3_log", "text": "终端日志：SYS-0x7F 冷却液压力 12.4kPa 状态=警告",
     "note": "ASCII + 数字 + 中文混排（检验非中文 token 路径）"},
]

FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1


def fnv1a64_i32(arr: np.ndarray) -> int:
    """对 int32 张量按 C 序小端字节流做 FNV-1a 64。"""
    b = np.ascontiguousarray(arr.astype("<i4")).tobytes()
    h = FNV_OFFSET
    for byte in b:
        h ^= byte
        h = (h * FNV_PRIME) & MASK64
    return h


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    M = FixedModel()
    # 用分词器把 prompt 转成 id（客户端应离线拿到这些 id，或用自己的等价实现）
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(os.path.join(HERE, "tokenizer.json"))

    groups = []
    blob = bytearray()
    for spec in PROMPTS:
        ids = tok.encode(spec["text"]).ids
        cap = {}
        logits = M.forward(ids, capture=cap)          # int64 [T, vocab]
        last = logits[-1].astype(np.int64)

        # 逐层哈希（覆盖 emb + 每层 attn_out / block_out + final_norm）
        layer_hashes = {"emb": fnv1a64_i32(cap["emb"])}
        for i in range(M.cfg["n_layer"]):
            layer_hashes[f"blk{i}.attn_out"] = fnv1a64_i32(cap[f"blk{i}.attn_out"])
            layer_hashes[f"blk{i}.out"] = fnv1a64_i32(cap[f"blk{i}.out"])
        layer_hashes["final_norm"] = fnv1a64_i32(cap["final_norm"])
        layer_hashes["logits_last"] = fnv1a64_i32(last.astype(np.int32))

        # Top-64：按 int32 分数降序；同分以 token id 升序决胜（确定性并列规则）
        order = np.lexsort((np.arange(last.size), -last))
        top = order[:64]
        top_list = [{"rank": r + 1, "token_id": int(t),
                     "score_i32": int(last[t])} for r, t in enumerate(top)]

        # logits 完整 dump
        off = len(blob)
        blob += last.astype("<i4").tobytes()
        groups.append({
            "id": spec["id"], "text": spec["text"], "note": spec["note"],
            "prompt_ids": [int(x) for x in ids],
            "prompt_bytes_utf8": [int(b) for b in spec["text"].encode("utf-8")],
            "n_tokens": len(ids),
            "layer_hashes": layer_hashes,
            "top64": top_list,
            "logits_offset": off,
            "logits_bytes": int(last.size * 4),
            "logits_frac": M.RES_FRAC,
        })
        print(f"[golden] {spec['id']:12s} T={len(ids):2d}  "
              f"top1={top_list[0]['token_id']}({top_list[0]['score_i32']})  "
              f"logits_hash={layer_hashes['logits_last']:#018x}")

    with open(os.path.join(OUT, "golden.bin"), "wb") as f:
        f.write(blob)

    meta = {
        "schema": "pcd-v3-6M-fixedpoint-golden/1",
        "hash": {
            "algo": "FNV-1a 64",
            "offset_basis": FNV_OFFSET, "prime": FNV_PRIME, "mod": "2^64",
            "input": "张量按 C 序转 int32 小端字节流后逐字节哈希",
            "reference_js": (
                "function fnv1a64(bytes) {            // bytes: Uint8Array\n"
                "  let h = 0xcbf29ce484222325n;\n"
                "  const p = 0x100000001b3n, m = (1n<<64n)-1n;\n"
                "  for (const b of bytes) { h ^= BigInt(b); h = (h*p) & m; }\n"
                "  return h;                            // BigInt, 输出 16 位小写 hex\n"
                "}"
            ),
        },
        "note": "logits 为 int32，定点 2^-RES_FRAC；Top-64 按分数降序，"
                "同分以 token_id 升序决胜。",
        "globals": {"RES_FRAC": M.RES_FRAC, "byte_order": "little"},
        "n_groups": len(groups),
        "golden_bin": {"file": "golden.bin", "total_bytes": len(blob)},
        "groups": groups,
    }
    with open(os.path.join(OUT, "golden.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n[golden] -> {OUT}/golden.json  ({os.path.getsize(os.path.join(OUT,'golden.json'))} B)")
    print(f"[golden] -> {OUT}/golden.bin   ({len(blob)} B)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
export_fixed.py — 导出定点模型资产（Step 2）

从 fp32 checkpoint 生成全整数推理所需的全部资产，并生成 format.json 清单。

产物（输出目录 pcd-v3-6M-fixedpoint/model/）：
    weights.bin   int8 权重 + 逐输出行 int32 M（定点 scale 分子）
    norm.bin      int32 RMSNorm 权重（定点 2^-NORM_FRAC）
    tables.bin    EXP_LUT / SIG_LUT / RoPE cos / RoPE sin（全部 int32）
    vocab.bin     词表：4096×uint16 偏移索引（8KB）+ 纯 UTF-8 字节流
    format.json   资产清单（张量字典 / 偏移 / 形状 / 全局常量）

格式要点
--------
权重 W[out,in] ≈ q * M[out] / 2^W_SHIFT，q 为 int8，M 为 int32。
    -> 没有 float32 scale；M/2^S 是任意有理数，精度远好于 power-of-two。
    -> 运行时： (acc * M) >> (W_SHIFT - s_x)   —— 纯整数乘 + 移位。
vocab.bin 采用紧凑格式：前 8192 字节 = 4096 个 uint16 小端偏移，
    其后为拼接的 UTF-8 字节流；token i 的字节 = stream[offset[i] : offset[i+1]]，
    最后一个 token 的结束位置 = format.json 的 vocab_stream_bytes。
    ⚠ 本模型是 BPE 词表：token 与"单个汉字"不是 1:1（一个 token 可能 1~15 字节）。
      客户端只做 id -> bytes 查表，不运行 BPE，因此仍是完全确定性的。
"""
from __future__ import annotations

import json
import os
import struct
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from int_ref import (EXP_LUT_MAX, EXP_LUT_N, LUT_FRAC, NORM_FRAC,  # noqa: E402
                     Q_MAX, RES_FRAC, ROPE_FRAC, SIG_LUT_MAX, SIG_LUT_N,
                     W_SHIFT, build_luts, build_rope_tables)

CKPT = os.path.join(HERE, "model.pt")
TOK = os.path.join(HERE, "tokenizer.json")
OUT = os.path.join(HERE, "pkg", "model")

# 导出顺序固定（客户端按 format.json 的 tensors 数组遍历即可，无需硬编码顺序）
TENSOR_SPEC = []          # (name, keypath, kind)
for _i in range(6):
    for _n, _k in [("q", "attn.q_proj"), ("k", "attn.k_proj"), ("v", "attn.v_proj"),
                   ("o", "attn.o_proj"), ("gate", "ffn.gate"), ("up", "ffn.up"),
                   ("down", "ffn.down")]:
        TENSOR_SPEC.append((f"blocks.{_i}.{_n}", f"blocks.{_i}.{_k}.weight", "w"))
TENSOR_SPEC.append(("tok_emb", "tok_emb.weight", "w"))   # 权重绑定，兼作输出头


def quant_row(w):
    """逐输出行 INT8 + 整数 (M, W_SHIFT)。"""
    wf = w.astype(np.float64)
    amax = np.maximum(np.abs(wf).max(axis=1, keepdims=True), 1e-30)
    scale = amax / Q_MAX                                  # 真实 scale（导出期浮点，一次性）
    m = np.maximum(np.floor(scale * (1 << W_SHIFT) + 0.5), 1).astype(np.int64)
    q = np.clip(np.floor(wf / scale + 0.5), -Q_MAX, Q_MAX).astype(np.int8)
    return q, m.ravel().astype(np.int32)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    ck = torch.load(CKPT, map_location="cpu", weights_only=False)
    sd = ck["model"]
    cfg = ck["config"]

    # ---------------- weights.bin ----------------
    wbuf = bytearray()
    tensors = []
    for name, key, kind in TENSOR_SPEC:
        w = sd[key].numpy()
        q, m = quant_row(w)
        off_q = len(wbuf)
        wbuf += q.tobytes(order="C")
        off_m = len(wbuf)
        wbuf += m.tobytes(order="C")
        tensors.append({
            "name": name, "shape": list(q.shape),
            "q_offset": off_q, "q_bytes": int(q.size),
            "m_offset": off_m, "m_bytes": int(m.size * 4), "m_count": int(m.size),
        })
    with open(os.path.join(OUT, "weights.bin"), "wb") as f:
        f.write(wbuf)

    # ---------------- norm.bin ----------------
    nbuf = bytearray()
    norms = []
    for i in range(cfg["n_layer"]):
        for tag, key in (("norm1", f"blocks.{i}.norm1.weight"),
                         ("norm2", f"blocks.{i}.norm2.weight")):
            g = sd[key].numpy().astype(np.float64)
            gq = np.floor(g * (1 << NORM_FRAC) + 0.5).astype(np.int32)
            off = len(nbuf); nbuf += gq.tobytes(order="C")
            norms.append({"name": f"blocks.{i}.{tag}", "count": int(gq.size), "offset": off})
    g = sd["norm.weight"].numpy().astype(np.float64)
    gq = np.floor(g * (1 << NORM_FRAC) + 0.5).astype(np.int32)
    off = len(nbuf); nbuf += gq.tobytes(order="C")
    norms.append({"name": "final_norm", "count": int(gq.size), "offset": off})
    with open(os.path.join(OUT, "norm.bin"), "wb") as f:
        f.write(nbuf)

    # ---------------- tables.bin ----------------
    exp_lut, sig_lut = build_luts()
    rope_len = int(cfg["max_seq_len"])            # 只导出训练上下文长度（512）
    cos_q, sin_q = build_rope_tables(rope_len, cfg["head_dim"], cfg["rope_theta"], ROPE_FRAC)
    tbuf = bytearray()
    tables = []
    for nm, arr, dt in (("exp_lut", exp_lut, "int32"), ("sig_lut", sig_lut, "int32"),
                        ("rope_cos", cos_q, "int32"), ("rope_sin", sin_q, "int32")):
        off = len(tbuf); tbuf += arr.astype(np.int32).tobytes(order="C")
        tables.append({"name": nm, "dtype": dt, "shape": list(arr.shape),
                       "offset": off, "bytes": int(arr.size * 4),
                       "frac": LUT_FRAC if nm.endswith("lut") else ROPE_FRAC})
    with open(os.path.join(OUT, "tables.bin"), "wb") as f:
        f.write(tbuf)

    # ---------------- vocab.bin ----------------
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(TOK)
    vocab_size = tok.get_vocab_size()
    blobs: list[bytes] = []
    for i in range(vocab_size):
        s = tok.decode([i], skip_special_tokens=False)
        blobs.append(s.encode("utf-8", errors="surrogatepass"))
    offsets = np.zeros(vocab_size, dtype="<u2")
    stream = bytearray()
    for i, b in enumerate(blobs):
        if len(stream) > 0xFFFF:
            raise SystemExit("vocab 字节流超过 uint16 可表示范围")
        offsets[i] = len(stream)
        stream += b
    if len(stream) > 0xFFFF:
        raise SystemExit(f"vocab 字节流 {len(stream)} 超 uint16")
    with open(os.path.join(OUT, "vocab.bin"), "wb") as f:
        f.write(offsets.tobytes())          # 8192 字节
        f.write(bytes(stream))
    max_blob = max(len(b) for b in blobs)

    # ---------------- format.json ----------------
    fmt = {
        "schema": "pcd-v3-6M-fixedpoint/1",
        "model": {"name": "pcd-v3-6M", "params": int(sum(v.numel() for v in sd.values()))},
        "arch": cfg,
        "globals": {
            "RES_FRAC": RES_FRAC, "W_SHIFT": W_SHIFT, "NORM_FRAC": NORM_FRAC,
            "LUT_FRAC": LUT_FRAC, "ROPE_FRAC": ROPE_FRAC,
            "Q_MAX": Q_MAX,
            "exp_lut_n": EXP_LUT_N, "exp_lut_max": EXP_LUT_MAX,
            "sig_lut_n": SIG_LUT_N, "sig_lut_max": SIG_LUT_MAX,
            "byte_order": "little",
            "tokenizer": "ByteLevel BPE, vocab=4096 (id->bytes 查表，客户端不跑 BPE)",
        },
        "tensors": tensors,
        "norms": {"dtype": "int32", "frac": NORM_FRAC, "entries": norms},
        "tables": tables,
        "vocab": {
            "file": "vocab.bin", "vocab_size": vocab_size,
            "index_bytes": int(vocab_size * 2), "index_dtype": "uint16le",
            "stream_bytes": len(stream), "max_token_bytes": max_blob,
            "layout": "前 vocab_size*2 字节 = 偏移索引；其后为 UTF-8 字节流。"
                      "token i 的字节 = stream[offset[i] : offset[i+1]]，"
                      "末个 token 的结束 = stream_bytes。",
        },
        "runtime": {
            "quant_act": "逐 token：s = min s 使 max|q| <= 127；q = rshift_round(x, s)",
            "linear": "(acc * M) >> (W_SHIFT - s_x)，acc = int8 @ int8 -> int32",
            "rounding": "rshift_round = 算术右移 + 半值远离零（纯位运算）",
            "note": "参考实现见 int_ref.py；舍入与移位语义以该文件为准",
        },
    }
    with open(os.path.join(OUT, "format.json"), "w", encoding="utf-8") as f:
        json.dump(fmt, f, ensure_ascii=False, indent=2)

    # ---------------- 报告 ----------------
    tot = sum(os.path.getsize(os.path.join(OUT, x)) for x in os.listdir(OUT))
    print(f"[export] tensors={len(tensors)}  norms={len(norms)}  tables={len(tables)}")
    print(f"[export] weights.bin = {os.path.getsize(os.path.join(OUT,'weights.bin'))/1048576:.2f} MiB")
    print(f"[export] norm.bin    = {os.path.getsize(os.path.join(OUT,'norm.bin'))/1024:.1f} KiB")
    print(f"[export] tables.bin  = {os.path.getsize(os.path.join(OUT,'tables.bin'))/1024:.1f} KiB")
    print(f"[export] vocab.bin   = {os.path.getsize(os.path.join(OUT,'vocab.bin'))/1024:.1f} KiB "
          f"(索引 {vocab_size*2} B + 流 {len(stream)} B, 最长 token {max_blob} B)")
    print(f"[export] 合计         = {tot/1048576:.2f} MiB")
    print(f"[export] -> {OUT}")


if __name__ == "__main__":
    main()

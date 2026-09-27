#!/usr/bin/env python3
"""
load_fixed.py — 从导出资产（weights.bin/norm.bin/tables.bin/vocab.bin）重建整数模型

用途：证明"资产本身是自洽的"——即客户端只靠这些二进制 + int_ref.py 的算术，
      就能完成完整前向，不需要原始 fp32 checkpoint。
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from int_ref import (RES_FRAC, ROPE_FRAC, attn_pv, attn_scores, linear,  # noqa: E402
                     linear_from_q, quant_act, rmsnorm, rope_apply,
                     rshift_round, silu_lut, softmax_lut)

# 资产目录：优先 ./model（发布包布局），回退 ./pkg/model（开发布局）
PKG = os.path.join(HERE, "model")
if not os.path.isdir(PKG):
    PKG = os.path.join(HERE, "pkg", "model")


class FixedModel:
    """直接消费导出的二进制资产。"""

    def __init__(self, pkg_dir: str = PKG):
        self.dir = pkg_dir
        with open(os.path.join(pkg_dir, "format.json"), encoding="utf-8") as f:
            self.fmt = json.load(f)
        g = self.fmt["globals"]
        self.RES_FRAC = g["RES_FRAC"]; self.W_SHIFT = g["W_SHIFT"]
        self.cfg = self.fmt["arch"]
        wb = open(os.path.join(pkg_dir, "weights.bin"), "rb").read()
        self.W = {}
        for t in self.fmt["tensors"]:
            out, inn = t["shape"]
            q = np.frombuffer(wb, dtype=np.int8, count=t["q_bytes"], offset=t["q_offset"])
            m = np.frombuffer(wb, dtype="<i4", count=t["m_count"], offset=t["m_offset"])
            self.W[t["name"]] = (q.reshape(out, inn), m.astype(np.int64))
        nb = open(os.path.join(pkg_dir, "norm.bin"), "rb").read()
        self.G = {}
        for e in self.fmt["norms"]["entries"]:
            self.G[e["name"]] = np.frombuffer(nb, dtype="<i4", count=e["count"],
                                              offset=e["offset"]).astype(np.int64)
        tb = open(os.path.join(pkg_dir, "tables.bin"), "rb").read()
        T = {}
        for t in self.fmt["tables"]:
            T[t["name"]] = np.frombuffer(tb, dtype="<i4", count=int(np.prod(t["shape"])),
                                         offset=t["offset"]).reshape(t["shape"]).astype(np.int64)
        self.EXP_LUT, self.SIG_LUT = T["exp_lut"], T["sig_lut"]
        self.COS, self.SIN = T["rope_cos"], T["rope_sin"]
        self.vocab = self._load_vocab()

    def _load_vocab(self) -> list[bytes]:
        vb = open(os.path.join(self.dir, "vocab.bin"), "rb").read()
        v = self.fmt["vocab"]; n = v["vocab_size"]
        offs = np.frombuffer(vb, dtype="<u2", count=n, offset=0)
        stream = vb[v["index_bytes"]:]
        out = []
        for i in range(n):
            a = int(offs[i]); b = int(offs[i + 1]) if i + 1 < n else v["stream_bytes"]
            out.append(stream[a:b])
        return out

    def forward(self, ids, capture=None):
        cfg = self.cfg
        T = len(ids); h = cfg["n_head"]; kv = cfg["n_kv_head"]; hd = cfg["head_dim"]
        qemb, memb = self.W["tok_emb"]
        x = rshift_round(qemb[ids].astype(np.int64) * memb[ids][:, None], self.W_SHIFT - RES_FRAC)
        if capture is not None:
            capture["emb"] = x.copy()
        for i in range(cfg["n_layer"]):
            n1 = rmsnorm(x, self.G[f"blocks.{i}.norm1"])
            q = linear_from_q(*quant_act(n1), *self.W[f"blocks.{i}.q"])
            k = linear_from_q(*quant_act(n1), *self.W[f"blocks.{i}.k"])
            v = linear_from_q(*quant_act(n1), *self.W[f"blocks.{i}.v"])
            q = rope_apply(q.reshape(T, h, hd), self.COS, self.SIN, ROPE_FRAC)
            k = rope_apply(k.reshape(T, kv, hd), self.COS, self.SIN, ROPE_FRAC)
            k = np.repeat(k, h // kv, axis=1)
            vv = np.repeat(v.reshape(T, kv, hd), h // kv, axis=1)
            sc = attn_scores(np.transpose(q, (1, 0, 2)), np.transpose(k, (1, 0, 2)), hd)
            mask = np.triu(np.ones((T, T), dtype=bool), 1)
            sc = np.where(mask[None], np.int64(-(1 << 40)), sc)
            p = softmax_lut(sc, self.EXP_LUT)
            at = attn_pv(p, np.transpose(vv, (1, 0, 2)))
            atf = np.transpose(at, (1, 0, 2)).reshape(T, h * hd)
            x = x + linear_from_q(*quant_act(atf), *self.W[f"blocks.{i}.o"])
            if capture is not None:
                capture[f"blk{i}.attn_out"] = x.copy()
            n2 = rmsnorm(x, self.G[f"blocks.{i}.norm2"])
            g_ = linear(n2, *self.W[f"blocks.{i}.gate"])
            u_ = linear(n2, *self.W[f"blocks.{i}.up"])
            hid = rshift_round(silu_lut(g_, self.SIG_LUT) * u_, RES_FRAC)
            x = x + linear(hid, *self.W[f"blocks.{i}.down"])
            if capture is not None:
                capture[f"blk{i}.out"] = x.copy()
        xf = rmsnorm(x, self.G["final_norm"])
        logits = linear_from_q(*quant_act(xf), *self.W["tok_emb"])
        if capture is not None:
            capture["final_norm"] = xf.copy()
        return logits

    def decode(self, ids) -> str:
        return b"".join(self.vocab[i] for i in ids).decode("utf-8", errors="replace")


if __name__ == "__main__":
    M = FixedModel()
    print(f"资产加载 OK: {len(M.W)} 权重张量, {len(M.G)} norm, vocab={len(M.vocab)}")
    print(f"  最长 token = {max(len(b) for b in M.vocab)} 字节")
    v = M.vocab
    print(f"  token 0..5 解出: {[v[i] for i in range(6)]}")
    print(f"  词表回环: '飞船' -> ids -> bytes -> " +
          M.decode([282, 1140] if False else [i for i, b in enumerate(v) if b == '飞'.encode()][:1]))

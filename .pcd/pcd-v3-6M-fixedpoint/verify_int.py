#!/usr/bin/env python3
"""
verify_int.py — 全整数前向 vs torch fp32 的精度对照（开发期自检，不随交付）

跑法：  ../.venv-train/bin/python verify_int.py
"""
from __future__ import annotations

import os
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from int_ref import (RES_FRAC, W_SHIFT, NORM_FRAC, SCORE_INV_FRAC,  # noqa: E402
                     ROPE_FRAC, Q_MAX, attn_pv, attn_scores, build_luts,
                     build_rope_tables, linear, linear_from_q, quant_act,
                     rmsnorm, rope_apply, rshift_round, silu_lut, softmax_lut)
import model as TM  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402


def q_weights(w):
    """逐输出行 INT8 + 整数 (M,S)，S=W_SHIFT。返回 (q int8, m int32[out])。"""
    wf = w.astype(np.float64)
    amax = np.maximum(np.abs(wf).max(axis=1, keepdims=True), 1e-30)
    scale = amax / Q_MAX
    m = np.maximum(np.floor(scale * (1 << W_SHIFT) + 0.5), 1).astype(np.int64)
    q = np.clip(np.floor(wf / scale + 0.5), -Q_MAX, Q_MAX).astype(np.int8)
    return q, m.ravel().astype(np.int32)


class IntModel:
    def __init__(self, ckpt_path):
        ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        self.sd = ck["model"]
        self.cfg = TM.ModelConfig.from_dict(ck["config"])
        self.cfg.use_checkpoint = False
        self.torch_model = TM.GPT(self.cfg)
        self.torch_model.load_state_dict(self.sd)
        self.torch_model.eval()
        self._prep()

    def _prep(self):
        cfg = self.cfg
        self.W = {}
        for i in range(cfg.n_layer):
            p = f"blocks.{i}"
            for nm, key in [("q", "attn.q_proj.weight"), ("k", "attn.k_proj.weight"),
                            ("v", "attn.v_proj.weight"), ("o", "attn.o_proj.weight"),
                            ("gate", "ffn.gate.weight"), ("up", "ffn.up.weight"),
                            ("down", "ffn.down.weight")]:
                self.W[f"{p}.{nm}"] = q_weights(self.sd[f"{p}.{key}"].numpy())
        self.W["emb"] = q_weights(self.sd["tok_emb.weight"].numpy())
        sc = 1 << NORM_FRAC
        self.G = {}
        for i in range(cfg.n_layer):
            for tag in ("norm1", "norm2"):
                self.G[f"blocks.{i}.{tag}"] = np.floor(
                    self.sd[f"blocks.{i}.{tag}.weight"].numpy().astype(np.float64) * sc + 0.5).astype(np.int64)
        self.G["final_norm"] = np.floor(self.sd["norm.weight"].numpy().astype(np.float64) * sc + 0.5).astype(np.int64)
        self.EXP_LUT, self.SIG_LUT = build_luts()
        self.COS, self.SIN = build_rope_tables(cfg.max_seq_len, cfg.head_dim, cfg.rope_theta)

    def forward(self, ids, capture=None):
        cfg = self.cfg
        T = len(ids); h = cfg.n_head; kv = cfg.n_kv_head; hd = cfg.head_dim
        qemb, memb = self.W["emb"]
        # 嵌入：q*M 后移位回残差流定点
        x = rshift_round(qemb[ids].astype(np.int64) * memb[ids][:, None].astype(np.int64),
                         W_SHIFT - RES_FRAC)
        if capture is not None:
            capture["emb"] = x.copy()
        for i in range(cfg.n_layer):
            n1 = rmsnorm(x, self.G[f"blocks.{i}.norm1"])
            q = linear_from_q(*quant_act(n1), *self.W[f"blocks.{i}.q"])
            k = linear_from_q(*quant_act(n1), *self.W[f"blocks.{i}.k"])
            v = linear_from_q(*quant_act(n1), *self.W[f"blocks.{i}.v"])
            q = rope_apply(q.reshape(T, h, hd).astype(np.int64), self.COS, self.SIN, ROPE_FRAC)
            k = rope_apply(k.reshape(T, kv, hd).astype(np.int64), self.COS, self.SIN, ROPE_FRAC)
            k = np.repeat(k, h // kv, axis=1)
            vv = np.repeat(v.reshape(T, kv, hd).astype(np.int64), h // kv, axis=1)
            sc = attn_scores(np.transpose(q, (1, 0, 2)), np.transpose(k, (1, 0, 2)), hd)
            mask = np.triu(np.ones((T, T), dtype=bool), 1)
            sc = np.where(mask[None, :, :], np.int64(-(1 << 40)), sc)
            p = softmax_lut(sc, self.EXP_LUT)
            at = attn_pv(p.astype(np.int64), np.transpose(vv, (1, 0, 2)))
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
        logits = linear_from_q(*quant_act(xf), *self.W["emb"])
        if capture is not None:
            capture["final_norm"] = xf.copy()
        return logits


def main():
    ckpt = os.path.join(HERE, "model.pt")
    tok = Tokenizer.from_file(os.path.join(HERE, "tokenizer.json"))
    M = IntModel(ckpt)
    print(f"模型: {M.cfg.n_layer}层 d={M.cfg.d_model} vocab={M.cfg.vocab_size}  "
          f"params={sum(v.numel() for v in M.sd.values()):,}")

    prompts = [
        "飞船缓缓降落在荒芜的星球表面",
        "没有人回答。舱内只剩下",
        "“你确定要这么做吗？”她问。",
    ]
    print(f"\n{'prompt':26s} {'T':>3s} {'maxErr':>8s} {'meanErr':>8s} {'top64':>7s} {'top1':>6s}")
    for p in prompts:
        ids = tok.encode(p).ids
        with torch.no_grad():
            tl = M.torch_model(torch.tensor([ids]))[0][0, -1].float().numpy()
        il = M.forward(ids)[-1].astype(np.float64) / (1 << RES_FRAC)
        tt = set(np.argsort(-tl)[:64].tolist())
        ii = set(np.argsort(-il)[:64].tolist())
        print(f"{p[:24]!r:26s} {len(ids):3d} {np.abs(tl-il).max():8.4f} "
              f"{np.abs(tl-il).mean():8.4f} {len(tt & ii):5d}/64 "
              f"{'OK' if int(np.argmax(tl)) == int(np.argmax(il)) else 'DIFF':>6s}")

    # 逐层中间量误差（取第一个 prompt）
    ids = tok.encode(prompts[0]).ids
    cap = {}
    M.forward(ids, capture=cap)
    with torch.no_grad():
        M.torch_model(torch.tensor([ids]))
    print("\n逐层中间量（整数 vs fp32，换算回真实量纲的最大绝对误差）:")
    print(f"  {'emb':22s} {np.abs(cap['emb']).max()/(1<<RES_FRAC):10.4f}  (残差流量级参考)")
    for i in range(M.cfg.n_layer):
        a = cap[f"blk{i}.attn_out"] / (1 << RES_FRAC)
        b = cap[f"blk{i}.out"] / (1 << RES_FRAC)
        print(f"  blk{i} attn_out max|.| = {np.abs(a).max():9.3f}   "
              f"block_out max|.| = {np.abs(b).max():9.3f}")


if __name__ == "__main__":
    main()

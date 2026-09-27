#!/usr/bin/env python3
"""
int_ref.py — pcd-v3-6M 全整数定点前向参考实现（GOLDEN REFERENCE）

本文件是客户端 JS/WASM 内核的**唯一黄金参考规范**。
客户端不是"照抄 torch"，而是"照抄本文件的整数算术"。
本文件在推理路径上【零浮点算子】：
    全部为 int32/int64 的加、减、乘、算术右移、查表、整数开方。

================================================================================
一、数值格式（写死，不可改）
================================================================================
权重 W  (2D, shape [out, in])
    逐【输出行】量化，每行一个整数 scale 对 (M, S)：
        真实值  W[i][k] ≈ q[i][k] * M[i] / 2^S
        q : int8  [-127,127]；M : int32 [1,2^31)；S : int32，全局 W_SHIFT=20
    M/2^S 是任意有理数 -> 本格式**没有 float32 scale**，且不像 power-of-two
    那样损失精度（实测 pow2 使权重相对误差从 0.54% 恶化到 17.1%，top-64 掉 16 位）。

激活 X  (2D [T, d])
    逐【token】动态量化：真实值 X[t][k] ≈ qx[t][k] / 2^s_x[t]
        qx : int8；s_x : int32，运行时由该行 absmax 求出（纯整数）

残差流  int32，全局定点 2^-RES_FRAC，RES_FRAC = 12

矩阵乘
        acc[j]   = Σ_k q_w[j][k] * q_x[k]              (int32 累加)
        y_i32[j] = rshift_round(acc[j] * M[j], W_SHIFT - s_x)
    INT8×INT8 累加上界 = K·127·127；K=768 时为 1.24e7，INT32 上限 2.1e9，
    安全余量 173 倍。acc*M 需 int64 中间量（见 mul32x32_to64 的 JS 拆分写法）。

LUT  EXP_LUT/SIG_LUT 由导出期生成并冻结进资产；运行时**只查表，不重算**。
     EXP_LUT : int32[8192]  e^u,        u ∈ [-16, 0]，定点 2^-15
     SIG_LUT : int32[8192]  sigmoid(u), u ∈ [-16,16]，定点 2^-15

================================================================================
二、四条铁律
================================================================================
1. 舍入一律 rshift_round：算术右移 + 半值远离零（round-half-away-from-zero）。
   纯位运算，规避 np.round(banker's rounding) 与 JS Math.round 的分歧。
2. 一切除法都是"移位 + 显式 bias"或"非负整数整除"，禁止浮点除法。
3. 一切比较/排序都在 int32/int64 上做，不经浮点中间量。
4. 四个定点近似算子（isqrt / rope / softmax / sigmoid）以本文件为准。

================================================================================
三、三个曾经踩过的坑（客户端实现时请重点复核）
================================================================================
[A] attention score 的移位必须含 RES_FRAC
    score 由两层 2^-RES_FRAC 的量相乘再求和，若漏掉 RES_FRAC，
    score 会放大 4096 倍，softmax 退化为 one-hot（实测 top-64 只剩 5/64）。
[B] P·V 的移位必须含 RES_FRAC
    p 与 v 各带一个 2^-RES_FRAC，乘积在 2^-(2·RES_FRAC)，必须右移补回；
    否则残差流每层放大 4096 倍。
[C] RMSNorm 必须先开方再整除
    写成 isqrt((1<<2F)//msq) 是错的：msq 较大时该商为 0，inv 归零、整网输出全 0。
    正确写法 inv = (1<<F) // isqrt(msq)。
"""
from __future__ import annotations

import numpy as np

# ------------------------------------------------------------------ 全局常量
RES_FRAC = 12       # 残差流定点：真实值 = x / 2^12
W_SHIFT = 20        # 权重 scale 分母：W ≈ q * M / 2^20
NORM_FRAC = 12      # RMSNorm 权重定点：g ≈ gq / 2^12
INV_FRAC = 30       # 1/sqrt(msq) 定点（30 位对 msq∈[1,2^60] 均安全，见坑 [C]）
LUT_FRAC = 15       # LUT 值定点
EXP_LUT_N = 8192
EXP_LUT_MAX = 16.0
SIG_LUT_N = 8192
SIG_LUT_MAX = 16.0
Q_MAX = 127
ROPE_FRAC = 14      # RoPE cos/sin 定点
SCORE_INV_FRAC = 16 # 1/sqrt(head_dim) 定点


# ============================================================ 1. 整数原语
def rshift_round(x, s):
    """算术右移 + 半值远离零。x: int(64), s: int>=0。唯一的舍入方式。

    JS 等价实现：
        function rshiftRound(x, s) {
          if (s === 0) return x;
          var b = 1 << (s - 1);
          return x >= 0 ? (x + b) >> s : -((-x + b) >> s);
        }
    JS 的 >> 为算术右移（符号扩展），与 Python 对负数的 >> 语义一致。
    """
    x = np.asarray(x, dtype=np.int64)
    s = np.asarray(s, dtype=np.int64)
    if s.ndim == 0:
        s = int(s)
        if s == 0:
            return x
        if s < 0:
            return x << np.int64(-s)
        b = np.int64(1) << np.int64(s - 1)
        return np.where(x >= 0, (x + b) >> np.int64(s), -((-x + b) >> np.int64(s)))
    s = np.broadcast_to(s, x.shape)
    b = np.left_shift(np.int64(1), s - np.int64(1))
    out = np.where(x >= 0, (x + b) >> s, -((-x + b) >> s))
    return np.where(s == 0, x, out)


def isqrt_i64(n):
    """整数平方根 floor(sqrt(n))，n>=0。逐位恢复法，纯整数，无浮点。"""
    n = np.asarray(n, dtype=np.int64).copy()
    res = np.zeros_like(n)
    bit = np.int64(1) << np.int64(62)
    while bit > 0:
        sel = n >= (res + bit)
        n = np.where(sel, n - (res + bit), n)
        res = np.where(sel, (res >> np.int64(1)) + bit, res >> np.int64(1))
        bit >>= np.int64(2)
    return res


def mul32x32_to64(a, b):
    """int32 × int32 -> int64。供 JS 无 BigInt / WASM 无 i64.mul 时照抄：

        const lo = (a & 0xFFFF) * b;        // 低 16 位 × b
        const hi = (a >>> 16) * b;          // 高 16 位 × b
        const result = (hi << 16) + lo;     // 结果落在 int64 语义
    Python 侧直接返回 int64 乘积，此处仅声明语义。
    """
    return np.asarray(a, dtype=np.int64) * np.asarray(b, dtype=np.int64)


def bitlen(x):
    """floor(log2(x)) + 1，x>0。纯整数（6 次比较）。"""
    x = np.asarray(x, dtype=np.int64)
    r = np.zeros_like(x)
    for k in (32, 16, 8, 4, 2, 1):
        m = (x >> np.int64(k)) > 0
        r = np.where(m, r + k, r)
        x = np.where(m, x >> np.int64(k), x)
    return r + (x > 0).astype(np.int64)


# ============================================================ 2. LUT（导出期）
def build_luts():
    """生成 EXP_LUT / SIG_LUT。导出期调用一次，结果冻结进资产。

    运行时**不得重算**，必须读资产，以保证逐 bit 一致。
    """
    exp_lut = np.empty(EXP_LUT_N, dtype=np.int32)
    for i in range(EXP_LUT_N):
        u = -EXP_LUT_MAX * i / (EXP_LUT_N - 1)
        exp_lut[i] = int(np.floor(np.exp(u) * (1 << LUT_FRAC) + 0.5))
    sig_lut = np.empty(SIG_LUT_N, dtype=np.int32)
    for i in range(SIG_LUT_N):
        u = -SIG_LUT_MAX + 2.0 * SIG_LUT_MAX * i / (SIG_LUT_N - 1)
        sig_lut[i] = int(np.floor((1.0 / (1.0 + np.exp(-u))) * (1 << LUT_FRAC) + 0.5))
    return exp_lut, sig_lut


def build_rope_tables(max_len, head_dim, theta, rope_frac=ROPE_FRAC):
    """导出期生成定点 cos/sin 表（2^-rope_frac）。运行时只查表。"""
    half = head_dim // 2
    inv = 1.0 / (theta ** (np.arange(0, head_dim, 2, dtype=np.float64) / head_dim))
    t = np.arange(max_len, dtype=np.float64)
    fr = np.outer(t, inv)
    scale = float(1 << rope_frac)
    cos_q = np.floor(np.cos(fr) * scale + 0.5).astype(np.int32)
    sin_q = np.floor(np.sin(fr) * scale + 0.5).astype(np.int32)
    return cos_q, sin_q


# ============================================================ 3. 量化
def quant_act(x_i32):
    """激活量化：int32 定点(2^-RES_FRAC) -> (int8 行, 每行 shift)。

    返回 (q int8 [T,K], s int64 [T])，或 1D 输入时的 (q int8 [K], s int)。
    s 为满足 |q|<=127 的最小非负整数。纯整数。
    """
    x = np.asarray(x_i32, dtype=np.int64)
    single = (x.ndim == 1)
    if single:
        x = x[None, :]
    a = np.abs(x).max(axis=1)
    s = np.maximum(bitlen(np.maximum(a, 1)) - 7, 0)
    while True:                                  # 位长只是估计，逐次校正
        over = (a >> s) > Q_MAX
        if not over.any():
            break
        s = np.where(over, s + 1, s)
    q = np.clip(rshift_round(x, s[:, None]), -Q_MAX, Q_MAX).astype(np.int8)
    if single:
        return q[0], int(s[0])
    return q, s


# ============================================================ 4. 基础算子
def linear(x_i32, qw, mw, sw=W_SHIFT, out_frac=RES_FRAC):
    """整数矩阵乘 y = x @ W^T（含激活量化）。

    x_i32 : int32 [T,in] 2^-RES_FRAC ; qw : int8 [out,in]
    mw    : int32 [out] 每行 scale 分子 ; sw : int 全局 W_SHIFT
    返回  : int64 [T,out] 定点 2^-out_frac
    """
    x = np.asarray(x_i32, dtype=np.int64)
    single = (x.ndim == 1)
    if single:
        x = x[None, :]
    qx, sx = quant_act(x)
    return linear_from_q(qx, sx, qw, mw, sw, out_frac) if not single else \
        linear_from_q(qx, sx, qw, mw, sw, out_frac)[0]


def linear_from_q(qx, sx, qw, mw, sw=W_SHIFT, out_frac=RES_FRAC):
    """已量化激活版本。qx:[T,in] int8, sx:[T] int。"""
    acc = qx.astype(np.int64) @ qw.astype(np.int64).T          # int64（语义 int32）
    shift = (sw - np.asarray(sx, dtype=np.int64)[:, None]) + (RES_FRAC - out_frac)
    return rshift_round(acc * np.asarray(mw, dtype=np.int64)[None, :], shift)


def rmsnorm(x_i32, gq, inv_frac=INV_FRAC):
    """整数 RMSNorm。x:[T,d] 2^-RES_FRAC ; gq:[d] 2^-NORM_FRAC。

    real_out = x / sqrt(mean(x^2)) * g。四步纯整数：
      1) ss  = Σ x^2                          (int64)
      2) msq = ss // d
      3) s = isqrt(msq) ; inv = (1<<inv_frac) // s      # ≈ 2^inv_frac/sqrt(msq)
      4) out = rshift_round(x * inv * gq, inv_frac + NORM_FRAC - RES_FRAC)

    ⚠ 坑 [C]：不要写成 isqrt((1<<2F)//msq)，msq 大时商为 0 -> inv=0 -> 输出全 0。
    """
    x = np.asarray(x_i32, dtype=np.int64)
    single = (x.ndim == 1)
    if single:
        x = x[None, :]
    d = x.shape[1]
    ss = (x * x).sum(axis=1)
    msq = np.maximum(ss // d, 1)
    s = np.maximum(isqrt_i64(msq), 1)
    inv = (np.int64(1) << np.int64(inv_frac)) // s
    num = x * inv[:, None] * gq[None, :].astype(np.int64)
    out = rshift_round(num, inv_frac + NORM_FRAC - RES_FRAC)
    return out[0] if single else out


def silu_lut(x_i32, sig_lut):
    """整数 SiLU：x * sigmoid(x)。x:[..,d] 2^-RES_FRAC。查表 + 定点乘。"""
    x = np.asarray(x_i32, dtype=np.int64)
    span = int(SIG_LUT_MAX * (1 << RES_FRAC))                 # 16*4096 = 65536
    idx = ((x + span) * (SIG_LUT_N - 1)) // (2 * span)
    idx = np.clip(idx, 0, SIG_LUT_N - 1).astype(np.int64)
    sig = sig_lut[idx].astype(np.int64)                       # 2^-LUT_FRAC
    return rshift_round(x * sig, LUT_FRAC)


def softmax_lut(scores_i32, exp_lut, out_frac=RES_FRAC):
    """整数 softmax。scores:[..,S] 定点; 返回同形 int64 定点 2^-out_frac。

      1) m = max_j scores                    (int32)
      2) d = scores - m <= 0
      3) idx = (-d)*(N-1) // (EXP_LUT_MAX*2^RES_FRAC)
      4) e = EXP_LUT[idx]                    (2^-LUT_FRAC)
      5) p_j = (e_j << out_frac) // Σ_j e_j   （非负整数逐元素整除，确定性）
    """
    s = np.asarray(scores_i32, dtype=np.int64)
    m = s.max(axis=-1, keepdims=True)
    d = s - m
    span = int(EXP_LUT_MAX * (1 << RES_FRAC))
    idx = np.clip(((-d) * (EXP_LUT_N - 1)) // span, 0, EXP_LUT_N - 1).astype(np.int64)
    e = exp_lut[idx].astype(np.int64)
    S = np.maximum(e.sum(axis=-1, keepdims=True), 1)
    return (e << np.int64(out_frac)) // S


def rope_apply(x, cos_q, sin_q, rope_frac=ROPE_FRAC):
    """整数 RoPE（chunk-half，与训练一致）。x:[T,H,D] int64 2^-RES_FRAC。

        x1,x2 = x[...,:half], x[...,half:]
        out   = [x1*c - x2*s, x2*c + x1*s] >> rope_frac
    """
    half = x.shape[-1] // 2
    T = x.shape[0]
    c = cos_q[:T][:, None, :].astype(np.int64)
    s = sin_q[:T][:, None, :].astype(np.int64)
    x1, x2 = x[..., :half].astype(np.int64), x[..., half:].astype(np.int64)
    o1 = rshift_round(x1 * c - x2 * s, rope_frac)
    o2 = rshift_round(x2 * c + x1 * s, rope_frac)
    return np.concatenate([o1, o2], axis=-1)


# ============================================================ 5. 注意力
def attn_scores(q_int, k_int, head_dim, inv_frac=SCORE_INV_FRAC):
    """整数注意力打分（含 1/sqrt(D)）。q,k:[H,T,D] int64 2^-RES_FRAC。

    推导（勿改）：
        score_real = Σ_d q_real·k_real / sqrt(D)
                   = Σ_d q_int·k_int / (2^(2·RES_FRAC)·sqrt(D))
        score_int  = score_real·2^RES_FRAC
                   = acc / (2^RES_FRAC · sqrt(D))
                   = rshift_round(acc · NUM, RES_FRAC + inv_frac)
        其中 NUM = round(2^inv_frac / sqrt(D))，acc = Σ q_int·k_int
    ⚠ 坑 [A]：移位量必须含 RES_FRAC，否则 score 放大 4096 倍 -> softmax 变 one-hot。
    """
    acc = np.einsum('htd,hsd->hts', q_int, k_int)
    num = int(round((1.0 / np.sqrt(head_dim)) * (1 << inv_frac)))
    return rshift_round(acc * np.int64(num), RES_FRAC + inv_frac)


def attn_pv(p_int, v_int, out_frac=RES_FRAC):
    """整数 P·V。p:[H,T,S] 2^-RES_FRAC(行和=2^RES_FRAC) ; v:[H,S,D] 2^-RES_FRAC。

    ⚠ 坑 [B]：p 与 v 各带一个 2^-RES_FRAC，乘积在 2^-(2·RES_FRAC)，
      必须右移 RES_FRAC 补回，否则残差流每层放大 4096 倍。
    """
    acc = np.einsum('hts,hsd->htd', p_int, v_int)
    return rshift_round(acc, RES_FRAC + (RES_FRAC - out_frac))


if __name__ == "__main__":
    e, s = build_luts()
    assert e[0] == (1 << LUT_FRAC), e[0]
    assert abs(int(s[-1]) - (1 << LUT_FRAC)) <= 1, s[-1]
    # 坑 [C] 回归：大 msq 下 rmsnorm 不得归零
    for mag in (100, 7283, 5_644_116, 1 << 24):
        x = np.full((1, 288), mag, dtype=np.int64)
        g = np.full(288, 1 << NORM_FRAC, dtype=np.int64)
        v = rmsnorm(x, g)[0, 0] / (1 << RES_FRAC)
        assert v > 0.9, (mag, v)
    # 坑 [B] 回归：P·V 缩放
    p = np.zeros((1, 2, 2), dtype=np.int64); p[:, :, 0] = 1 << RES_FRAC
    v = np.full((1, 2, 4), 2867, dtype=np.int64)          # 真实 ≈ 0.7
    assert abs(attn_pv(p, v)[0, 0, 0] / (1 << RES_FRAC) - 0.7) < 0.01
    print("int_ref 自检通过：LUT / rmsnorm / attn_pv 全部 OK")

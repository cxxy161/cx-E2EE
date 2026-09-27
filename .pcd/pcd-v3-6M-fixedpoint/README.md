# pcd-v3-6M 定点推理资产（全整数 / 零浮点运行时）

本包供**加密端隐写编解码器**使用：客户端（浏览器 JS / WASM SIMD，纯 CPU）只需
本包二进制 + `int_ref.py` 的整数算术，即可完成**逐 bit 可复现**的前向推演。

**运行时不使用任何浮点算子。** 全部为 int32/int64 加减乘、算术右移、查表、整数开方。

---

## 1. 交付物

```
pcd-v3-6M-fixedpoint/
├── README.md          # 本文件
├── int_ref.py         # ★ 唯一黄金参考规范（整数算术，客户端照抄这个）
├── load_fixed.py      # 从二进制资产重建模型的参考加载器
├── export_fixed.py    # 从 fp32 ckpt 重新导出资产（可复现）
├── gen_golden.py      # 重新生成 Golden Vectors（可复现）
├── verify_int.py      # 开发期精度对照（依赖 torch，交付后可不带）
├── model/             # 定点模型资产
│   ├── weights.bin    # int8 权重 + 逐行 int32 M     6.26 MiB
│   ├── norm.bin       # RMSNorm 权重（int32）        14.6 KiB
│   ├── tables.bin     # EXP/SIG LUT + RoPE cos/sin 160.0 KiB
│   ├── vocab.bin      # 词表（索引 + UTF-8 字节流）  25.9 KiB
│   └── format.json    # 资产清单（张量字典/偏移/常量）
└── golden/            # 校验集
    ├── golden.json    # 3 组 prompt + 层哈希 + Top-64
    └── golden.bin     # 3×4096 个 int32 logits
```

合计约 **6.47 MiB**。权重本身 **6.26 MiB**（6,488,064 个 int8 = 6.19 MiB
+ 202,752 个逐 block int32 M = 0.77 MiB）。

---

## 2. 数值格式

### 权重
逐**输出行**量化，每行一对 `(M, S)`：

```
W[i][k] ≈ q[i][k] * M[i] / 2^S
    q : int8  [-127,127]
    M : int32 [1, 2^31)      每行一个
    S : int32  全局 W_SHIFT = 20
```

`M/2^S` 是**任意有理数**。因此本格式：

- **没有 float32 scale** —— 满足"消灭浮点 scale"的要求；
- **不受 power-of-two 限制** —— 这点很关键，实测对比：

| 方案 | 权重相对 RMS 误差 | val_loss | top-64 重合 |
|---|---|---|---|
| 任意 scale（本方案 M/2^S） | **0.54 ~ 0.75%** | 4.0039 | 62/64 |
| power-of-two 纯移位 | 17.1% | 4.1818 | 46/64 |

power-of-two 的误差是本方案的 **17~32 倍**（`attn.v_proj` 等层单层误差达 19%），
因为它只能表示 `2^-s`，块内 absmax 落位不佳时最多浪费一半动态范围。
对隐写编解码器而言 **top-64 排序稳定性就是命门**，故采用 M/2^S。

### 激活
逐 **token** 动态量化：

```
X[t][k] ≈ qx[t][k] / 2^s_x[t]
    qx  : int8     s_x : int32（该行 absmax 决定，纯整数求出）
```

### 残差流
`int32`，全局定点 `2^-RES_FRAC`，`RES_FRAC = 12`。

### 矩阵乘
```
acc[j]   = Σ_k q_w[j][k] * q_x[k]        # int32 累加
y_i32[j] = rshift_round(acc[j] * M[j], W_SHIFT - s_x)
```
`INT8×INT8` 累加上界 = `K·127·127`；`K=768` 时 = **1.24e7**，INT32 上限 **2.1e9**，
**安全余量 173 倍，绝不溢出**。`acc * M` 需 int64 中间量，JS 无 BigInt 时用：

```js
const lo = (acc & 0xFFFF) * M;
const hi = (acc >>> 16) * M;
const result = (hi << 16) + lo;        // int64 语义
```

---

## 3. 铁律

1. **舍入唯一用 `rshift_round`**：算术右移 + 半值远离零（纯位运算），
   规避 `np.round`（banker's rounding）与 JS `Math.round` 的分歧。
   ```js
   function rshiftRound(x, s) {
     if (s === 0) return x;
     const b = 1 << (s - 1);
     return x >= 0 ? (x + b) >> s : -((-x + b) >> s);
   }
   ```
2. 一切除法都是"**移位 + 显式 bias**"或"非负整数整除"，禁止浮点除法。
3. 一切比较/排序在 int32/int64 上做，**不经浮点中间量**。
4. 四个定点近似算子（`isqrt` / `rope` / `softmax` / `sigmoid`）以 `int_ref.py` 为准。

---

## 4. 四个定点近似算子

| 算子 | 用途 | 实现要点 |
|---|---|---|
| `isqrt_i64` | RMSNorm 的 `1/sqrt(msq)` | 逐位恢复法，31 次迭代，纯整数 |
| `rope_apply` | 位置编码旋转 | 导出期预计算 int32 cos/sin 表，运行时整数旋转 |
| `softmax_lut` | 注意力归一化 | max 减除 → EXP_LUT 查表 → 非负整数整除 |
| `silu_lut` | SwiGLU 门控 | SIG_LUT 查表 + 定点乘 |

`softmax` **无法"消灭"，只能整数近似** —— 注意力必须归一化。但它现在是
**完全确定性**的：查表 + 整数除法，无 exp()、无除法浮点。

### RMSNorm 的正确写法（有坑，见下）
```
1) ss  = Σ x²                    (int64)
2) msq = ss // d
3) s   = isqrt(msq)
   inv = (1 << INV_FRAC) // s     # INV_FRAC = 30
4) out = rshift_round(x * inv * g, INV_FRAC + NORM_FRAC - RES_FRAC)
```

---

## 5. ⚠️ 三个已修复的实现陷阱（客户端务必复核）

发明这三处都是"静默错误"——不报错、loss 看似正常，但输出全错。已在
`int_ref.py` 修正并写成回归自检（`python int_ref.py`）。

### [A] attention score 的移位必须含 `RES_FRAC`
`q`、`k` 各带 `2^-RES_FRAC`，乘积在 `2^-(2·RES_FRAC)`。评分时：
```
score_int = rshift_round(acc * NUM, RES_FRAC + inv_frac)
                                    ^^^^^^^^^ 漏掉这项 → score 放大 4096 倍
```
漏掉会让 softmax 退化为 one-hot（实测 top-64 只剩 **5/64**）。

### [B] P·V 的移位必须含 `RES_FRAC`
```
attn = rshift_round(Σ p·v, RES_FRAC + (RES_FRAC - out_frac))
```
漏掉 → 残差流每层放大 4096 倍，第 2 层起彻底崩坏。

### [C] RMSNorm 必须先开方再整除
```python
# ❌ 错：msq 大时 (1<<2F)//msq == 0 → inv=0 → 整网输出全 0
inv = isqrt((1 << 2*F) // msq)
# ✅ 对：量的量级温和得多
inv = (1 << F) // isqrt(msq)
```

> 另注：Pre-norm 架构为 `x = x + attn(norm1(x))`，`x = x + ffn(norm2(x))`。
> **attn 与 ffn 用的是两个不同的 norm 权重**（`norm1` / `norm2`），不可混用。

---

## 6. 词表格式（`vocab.bin`）

紧凑二进制，共 25,874 字节：

```
偏移 0                 : 4096 × uint16 小端 = 8192 字节（索引表）
偏移 8192              : UTF-8 字节流，18,362 字节
token i 的字节 = stream[ offset[i] : offset[i+1] ]
最后一个 token 的结束位置 = format.json 的 vocab.stream_bytes
```

### 关于"字符级 1:1"的说明

本模型用的是 **ByteLevel BPE 词表**，token 与汉字**不是 1:1**：

- 单字符 token：2,270 个
- 多字符 token：1,824 个（平均 6.46 字节，最长 15 字节，如 `。”`、`我们`、`没有`）
- **非合法 UTF-8 的部分字节 token：456 个（11.1%）**

最后一项对你的解码端**很重要**：这 456 个 token 是 BPE 的"半个汉字"字节片段，
**单独解码会得到 `\ufffd` 替换字符**，必须与相邻 token 拼接后才成为合法汉字。
Golden Vectors 的 Top-64 里就出现了 5 处（p1 有 2 处、p3 有 3 处）。

**建议**：解码端做前缀匹配时，应把 token 当**字节串**处理并允许跨 token 拼接，
不要在单 token 粒度上做 UTF-8 校验。若某个 token 单独看不合法，跳过它继续试
下一个候选即可（这正是 `p3` 场景下 rank 7 的处理方式）。

客户端**不需要运行 BPE**：只需 `id → bytes` 查表，全程确定性。

---

## 7. Golden Vectors

`golden.json` 含 3 组固定 prompt：

| id | prompt | T | top-1 | top-64 |
|---|---|---|---|---|
| `p1_narrative` | `飞船缓缓降落在荒芜的星球表面` | 10 | 260 | 468 |
| `p2_dialogue` | `“你确定要这么做吗？”她问。` | 10 | 200 | 731 |
| `p3_log` | `终端日志：SYS-0x7F 冷却液压力 12.4kPa 状态=警告` | 31 | 276 | 3790 |

每组包含：

- `prompt_ids` —— 输入 token id 序列
- `prompt_bytes_utf8` —— 输入字节（便于客户端自检编码）
- `layer_hashes` —— **20 个** FNV-1a 64 哈希：
  `emb`、`blk0..5.attn_out`、`blk0..5.out`、`final_norm`、`logits_last`
- `top64` —— 64 条 `{rank, token_id, score_i32}`，**int32 原始分数**（未归一化）
- `golden.bin` —— 每组 4096 个 int32 logits，便于二分定位

### 哈希算法：FNV-1a 64

```
h = 0xcbf29ce484222325
for byte in data:  h ^= byte;  h = (h * 0x100000001b3) mod 2^64
data = 张量按 C 序转 int32 小端字节流
```

```js
function fnv1a64(bytes) {                 // bytes: Uint8Array
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n, m = (1n << 64n) - 1n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * p) & m; }
  return h;                               // 输出 16 位小写 hex
}
```

⚠️ 必须**先转 int32 小端字节流再逐字节哈希**，不要对 Python 整数直接哈希
（字节序与符号扩展会不一致）。

### 排序规则
Top-64 按 `score_i32` **降序**；**同分以 `token_id` 升序决胜**（确定性并列规则）。

---

## 8. 对齐步骤（客户端）

1. 读 `format.json`，按 `tensors[]` 的 `q_offset/m_offset` 切 `weights.bin`
2. 读 `norm.bin` / `tables.bin`（偏移见 `format.json`）
3. 用 `int_ref.py` 的整数算法实现内核（**逐个算子照抄，包括移位量**）
4. 跑 `golden.json` 的 3 组 prompt，逐层比对 `layer_hashes`
5. 若某层哈希不符，用 `golden.bin` 的同层输出二分定位
6. 最终比对 `top64` 的 64 个 token id 与 int32 分数

**建议按层比对**：先确保 `emb` 一致，再逐层推进。第一层不符就必然是
嵌入/量化/shift 语义问题；中层不符则是注意力或 FFN 的定点算子问题。

---

## 9. 精度实测

整数前向 vs torch fp32（同权重、同输入）：

| prompt | 最大 logit 误差 | 平均误差 | Top-64 重合 | Top-1 |
|---|---|---|---|---|
| `飞船缓缓降落在荒芜的星球表面` | 0.385 | 0.075 | **61/64** | ✅ 一致 |
| `没有人回答。舱内只剩下` | 0.458 | 0.100 | **62/64** | ✅ 一致 |
| `“你确定要这么做吗？”她问。` | 0.299 | 0.067 | **61/64** | ✅ 一致 |

误差来源分解（教师强制逐算子）：

| 来源 | 相对误差 |
|---|---|
| 权重量化（int8，M/2^S） | 0.69 ~ 0.75% |
| 激活量化（int8，逐 token） | 1.07 ~ 3.14% |
| 定点算子近似（isqrt/LUT/RoPE） | 单算子 ≤ 0.5% |

主要误差来自 **int8 激活量化**，且随层数累积（残差流量级从 0.34 增至 73）。
若需更小的偏差，可升级为：激活逐 `head`/逐 `block` 移位，或激活 INT16。
当前 top-64 重合 61~62/64、top-1 全对，对隐写编解码器已足够。

---

## 10. 复现

```bash
# 需要 torch（仅导出期使用；客户端不需要）
python export_fixed.py     # -> model/*.bin + format.json
python gen_golden.py       # -> golden/golden.json + golden.bin
python int_ref.py          # 回归自检（3 个陷阱）
python verify_int.py       # 与 fp32 的精度对照
```

模型来源：pcd-v3-6M，6,491,808 参数，vocab=4096，6 层 / d=288 / 6 头 / GQA 3:1 /
SwiGLU(768) / RoPE / RMSNorm / 权重绑定，训练 7,916 步（10 epochs，val_loss 3.9097）。

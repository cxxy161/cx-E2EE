# pcd-v3-6M 资产接入笔记（实测）

> 源包：`pcd-v3-6M-fixedpoint.zip`（工作区根目录）
> 解包位置：`.pcd/pcd-v3-6M-fixedpoint/`（**待定：是否入库，见文末**）

## 一、已验证通过的部分

| 项 | 结果 |
|---|---|
| 词表 4096 条、索引 8192B + 流 18362B = 26554B | ✓ 与 format.json 完全一致，无越界/丢字节 |
| `int_ref.py` 自检 | ✓ 通过 |
| golden 排序规则（分数降序 / token_id 升序决胜） | ✓ 3/3 组复现，含 score_i32 |
| **JS 内核全层哈希** | **✓ 45/45**（3 组 × 15 层） |
| **JS 内核 top-64** | **✓ 3/3 完全一致**（token id 与 int32 分数） |

JS 内核见 `test/stego/js-kernel.mjs`，验证见 `test/stego/js-kernel-align.test.mjs`。

## 二、README 的三处错误（已实测反例，JS 实现按正确版本）

### [1] §3 的 JS `rshiftRound` 是错的 —— 会静默毁掉整网
```js
return x >= 0 ? (x + b) >> s : -((-x + b) >> s);   // ✗
```
JS 的 `>>` 先做 ToInt32，而本模型中间量最大 **≈2^45.7**
（实测 rmsnorm 的 `num` = 55574230881045）。
一进 `>>` 就被截成低 32 位：

```
rshiftRound(55574230881045, 28)
  README 版 = 6          正确版 = 207030       ← 差 3.4 万倍
rshiftRound(67274188032, 16)
  README 版 = -22053     正确版 = 1026523
```
小量级下两版一致，**所以只在小张量上测不出来**。

正确实现（零浮点、2 的幂除法）：
```js
function rshiftRound(x, s) {
  if (s === 0) return x;
  const b = Math.pow(2, s-1), d = Math.pow(2, s);
  return x >= 0 ? Math.floor((x+b)/d) : -Math.floor((-x+b)/d);
}
```
**为什么可以放心用 double**：实测全网络中间量上界 2^45.7 < 2^53，
而除以 2^s 在 IEEE754 下只是指数减 s，**精确无舍入**。

### [2] §2 的 `(hi<<16)+lo` int64 拆分同样错，而且根本不需要
```
acc=12387072, M=5431
  (hi<<16)+lo  = -1445288704     ← 32 位截断
  真值         = 67274188032
```
实测最坏 `acc*M = 6.73e10 ≈ 2^36`（张量 `blocks.5.down`），
**远在 2^53 内，直接 `acc*M` 即精确**。引入 BigInt 或手工拆分反而引入 bug。

### [3] §6「456 个 token 是非法的局部 UTF-8 字节（半个汉字）」是术语误述
实测这 456 个 token 的字节是字面 **`EF BF BD`（U+FFFD 替换字符）**，
**本身是完全合法的 UTF-8**。

```
以续接字节(0x80-0xBF)开头的 token（真·半个汉字）: 0
fatal 解码抛错的 token（真·不完整序列）        : 0
含字面 EF BF BD 的 token                       : 456   ← README 的数字对，解释错
  其中纯 3 字节 EF BF BD                       : 416   ← 这 416 个 id 字节【完全相同】
```

数字对得上，但**危害机制完全不同**。真实危害是两条：
- (a) `U+FFFD` 是语义垃圾，绝不能出现在伪装文本里；
- (b) **416 个 id 字节完全相同** → 若候选集不做去重/前缀判定，
  64 名里会塞满同一个字节串，解码端命中不唯一 ⇒ 直接雪崩。

因此候选管线必须以**字节**判定，规则是「含 U+FFFD 即拒 + 逐对去重」，
而不是 README 说的"跳过不合法的继续试下一个"。

> 结论：**"严禁单 token 做 TextDecoder 校验"这条规程依然正确且必须遵守**，
> 但理由是"U+FFFD 污染 + 字节重复"，不是"半个汉字转出替换字符"。
> `vocab-real.mjs` 已按字节结构（首字节 E4–E9 + 两个续接字节）直接判定汉字，
> 全程零 TextDecoder。

## 三、性能：KV Cache 是硬需求，不是优化项

无 KV Cache（每步重算全历史）：

| 场景 | 实测 |
|---|---|
| 单步平均 | **98.5 ms** |
| 一帧 256 步（O(T²)） | **≈3227 秒 ≈ 54 分钟** |
| 一条 4 段消息 | **≈3.6 小时** ← 完全不可用 |

带 KV Cache（每步只算新 token，T=256 全序列一次前向 1637ms ⇒ 摊薄 ≈6.4ms/token）：

| 场景 | 预估 |
|---|---|
| 一帧 256 步 | **≈1.6 秒** |

**相差 2000 倍。** `IModelEngine.reset()/forward(lastId, state)` 那个
不透明 state 就是 KV Cache，必须真正实现，不能每步传全历史。

## 四、接 KV Cache 之后仍需处理

注意 `forward()` 现在接收的是**完整 id 序列**，而 UI 契约是
`forward(lastTokenId, state)`。二者需要 KV Cache 做桥接：
每步只前向新增 token，attention 对缓存中的 K/V 做全量点积。
这会改变 `attn` 的计算路径，**改完必须重跑 45/45 层哈希回归**，
确认与 golden 仍然逐 bit 一致（缓存是纯粹的等价变换，哈希不应变化）。

## 五、待决策：资产是否入库

- `weights.bin` **6.26 MiB**（单文件），整包 6.7 MiB。
- 当前 `test/` 已被 gitignore 规则放行 `test/stego/`，但资产在 `.pcd/`，**未被忽略**。
- 三个选项：
  1. 入库 `.pcd/`（+6.7MB 仓库体积，克隆变慢，但开箱即用）；
  2. 加入 `.gitignore`，仅本地保留，另建下载脚本（推荐：模型是二进制大件，
     且 `README §10` 表明可 `export_fixed.py` 复现）；
  3. 入库但剥离 `golden.bin`（49KB，可重生成）。
- **需要你定。**

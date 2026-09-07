# 单文件压缩与合并文档

## 概述

将多文件项目合并为单个 HTML 文件，并通过多层压缩手段减小体积，使其可双击直接打开（无服务器依赖）。

**最终成果**：`index.min.html` — 126.2 KB / 4 行（原始 157.0 KB / 1,813 行）

---

## 一、合并策略

### 1.1 多页 → 单页 Tab 架构

将 8 个独立 HTML 页面合并为一个文件，使用 Tab 切换：

```
┌─ <style>     合并全部 CSS（经典暗色 + PQ 浅色 + 图片 V3 三套主题）
├─ <nav>       8 个 Tab 按钮（onclick="showTab('sec-xxx')")
├─ <section>   8 个功能区（home / text / img / sig / sym / pq-text / pq-sig / pq-key）
├─ <script>    合并全部 JS
└─ </html>
```

### 1.2 JS 模块合并顺序

| 顺序 | 模块 | 说明 |
|------|------|------|
| 1 | Tab 路由 | `showTab()` 页面切换 |
| 2 | CryptoEngine | Web Crypto / 纯 JS 自动降级引擎 |
| 3 | PureJS | 纯 JS 加密降级库（SHA-256 / PBKDF2 / AES-GCM） |
| 4 | core.js | 工具函数（`$()` / `T()` / `CP()` / `TS()` / `Util`） |
| 5 | Directory | 经典通讯录 |
| 6 | TextCrypto | 文本加密（Curve25519 + AES-GCM） |
| 7 | SigDirectory + SigContacts | 签名通讯录 |
| 8 | EdDSA_Sign | 数字签名（EdDSA + Base64 隐写） |
| 9 | AES_Sym | 对称加密（AES-GCM + PBKDF2） |
| 10 | IA + MOB | 图片加密（V1/V2/V3 + 打码编辑器） |
| 11 | PQ_Utils | 后量子工具函数 |
| 12 | PQ_KEM_Contacts | 后量子通讯录 |
| 13 | PQ_TextContacts | 后量子信道通讯录 |
| 14 | PQ_TextCrypto | 后量子信道（ML-KEM-768） |
| 15 | PQ_DSA_Contacts | 后量子签名通讯录 |
| 16 | MLDSA_Sign | 后量子签名（ML-DSA-65） |
| 17 | PQ_KeyMgmt | 后量子密钥管理 |
| 18 | ml-kem768 IIFE | ML-KEM-768 库（window.ml_kem768） |
| 19 | ml-dsa65 IIFE | ML-DSA-65 库（window.ml_dsa65） |

### 1.3 PQ 库内联方式

原项目使用 ES Module `import()` 加载 PQ 库，但 `file://` 协议下 CORS 限制阻止动态导入。

解决方案：将 ES Module 包裹为 IIFE 并挂载到 `window`：

```javascript
// 原始（ES Module）
import { ml_kem768 } from './ml-kem.js';
export { ml_kem768 };

// 内联后（IIFE）
(function() {
  // ... 完整库代码 ...
  window.ml_kem768 = Ke;   // 暴露到全局
})();
```

⚠️ **关键修复**：原始 IIFE 尾部残留 `export{...}` 语句（ES Module 语法），在普通 `<script>` 中会导致整个脚本解析失败。必须删除所有 `export` 语句。

### 1.4 CSS 变量隔离

三套主题通过 CSS 变量实现，互不干扰：

| 主题 | 选择器 | 触发条件 |
|------|--------|----------|
| 经典暗色 | `:root` | 默认 |
| PQ 浅色 | `body[data-theme="pq"]` | 量子页面 Tab 激活时 |
| 图片 V3 | `body.v3-theme` | 图片加密 Tab 激活时 |

暗色模式下 PQ 主题需要额外覆盖 tab 栏样式（`@media(prefers-color-scheme:dark)`），且必须放在 PQ 浅色规则之后（CSS 层叠：同优先级后写覆盖前写）。

---

## 二、压缩手段

### 2.1 JS 压缩（Terser）

**工具**：`terser` CLI  
**命令**：
```bash
terser input.js \
  --compress passes=3,pure_getters=true,unsafe=true,ecma=2020 \
  --mangle \
  -o output.js
```

**效果**：114,621 → 90,121 chars（**-21.4%**）

| 操作 | 说明 |
|------|------|
| `--compress passes=3` | 3 轮死代码消除、常量折叠、表达式简化 |
| `--compress pure_getters=true` | 假设属性访问无副作用，可进一步优化 |
| `--compress unsafe=true` | 允许不安全但等价的优化（如 `a === void 0` → `a === undefined`） |
| `--compress ecma=2020` | 允许使用 ES2020+ 语法优化（可选链、空值合并等） |
| `--mangle` | 局部变量名缩短（`function showTab` → `function e`） |

⚠️ **不使用 `--mangle-props`**：会破坏 DOM 事件绑定和库内部属性名。

### 2.2 CSS 压缩

**工具**：Node.js 内联脚本  
**处理流程**：

```javascript
minCss = css
  .replace(/\/\*[\s\S]*?\*\//g, '')     // 1. 删除块注释
  .replace(/\n/g, '')                    // 2. 删除换行
  .replace(/\s{2,}/g, ' ')              // 3. 合并连续空白为单空格
  .replace(/\s*([{}:;,>+~])\s*/g, '$1') // 4. 删除结构字符周围的空白
  .replace(/;}/g, '}')                  // 5. 删除 } 前的分号
  .trim();
```

**效果**：17,518 → 17,196 chars（**-1.8%**）

> 原始 CSS 已经是精简写法（无缩进、无换行），压缩空间有限。

### 2.3 HTML 结构压缩

**处理流程**：

```javascript
minHtml = html
  .replace(/\n/g, ' ')           // 换行 → 空格
  .replace(/\s{2,}/g, ' ')       // 合并连续空白
  .replace(/>\s+</g, '><')       // 删除标签间空白
  .replace(/\s+>/g, '>')         // 删除 > 前空白
  .trim();
```

**效果**：HTML body 从 370 行压缩为 1 行

### 2.4 注释清除

```javascript
// 删除所有 /*! ... */ 许可证注释（terser 默认保留）
min = min.replace(/\/\*![\s\S]*?\*\//g, '');
```

**效果**：-616 bytes

---

## 三、压缩效果汇总

| 阶段 | 大小 | 缩减 | 累计缩减 |
|------|------|------|----------|
| 原始多文件 | 157.0 KB | — | — |
| JS Terser 压缩 | -21.4% | -24.5 KB | -15.5% |
| CSS 压缩 | -1.8% | -0.3 KB | -15.7% |
| HTML 结构压缩 | -99.7% (行数) | -3.6 KB | -16.1% |
| 许可证注释清除 | -616 B | -0.6 KB | **-20.9%** |
| **最终 `index.min.html`** | **126.2 KB** | | **-20.9% (-31.6 KB)** |

---

## 四、体积构成

| 模块 | 大小 | 占比 | 可压缩性 |
|------|------|------|----------|
| 应用代码（TextCrypto / AES / Sig / PQ 模块等） | ~48 KB | 37.6% | ✅ 已 Terser 压缩 |
| ml-kem768 库 | ~19 KB | 14.8% | ⚠️ 已是压缩 IIFE，无法再减 |
| ml-dsa65 库 | ~23 KB | 17.9% | ⚠️ 已是压缩 IIFE，无法再减 |
| PureJS 降级库 | ~7 KB | 5.5% | ⚠️ 功能代码，无法再减 |
| CSS 样式 | ~17 KB | 13.3% | ⚠️ 已是精简写法 |
| HTML 结构 | ~15 KB | 10.9% | ✅ 已压缩为 1 行 |

> PQ 两个库合计 ~42 KB（32.7%），是无法进一步压缩的硬体积。

---

## 五、构建脚本

完整的压缩流水线（一键执行）：

```bash
cd sin/
node build.js
# 产出: index.min.html
```

```javascript
// build.js 核心逻辑
const fs = require('fs');
const { execSync } = require('child_process');
const html = fs.readFileSync('index.html', 'utf8');

// 1. 提取内联 JS → terser 压缩
const jsBody = html.slice(jsStart, jsEnd);
fs.writeFileSync('/tmp/build_js.js', jsBody);
execSync('terser /tmp/build_js.js --compress passes=3,pure_getters=true,ecma=2020 --mangle -o /tmp/build_js_min.js');
const minJs = fs.readFileSync('/tmp/build_js_min.js', 'utf8');

// 2. 提取 CSS → 内联压缩
let minCss = css.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n/g, '').replace(/\s{2,}/g, ' ')
  .replace(/\s*([{}:;,>+~])\s*/g, '$1')
  .replace(/;}/g, '').trim();

// 3. HTML 结构压缩
const minHtml = htmlPart.replace(/\n/g, ' ')
  .replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><');

// 4. 组装
const result = minHead + '<style>' + minCss + '</style>' + minBody
  + '<script>' + minJs + '</script></body></html>';

// 5. 清除许可证注释
result = result.replace(/\/\*![\s\S]*?\*\//g, '');

fs.writeFileSync('index.min.html', result, 'utf8');
```

---

## 六、注意事项

1. **`export` 语句必须清除**：PQ 库 IIFE 尾部的 `export{...}` 会导致整个 `<script>` 块解析失败，所有函数（包括 `showTab`）都不会被定义。

2. **`</body>` 位置**：`</body>` 必须在 `<script>` 之后，不能提前关闭。

3. **PQ 主题 CSS 层叠顺序**：`@media(prefers-color-scheme:dark)` 中的 PQ tab 栏覆盖规则必须放在非 media query 的 PQ tab 栏规则之后，否则同优先级下后者会覆盖前者。

4. **`file://` 限制**：`crypto.subtle` 在 Chrome/Safari 的 `file://` 下不可用，需要 PureJS 降级。PQ 库内部直接调用 `crypto.subtle.digest`（未走 CryptoEngine），在 `file://` + Chrome 下可能失败。

5. **TweetNaCl 仍走 CDN**：`nacl-fast.min.js` 保留 `<script src>` 引用。若需完全离线，需将该库也内联（约 30 KB）。

6. **未使用 `--mangle-props`**：会破坏 DOM 事件绑定和库内部属性名，导致运行时错误。

# 自动打框（本地检测模型 → 打码区域）

> 在「图片混淆」页的 V3 面板里加一块**默认折叠**的面板：左侧勾选识别模型（可多选、输出合并），
> 右侧调「识别框扩张」，点一下就把模型框（以及按需把用户手绘的框）填进现有的区域列表。
> **推理全程在浏览器本机进行，图片不上传**；服务端只负责把模型转译成 ONNX 并静态提供。

## 一条数据流看清全貌

```
models/detect/{segm,bbox}/*.pt
      │  服务端启动时（增量、异步、不阻塞 HTTP）
      ▼
tools/detect-export.py  ──►  models/detect/build/<id>.fp32.onnx + <id>.int8.onnx + <id>.json
      │                                   │
      │ /api/detect/models（清单/进度/诊断）  │ /detect-model/*（带缓存的静态路由）
      ▼                                   ▼
src/detect/detect-ui.mjs  ──►  detect-ort.mjs（ORT 会话）──►  detect-core.mjs（纯逻辑解码/合并/扩张/对齐）
      │                                                                     │
      └──────────────►  MOB.addRegion({x,y,w,h})  ◄──────────────────────────┘
                                  │
                                  ▼
                    既有 V3 打码链路（regionEnc + 边框元数据，**未做任何改动**）
```

## 文件一览（新增 / 改动）

| 路径 | 作用 |
|---|---|
| `models/detect/{segm,bbox}/README.md` | 放模型的目录（**权重不入库**，见 `.gitignore`） |
| `models/detect/build/` | 转译产物（运行时生成，ignored） |
| `tools/detect-export.py` | `.pt → .onnx`（fp32）+ 动态量化 int8 + 元数据 JSON；`--check` 体检依赖 |
| `tools/detect-make-fixture.py` | 生成单测用的真实模型输出 fixture（可重跑复核） |
| `tools/fetch-ort.mjs` | 拉 ONNX Runtime Web 到 `src/vendor/ort/`（固定版本 + sha256 校验） |
| `tools/detect-sweep.py` | 换模型/调阈值时的回归抽样（`npm run detect:sweep`；用 ultralytics 当参考实现） |
| `.github/workflows/detect-tests.yml` | 只跑 `test/detect` 的 CI（语法自检 + 单测 + python 语法；相关路径变动才触发） |
| `server/detect-models.js` | 扫描 / 启动期增量转译 / 状态查询 / 路由挂载 |
| `src/detect/detect-core.mjs` | **纯逻辑**：letterbox、输出解码、类内 NMS、跨模型合并、扩张、整块对齐、上限 |
| `src/detect/detect-ort.mjs` | ORT 装载（按后端选构建）、会话缓存、`<img>` → 张量、跑一次 |
| `src/detect/detect-ui.mjs` | 折叠面板：模型勾选、参数、跑批、写回区域、标注来源 |
| `src/detect/deps.js` | 依赖握手（经典脚本 → ES 模块），3 行，见下 |
| `test/detect/detect-core.test.mjs` | 80 项断言，不需要浏览器/模型/GPU |
| `test/detect/fixtures/bbox-foot-640.json` | 真实模型输出的前 64 个锚点（只含数字，约 2.4 KB） |
| `docs/detect-auto-box.md` | 本文件 |
| `server/server.js` | **+10 行**：require 模块、挂路由、`listen` 之后启动转译 |
| `src/image-crypto.html` | 面板骨架（红线处）+ 3 行脚本引用 + 30 行样式 |
| `.gitignore` / `package.json` | 忽略权重与产物、放行 `test/detect/`；三个 npm 脚本 |

**没有改动的**：`src/image-crypto.js`（0 行）、`server/` 既有接口、`deploy/`、`single-file/`、`.pcd/`、
`test/stego/`。可用 `git diff --stat` 复核。

## 服务端

### 启动期转译（增量，而不是无条件重来）

`server/detect-models.js` 在 `app.listen` **之后**异步启动：扫描 `models/detect/{segm,bbox}/`
下的 `.pt/.pth/.onnx`，凡是「`build/<id>.json` 不存在」或「源文件 sha256 与记录不符」或
「imgsz/opset 变了」的才入队转译（队列并发固定 1，单模型超时 10 分钟）。

为什么不做成"每次启动全部重转"：一个 20 MB 的模型实测要 8~14 秒（导出 + 量化），
全量重转会让每次启动白等几十秒，而结果与上次完全一样。需要强制重转时：
`CX_DETECT_FORCE=1`；想只扫描不转：`CX_DETECT_AUTOCONVERT=0`。

`.onnx` 直接丢进目录也会被采用（拷进 build 并补一份元数据，类别表留空）。

### 接口

| 路由 | 说明 |
|---|---|
| `GET /api/detect/models` | 模型清单（含 `status/classes/files/urls`）+ 转译队列 + python 诊断 + 最近日志 |
| `POST /api/detect/rescan` | 重新扫描并入队（`?force=1` 强制重转） |
| `GET /detect-model/*` | build 产物（`Cache-Control: public, max-age=604800`） |
| `GET /detect-runtime/*` | ONNX Runtime 的 js/wasm（同上） |

> 为什么这两个路由**带缓存**，而 `src/` 是 `no-store`：`src/` 禁缓存是为了防「新页面 + 旧脚本」
> 混搭导致解密失败（见 `server.js` 里的长注释）；而这里是几十 MB 的**不可变二进制**，
> 每次重下毫无意义。两者目的不同，故策略不同。

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CX_PYTHON` | 自动探测 `python3`/`python` | 转译用的解释器（可指向 ComfyUI 自带的 venv） |
| `CX_DETECT_AUTOCONVERT` | `1` | `0` = 启动只扫描不转译 |
| `CX_DETECT_FORCE` | `0` | `1` = 忽略缓存强制重转 |
| `CX_DETECT_IMGSZ` / `CX_DETECT_OPSET` | `640` / `17` | 导出参数 |
| `CX_DETECT_TIMEOUT_MS` | `600000` | 单模型转译上限 |

## 前端

### 面板位置

`src/image-crypto.html` 的 `#pa-v3 > .v3-wrap` **第一个子元素**（正好在
「✏️ 在图上用手指/鼠标框选…」上面）。放在 `#pa-v3` 内意味着只在 V3 模式出现 —— 只有 V3 才有区域。

### 为什么 `src/image-crypto.js` 一行都不用改

| 需要的能力 | 做法 |
|---|---|
| 写区域 | 只用公开方法 `MOB.addRegion()`（它内部会 `norm()`，所以添加后从 `MOB.regions[last]` 取引用） |
| 挂"标签/来源/分数" | `WeakMap`（key = 区域对象）。区域被删/撤销后自动回收，不需要往区域对象里塞字段 |
| 在框上画标签 | 包一层 `MOB.draw`：先调原函数，再画标签（覆盖层坐标系与它一致） |
| 拿到 `MOB/IA/T/$` | `src/detect/deps.js` 显式转交到 `window.__CX_DETECT`；模块不猜全局词法绑定 |

标签/来源/分数**不参与编码**：`IA.metaBytes` 只写 `x,y,w,h`，签名也只由坐标与密码决定，
所以显示怎么改都不会影响解密，也不会破坏与网页端/ComfyUI 移植件的互通（`test/detect` 守着这条）。

### 面板行为

- **默认折叠**，展开状态、模型勾选、参数都存 `localStorage`。
- 展开时才去取 `/api/detect/models`（懒加载，不拖慢首屏）。
- 后端选择自动化：有 WebGPU 就用 `ort.webgpu.min.js` + **fp32**（实测 1152×1920 单帧 42~51 ms），
  否则 WASM + **int8**（10.2 MB、0.66~0.9 s/帧）。列表里显示的就是当前后端会用到的那个变体的体积。
- 扩张：`等比缩放`（绕中心，1.00–2.00×）或 `固定外扩`（0–128 px）；
  `作用对象` 可选「模型框 + 手动框」或「仅模型框」。
- **对齐单元跟随"输出格式"**：PNG(`qv3=100`)→`unit=8`、JPEG(`qv3<100`)→`unit=16`，
  与 `pV3` 的两条路径一致；结论行会写出当前值（`对齐：8px（PNG）`）。
  于是"面板里写的坐标"与"实际打码的像素范围"在两种输出格式下都严格一致。
- **标注**：默认「敏感部位（隐藏类别）」—— 因为实测同一处会被多个类各框一次
  （`pussy`/`anus` 会互相抢位置），类别名不能当功能依据；需要看原始类别名时切到
  「显示模型类别名」，清单与覆盖层会同时改成 `pussy 0.886` 这种写法。
  真实类别名始终保留在元素的 `title` 里（悬停可见），且**从不参与编码**。
- 「⤢ 应用到现有框」把当前参数套到**已有**区域上（含手绘的），并保留一份基准，
  「↺ 还原扩张」可回退（若之后又手动改过框，会要求再点一次确认，避免误清）。
- 「🔍 开始自动识别」→ 推理 → 合并 → 扩张 → 8 像素对齐 → 写入区域（上限 12 个，超出按分数取舍并提示）。

## 原项目"标记框"参数检索结果（自动打框必须服从的口径）

| 参数 | 值 / 出处 | 为什么自动打框要在意 |
|---|---|---|
| 区域数上限 | **12**（`MOB.addRegion`；`IA.parseMeta` 里 `cnt>12 → null`） | 超了就打不进元数据、**解不回来**。所以合并后必须 ≤12 |
| 坐标钳制 | `MOB.norm()`：钳进图内并取整 | 扩张后要重新钳制 |
| 最小框 | 手绘 `w>8 && h>8` | 自动框同标准（对齐后不足 8px 的丢弃） |
| 整块对齐 | `pV3`：`x/y` 向下取整到 `unit`，`w/h` 回落完整块；`unit=8`（PNG）/`16`（JPEG） | 标签里显示的必须是**对齐后**的值，否则"列表写的"和"实际打的"不一致 |
| 边框 | `B=8`（PNG）/ `64`（JPEG J2 码） | 区域用**原图**坐标，边框由 pV3 外扩，自动框不用管 |
| 元数据容量 | `rMetaPng(..., maxB=200)`，每区域 8 B | 与 12 上限互相印证 |
| 密码/顺序 | 单密码，`seed=hash(k+'#'+idx)`；加密正序、解密逆序 | 自动框只做**追加**，不重排既有区域 |
| 标签是否入编码 | **不入**（只写 x/y/w/h） | 所以"标明部位"是纯展示，不影响兼容性 |

**"标明"的落地**：面板里每个区域显示 `掩膜外接框/检测框 · 类别 置信度 · 来源模型`，
覆盖层上画小标签；多模型命中同一处时显示 `来源A+来源B`。
类别名**仅供参考** —— 实测同一处会被多个类各框一次（`pussy`/`anus` 会互相抢位置），
所以默认按「敏感部位」合并，不按类别分级。

## 验收（可复跑）

```bash
# 1) 纯逻辑单测（不需要浏览器/模型/GPU）
node test/detect/detect-core.test.mjs          # 期望：✅ 全通：80 项断言

# 2) 依赖体检 + 拉运行时
python tools/detect-export.py --check
node tools/fetch-ort.mjs

# 3) 放模型 → 起服务 → 看转译
copy 某分割模型.pt models\detect\segm\
npm start
curl http://127.0.0.1:3000/api/detect/models

# 4) 浏览器：图片混淆页 → V3 → 展开「🧠 自动打框」→ 勾模型 → 开始自动识别
```

**识别耗时（Chrome 155 / RTX 3060 Laptop / 1152×1920 / WebGPU + fp32 / 模型 38.6 MB）**

| # | 场景 | 会话 | 推理 | 总计 |
|---|---|---|---|---|
| 1 | **首次识别**（模型未进 HTTP 缓存） | 4.68 s | 0.31 s | **5.10 s** |
| 2–7 | 之后每次（模型已在缓存） | 0.86–1.51 s | 0.16–0.28 s | **1.12–1.87 s**（中位 ≈1.35 s） |

会话按 `${id}:${variant}:${ep}` 缓存 → 同一页面内再点一次识别不重建会话，耗时≈纯推理（0.16–0.31 s）。

本机实测（Chrome 155 / RTX 3060 Laptop / ComfyUI 的 venv python）：

| 项 | 结果 |
|---|---|
| 转译 `ntd11_nsfw_segm.pt`（20.6 MB） | fp32 38.65 MB + int8 10.24 MB，13.9 s（第二次启动 0 s，命中缓存） |
| 转译 `foot_yolov8n.pt`（6.1 MB，纯检测） | fp32 11.7 MB + int8 3.2 MB，8.3 s |
| 页面内识别（1152×1920，WebGPU + fp32） | 编译 0.9~1.5 s / 单帧 155~277 ms；候选 3 → 合并 2 处 → 写入 2 个区域 |
| 扩张 1.25×（手工框 120×120 @100,100） | → **152×152 @ (80,80)**（对齐到 8 的倍数，与手算一致） |
| 自动框 240×272 @ (528,680) 扩张后 | → **304×344 @ (496,640)**（同上，可复算） |
| 端到端（自动打框 → 打码 → 只给图+密码还原） | PSNR **64.03 dB**、**区域外改动 0 个通道样本**、端到端 5.8 s |
| 未点"应用扩张"时（手绘框 100,100 未对齐） | 区域外改动 983 个样本，全部落在手绘框外沿 ≤8px —— 这是网页端**既有**的 unit 对齐行为（`pV3` 把它对齐到 96,96 再打码）；点一次"应用到现有框"即归零 |

### 脚本化检查与 CI

- `npm run detect:check` → python/依赖体检（退出码可用于 CI）
- `npm run detect:fetch-ort` → 拉运行时并逐个校验 sha256
- `npm run detect:sweep` → 换模型/调阈值后的回归抽样（看漏检与误报倾向，不进 CI：需要真实权重与图）
- CI：`.github/workflows/detect-tests.yml` 在 `src/detect/**`、`test/detect/**`、
  `server/detect-models.js`、`tools/detect-*.py` 等路径变动时跑语法自检 + 单测

## 降级与边界

| 情况 | 行为 |
|---|---|
| 静态托管（GitHub Pages）/ 单文件版 | 面板显示"不可用 + 原因"，不报错，加密解密照常；单文件版不含本功能（8 信道合并产物保持原样） |
| 没装 python / 缺 torch·ultralytics | `/api/detect/models` 返回 `available:false` 与 `hint`（提示可用 ComfyUI 的 venv），面板显示原因 |
| 没放模型 | 面板提示目录位置，并给「重新扫描」按钮 |
| 某模型转译失败 | 该模型标 `error`（悬停看 stderr 摘要），其余模型照常可用 |
| 干净图零检出 | 不添加任何区域，只提示"未检出"，不动用户已有的框 |
| 合并后超过 12 个 | 按「按分数」策略截断并提示，不静默丢弃 |
| 无 WebGPU | 自动退 WASM + int8，面板显示当前后端 |

## 许可与体积

- `onnxruntime-web` 是 MIT（`tools/fetch-ort.mjs` 会把许可写到 `src/vendor/ort/ort-LICENSE`），运行时约 67 MB（未压缩），
  **不入库**，由脚本拉取。
- 检测权重多为 AGPL-3.0（Ultralytics 系）或训练者自定义许可，**不入库**（`.gitignore` 已忽略），
  由使用者自备并本地转译。因此本功能在仓库里不附带任何模型文件。

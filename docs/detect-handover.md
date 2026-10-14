# 交接文档 · 图片混淆页「自动打框」

> 面向接手人：读完这一份应当能在 10 分钟内把功能跑起来、知道每块代码在哪、
> 哪些事情已经验证过、哪些还是坑。
>
> 机器相关的路径与端口**全部集中在 §7**，便于整体剥离或替换；
> 设计取向与参数口径另见 [detect-auto-box.md](detect-auto-box.md)。

## 0. 现状

「自动打框」已实装并完成真机验收：服务端增量转译检测模型 → 浏览器本机推理 →
自动填打码区域 → 走既有 V3 打码链路 → **只给图 + 密码可还原（区域外零改动）**。
`src/image-crypto.js` **一行未改**，是这次设计的目标与回归线。

## 1. 交付物清单

**改动既有文件只有 6 个**（其余全是新增）：

| 既有文件 | 改动 | 内容 |
|---|---|---|
| `server/server.js` | +10 行 | `require('./detect-models')`、挂 2 组路由、`listen` 之后启动转译 |
| `src/image-crypto.html` | +83 −1 | 面板骨架（V3 面板折叠块）+ 30 行样式 + 3 行脚本引用 |
| `.gitignore` | +14 行 | 忽略权重/产物、放行目录 README、补 `!test/detect/` |
| `package.json` | +4 行 | `detect:check` / `detect:export` / `detect:fetch-ort` / `detect:sweep` |
| `README.md` | +11 行 | 结构树 2 行 + 「自动打框（可选）」小节 |
| `src/image-crypto.js` | **0 行** | ← 这是设计目标，也是回归线 |

| 路径 | 说明 |
|---|---|
| `server/detect-models.js` | 扫描 / 启动期增量转译 / 状态机 / 路由挂载 |
| `server/server.js` | +10 行：require + 挂路由 + `listen` 之后启动转译 |
| `tools/detect-export.py` | `.pt → ONNX`（fp32）+ 动态 int8 + 元数据 JSON；`--check` / `--scan` / `--force` |
| `tools/detect-make-fixture.py` | 生成单测用的**真实模型输出** fixture（可重跑复核） |
| `tools/fetch-ort.mjs` | 拉 ONNX Runtime Web 到 `src/vendor/ort/`（固定版本 + sha256 + LICENSE） |
| `tools/detect-sweep.py` | 换模型/调阈值时的**回归抽样**（用 ultralytics 当参考实现，只输出聚合统计；需要真实权重与图，故不进 CI） |
| `.github/workflows/detect-tests.yml` | 只跑 `test/detect` 的 CI（语法自检 + 单测 + python 脚本语法；改动相关路径才触发） |
| `src/detect/detect-core.mjs` | **纯逻辑**：letterbox / 解码 / 类内 NMS / 跨模型合并 / 扩张 / 整块对齐 / 上限 |
| `src/detect/detect-ort.mjs` | ORT 装载（按后端选构建）、会话缓存、`<img>`→张量、跑一次 |
| `src/detect/detect-ui.mjs` | 面板：模型勾选、参数、跑批、写回区域、标注来源、「应用/还原扩张」 |
| `src/detect/deps.js` | 经典脚本 → ES 模块依赖握手（`window.__CX_DETECT`） |
| `src/image-crypto.html` | 面板骨架（`#pa-v3 > .v3-wrap` 第一个子元素）+ 样式 + 3 行脚本引用 |
| `test/detect/detect-core.test.mjs` | 80 项断言（不需要浏览器 / 模型 / GPU） |
| `test/detect/fixtures/bbox-foot-640.json` | 真实模型输出前 64 个锚点（约 2.4 KB，只含数字） |
| `models/detect/{,segm/,bbox/}README.md` | 放模型的目录说明（**权重不入库**） |
| `docs/detect-auto-box.md` | 设计说明、参数口径表、验收数据、降级行为 |
| `docs/detect-handover.md` | 本文件 |
| `.gitignore` / `package.json` / `README.md` | 忽略规则、3 个 npm 脚本、结构树与入口小节 |

仓库外（本机脚手架，不入库）：`D:\cx-webseg\`（转译产物、验收台、测试素材，见 §7）。

## 2. 10 分钟上手

```bat
:: 1) python 侧：用 ComfyUI 自带的解释器最省事（torch/ultralytics/onnxruntime 都齐）
set CX_PYTHON=<你的 ComfyUI venv>\Scripts\python.exe
python tools\detect-export.py --check          :: 期望：逐包版本 + CXEXPORT {"ok": true, ...}

:: 2) 浏览器侧运行时（约 67 MB，不入库）
node tools\fetch-ort.mjs                       :: 期望：8 个文件 sha256 ✓ + 写 ort-LICENSE

:: 3) 放模型 → 起服务 → 看转译
copy <某个>.pt models\detect\segm\
npm start
curl http://127.0.0.1:3000/api/detect/models   :: 期望：status=ready、files.fp32/int8、classes

:: 4) 单测
node test\detect\detect-core.test.mjs           :: 期望：✅ 全通：80 项断言
```

首转一个 20 MB 模型约 14 秒（后台跑，HTTP 已在服务）；**第二次启动 0 秒**（sha256 命中）。
强制重转 `CX_DETECT_FORCE=1`；只扫描不转 `CX_DETECT_AUTOCONVERT=0`。

浏览器侧：打开「图片混淆」页 → V3 区域打码 → 展开「🧠 自动打框」→ 勾模型 → 「开始自动识别」。

> **验收时的注意点**：文件选择框无法被自动化驱动（`fill` 不支持 `input[type=file]`）。
> 自动化验收要用一个"验收台"：原样取仓库页面、只多插一段"喂图"脚本（走与用户拖拽
> 完全相同的 `IA.ld` 通道）、其余请求反代到真实服务端。做法见 §7。

## 3. 架构与数据流

```
models/detect/{segm,bbox}/*.pt
   │ 服务端启动时（增量、异步、不阻塞 HTTP；队列并发 1、单模型超时 10min）
   ▼
tools/detect-export.py ──► models/detect/build/<id>.fp32.onnx + <id>.int8.onnx + <id>.json
   │                                   │
   │ GET /api/detect/models             │ GET /detect-model/*   （public, max-age=604800）
   ▼                                   ▼
src/detect/detect-ui.mjs ─► detect-ort.mjs（ORT 会话缓存）─► detect-core.mjs（纯逻辑）
   │                                                              │
   └──────────────► MOB.addRegion({x,y,w,h}) ◄────────────────────┘
                              │
                              ▼
             既有 V3 打码（regionEnc + 边框 LSB 元数据）—— 一行未改
```

分层理由：`detect-core` 不碰 DOM/ORT → 可单测、可定位问题归属；
`detect-ort` 只管运行时与张量；`detect-ui` 只管交互与写回。
**标签/来源/分数只存在于 UI 层与 `WeakMap`，永不进入编码。**

## 4. 关键决策与坑（改动前务必读）

| # | 事项 | 结论 / 原因 |
|---|---|---|
| 1 | `src/image-crypto.js` 能不能改 | **不要改**。用 `MOB` 公开方法 + `WeakMap` 挂标签 + 一次 `MOB.draw` 包装即可；`git diff --quiet -- src/image-crypto.js` 就是回归线 |
| 2 | 区域上限 | **12**（`MOB.addRegion` 与 `IA.parseMeta` 双重限制）。超了打不进元数据、**解不回来** |
| 3 | 整块对齐 | 必须用 `pV3` 的口径（`image-crypto.js` 1418–1425 行）：`x/y` 向下取整到 `unit`、`w/h` 回落完整块；面板显示**对齐后**的值 |
| 4 | 对齐单元随"输出格式"变 | PNG(`qv3=100`) 用 `unit=8`、JPEG(`qv3<100`) 用 `unit=16` —— 与 pV3 两条路径一致；`detect-ui.mjs` 的 `currentUnit()` 直接读 `#qv3` 滑杆，不写死，否则 JPEG 模式下"声明≠实际"会再差最多 8px |
| 5 | 手绘框的对齐现象 | 手绘 `100,100`（非 8 倍数）编码时会被对齐到 `96,96`，于是"区域外"出现 ≤8px 外沿差异 —— **既有行为**，点一次「应用到现有框」即归零 |
| 6 | ORT 的 `wasmPaths` | 必须**绝对 URL**，否则侧车 `.mjs` 动态 import 失败（报 "Failed to resolve module specifier"，像模型坏了） |
| 7 | WebGPU 还缺文件 | `ort.webgpu.min.js` 会取 `*-asyncify.{mjs,wasm}`，缺了同样报"动态 import 失败"；`fetch-ort.mjs` 已含这两枚 |
| 8 | 精度与后端配对 | WebGPU→fp32（42~51 ms/帧）、WASM→int8（0.66~0.9 s/帧）；**int8+WebGPU 反而更慢**（算子回落 CPU） |
| 9 | 量化方式 | 动态 int8 可用（与 fp32 的框 IoU 0.97~0.98）；**静态 QDQ 会把检测头量化掉 → 检出归零**，故不采用 |
| 10 | 缓存策略 | `src/` 保持 no-store（防"新页面 + 旧脚本"混搭）；新路由带缓存（几十 MB 不可变二进制）。目的不同，别统一 |
| 11 | 纯检测模型的通道数 | `channels = 4 + nc`（无 32 个掩膜系数）。`numMask` 必须显式给，**不能用通道数反推**（会得到负类别数并静默产出垃圾框，已加显式抛错） |
| 12 | 类别名 | 不可信：同一处会被多类各框一次、量化后 argmax 还会互换。默认只显示「敏感部位」，面板可切换到「显示模型类别名」，`title` 里始终保留原名 |
| 13 | python 发现顺序 | `CX_PYTHON` → `python3` → `python`；缺依赖时整条功能降级（`available:false` + 可执行提示），**不影响**加密解密与公钥库 |
| 14 | 仓库行尾 | 工作区可能是 CRLF 而索引是 LF；改既有文件时先从索引版本重建 LF 再改（否则整文件变红） |
| 15 | 权重与运行时 | 一律不入库（许可 + 体积）；`.gitignore` 已写好，靠 `fetch-ort.mjs` 与自备 `.pt` 复原 |
| 16 | **可选功能不能带崩服务** | `start()` 跑在 `listen` 之后的异步流程里，未捕获的 promise rejection 在 Node 16+ 会**退出进程** → 建目录/扫描/转译全部 try/catch + 失败降级；容器只 `COPY server/ src/`（镜像里没有 `models/`、没有 python），这些场景都必须能正常服务。实测 ENOTDIR 场景：站点 200、`available:false`、进程存活 |
| 17 | 部署时可外挂模型目录 | `CX_DETECT_ROOT` 指定模型目录（挂卷用）；诊断默认脱敏（`python.cmd` 只回 basename、日志抹绝对路径），排查时开 `CX_DETECT_EXPOSE_DIAG=1` |

## 5. 接口契约

### 5.1 HTTP

| 路由 | 返回 |
|---|---|
| `GET /api/detect/models` | `{available, python{cmd,version,missing,hint}, runtime{installed,files}, autoconvert, paths, dir{root,writable,error}, models[{id,kind,task,status,classes,imgsz,files,urls,source,error}], queue{pending,running,done,failed}, logs[], hint}`；**默认脱敏**（cmd 只 basename、日志与 dir.root 抹绝对路径），`CX_DETECT_EXPOSE_DIAG=1` 给全量 |
| `POST /api/detect/rescan?force=1` | 同结构（重新扫描并入队） |
| `GET /detect-model/<id>.{fp32,int8}.onnx` | build 产物（带缓存） |
| `GET /detect-runtime/<ort 文件>` | ORT 的 js/wasm（带缓存） |

### 5.2 文件格式

| 文件 | 内容 |
|---|---|
| `models/detect/build/<id>.json` | `{id,kind,task,classes,imgsz,opset,source{file,bytes,sha256,mtime},files{fp32,int8},exported_at,tool,notes}` |
| `test/detect/fixtures/*.json` | `{model,task,imgsz,image{W,H},classes,dims,numMask,preds_b64,reference(ultralytics 的框)}` |

### 5.3 面板参数语义

| 控件 | 取值 | 作用 |
|---|---|---|
| 方式 / 倍数 / 外扩 | 等比 1.00–2.00× · 固定 0–128px | 扩张（绕中心 / 四边） |
| 作用对象 | 模型框+手动框 / 仅模型框 | 「应用到现有框」是否连带手绘框 |
| 合并 | 邻近（IoU>0.30 或小框包含率>0.80）/ 外接框 / 不合并 | 跨类跨模型去重 |
| 置信度 | 0.10–0.60（默认 0.30） | 解码阈值 |
| 标注 | 敏感部位（默认）/ 显示类别名 | 只影响显示，不影响编码 |
| 上限 | 固定 12，按分数截断 | 与网页端硬约束一致，不给用户改 |

### 5.4 浏览器侧日志（便于自动化核对）

- `CXABOX {stage:'detect', ep, W, H, chosen, candidates, grouped, added, overflow, regions[], perModel[], timings[], totalMs}`
- 失败：`CXABOX {stage:'error', error}`（面板状态与提示行同步给出原因）

## 6. 验收数据

| 项 | 结果 |
|---|---|
| 单测 | `node test/detect/detect-core.test.mjs` → **80 项断言全通** |
| 转译（20.6 MB 分割模型） | fp32 38.65 MB + int8 10.24 MB，13.9 s；二次启动 0 s |
| 转译（6.1 MB 检测模型） | fp32 11.7 MB + int8 3.2 MB，8.3 s（rescan 后台完成，HTTP 不受影响） |
| 页面内识别（1152×1920，WebGPU+fp32） | 会话 0.9~1.5 s、单帧 155~277 ms；候选 3 → 合并 2 → 2 个区域 |
| 1.25× 扩张（与手算对照） | `120×120@(100,100)→152×152@(80,80)`；`240×272@(528,680)→304×344@(496,640)` |
| 端到端（自动打框→打码→仅图+密码还原） | PSNR **64.03 dB**、**区域外改动 0 个通道样本**、5.8 s |
| 未点"应用到现有框" | 983 个样本在手绘框外沿 ≤8px（§4 第 4 条，属既有口径） |
| 降级路径 | 无服务端 / 无模型 / 无 python 三种都给出原因，加密解密照常 |

### 6.1 识别耗时实测记录（Chrome 155 / RTX 3060 Laptop / 1152×1920 / WebGPU + fp32 / 模型 38.6MB）

每次记录 = 一次页面加载后点一次「开始自动识别」，`totalMs` 是"取模型 → 建会话 → 推理 → 后处理 → 写区域"的总和；
`会话` = ORT 建会话（含图优化与着色器编译），`推理` = 单帧前向。

| # | 场景 | 会话 | 推理 | 总计 |
|---|---|---|---|---|
| 1 | **首次识别**（模型未进 HTTP 缓存） | 4.68 s | 0.31 s | **5.10 s** |
| 2 | 之后每次（模型已在缓存） | 1.13 s | 0.18 s | 1.37 s |
| 3 | 同上 | 1.13 s | 0.22 s | 1.41 s |
| 4 | 同上 | 0.86 s | 0.16 s | 1.12 s |
| 5 | 同上 | 1.00 s | 0.25 s | 1.32 s |
| 6 | 同上 | 1.06 s | 0.19 s | 1.31 s |
| 7 | 同上 | 1.51 s | 0.28 s | 1.87 s |

- **首次 5.10 s**（其中会话 4.68 s、推理 0.31 s），后续 6 次落在 **1.12–1.87 s**（中位数 ≈1.35 s）。
- 稳定后的**纯推理**是 **0.16–0.31 s**；会话按 `${id}:${variant}:${ep}` 缓存，
  所以同一页面内再点一次识别不重建会话，耗时≈纯推理那一段。
- 首次之所以明显更贵：38.6 MB 模型下载 + 首次会话（含着色器编译）。
  想更快就按后端选 int8（WASM 路径 10.2 MB / 0.66~0.9 s 一帧），或改用更小的权重。
- 注：以上都是 WebGPU + fp32（本机默认选择）；WASM + int8 的数据来自可行性阶段的对照测试。

## 7. 开发环境参考（示例；换机器时整节替换）

| 项 | 值 |
|---|---|
| 仓库 | fork of `cxxy161/cx-E2EE`；开发在 `feat/auto-box` 分支，上游默认分支 `main` |
| ComfyUI 实例 | `D:\ComfyUI-new`（0.36.0，venv 内含 torch/ultralytics/onnx/onnxruntime）；`D:\Program Files (x86)\ComfyUI-aki-v2`（0.25.1，GUI 在 8188，**勿随意 kill**） |
| python 解释器 | `D:\ComfyUI-new\venv\Scripts\python.exe`（转译用它最省事） |
| 模型来源 | `ComfyUI-aki-v2\ComfyUI\models\ultralytics\{segm,bbox}\`（`*-seg.pt`、`face_yolov8m.pt`、`Foot-yolov8n.pt` 等） |
| 端口 | 3000 = `npm start`；8188 = aki GUI；其它临时实例请随手关掉 |
| 验收台 | 仓库外脚手架：一个 node 脚本，原样代理服务端 + 注入"喂图"脚本（因为文件选择框无法自动化），页面与仓库版本逐字节相同、只多那一段脚本 |
| 测试素材 | 仓库外目录（图片约几 MB），**不入库、不外传** |

## 8. 未完成 / 建议下一步（按优先级）

已完成（本轮补上，无需再动）：

- ✅ **CI 接线**：`.github/workflows/detect-tests.yml` —— 语法自检 + `node test/detect/detect-core.test.mjs`
  + python 脚本语法自检；只在相关路径变动时触发，不给其它提交制造噪音。
- ✅ **JPEG 路径的 unit 自适应**：`detect-ui.mjs` 的 `currentUnit()` 读 `#qv3`：PNG→8、JPEG→16，
  与 pV3 两条路径一致（结论行里也会写出当前对齐值）。
- ✅ **模型回归抽样脚本**：`tools/detect-sweep.py`（`npm run detect:sweep`）——
  用 ultralytics 当参考实现，输出逐图最大置信度/类别分布 + 聚合（含零检出张数），
  只落聚合统计不落文件名。换模型或调阈值时先跑一遍看漏检/误报倾向。

仍可继续（按优先级）：

1. **类别语义**（中）：若要做"按部位分级打码"，得先解决多类抢同一处的问题
   （换模型 / 按掩膜形状而非外接框 / 人工复核后逐区域设强度）。
2. **ComfyUI 侧参数对齐**（低）：`integrations/comfyui/` 那份节点的 `pad` 与本页「扩张」语义可统一；
   两边元数据格式本就一致（有逐字节对照测试）。
3. **批量处理**（低）：目前只处理当前载入的图。
4. **测试面扩张**（低）：`test/stego/*` 里纯 node 的部分也可以接进 CI（本次没动，避免与既有测试耦合）。

## 9. 接手检查清单

- [ ] `node test/detect/detect-core.test.mjs` → 80 项全通
- [ ] `python tools/detect-export.py --check`（用 `CX_PYTHON`）→ `ok: true`
- [ ] `node tools/fetch-ort.mjs` → 8 个文件 sha256 ✓
- [ ] 放一个模型 → `npm start` → `curl /api/detect/models` 看到 `ready` 与两类 onnx 体积
- [ ] 页面上传一张图 → 展开面板 → 识别 → 区域出现且带「敏感部位 · 模型名」标注
- [ ] 切「显示模型类别名」→ 清单 / 结论行 / 覆盖层同步变化
- [ ] 「应用到现有框」1.25× → 手绘框与模型框一起变大，坐标都是 8 的倍数
- [ ] 打码 → 用同一密码还原 → 区域外无改动
- [ ] `git diff --quiet -- src/image-crypto.js` → 成立（零改动）

## 10. 术语表

| 词 | 含义 |
|---|---|
| 640 坐标系 | 原图 letterbox 到 640×640 后的坐标，模型输出就在这个坐标系里 |
| 原图坐标系 | 用户看到的坐标，也是 `MOB.regions` 与元数据里用的坐标 |
| 掩膜外接框 | 分割模型掩膜（阈值化后）的外接矩形，比检测框更贴合目标 |
| 整块对齐 (unit) | 把区域对齐到 `unit` 像素的整数块；PNG 用 8、JPEG 用 16 |
| 声明区域 / 实际打码区域 | 前者写进元数据与列表，后者是 `regionEnc` 真正改动的像素范围；两者应严格一致 |
| 增量转译 | 用 sha256 + imgsz + opset 判断产物是否仍有效，有效则跳过 |
| 降级 | 缺 python / 模型 / 服务端时面板只显示原因，其余功能完全不受影响 |

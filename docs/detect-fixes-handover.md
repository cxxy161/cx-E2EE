# 交接文档 · 自动打框「审查修复」这一轮

> 面向接手人：这一份只讲**上面那 7 个修复提交**在做什么、为什么、怎么复验、还有什么没修。
> 功能本身的设计与参数口径见 [detect-auto-box.md](detect-auto-box.md)，
> 原有交接见 [detect-handover.md](detect-handover.md)。
>
> 基线：作者 PR 的 `f0b0c1d`（含「尺度跟随模型 + 多尺度构建 + 大图分块」与「权重随库附带」）。
> 本轮的 7 个提交全部叠加在它之上，**纯 fast-forward，未改写任何既有提交**。

## 0. 一句话

作者那两个提交把功能做**全**了，但有两处「静默失效」和一个**fail-open 的默认值**；
本轮只修这些，不碰功能设计。

## 1. 为什么会有这一轮

对 PR 做了一次针对性复查（浏览器侧 / 服务端与工具链 / ComfyUI 侧），结论是：

- 三个安全项、一个 OOM、一个会漏打码的默认值、一个坏的布局 —— 都是**实际缺陷**，不是口味问题；
- 作者后续两个提交是**纯加功能**，前面报的问题一条没修；
- 其中一个新提交把打码节点的默认值从「漏检就报错」改成了「漏检就输出原图」，方向是反的。

## 2. 七个提交各修什么

### `bfd9ffe` 模型元数据不再拼 innerHTML（安全）

`detect-ui.mjs` 把服务端返回的文件名、模型 id、**第三方 .pt 里嵌的类别名**、python stderr
直接拼进 HTML。而这一页正好持有用户明文与密码，全站又没有 CSP。

改法：`setMsg(...)` 改成接收文本/DOM 片段；列表与清单用 `createElement` + `textContent`；
`title` 走属性赋值。helper 取名 `mk` 而不是 `el`，避开文件里多处局部的 `const el = $(...)`。

### `2e0db8a` 面板布局（类名撞全局规则）

面板根元素原来叫 `.abox`，而 `style.css:77` / `pq-style.css:136` 里 `.abox{display:flex}`
是**另一个组件**（输入行，配 `.ainp`）。面板自己那条规则没写 `display`，于是被全局规则接管成
flex 行 —— 头部与正文左右并排。

改法：根类名 `.cx-abox` + **显式** `display:block`。模型行顺便改成两行网格
（原来单行 flex 在 190px 窄列里会把「分割」徽标挤成竖排、模型名截成 `ntd11_nsfw_s…`）。

### `c107451` available 与 python 解耦（**这条最关键**）

`payload().available` 原来是 `state.python.ok`，而客户端 `run()` 第一道门就是
`if (!state.payload.available) return`。于是把权重与 ONNX 构建都随库附带之后，
**只要本机没装 torch/ultralytics，面板就红着「不可用」、点识别什么都不发生**。

实测证据：4 个模型全部 `ready`，面板仍显示
`不可用（torch,ultralytics,onnx,onnxruntime,cv2）`。

改法：`available = python.ok || 有 ready 模型`。python 只决定「.pt 能不能现场转译」。
面板另加一行说明，免得用户以为整个功能坏了。

### `ec393f2` 大图分块不再累积原始张量（OOM）

`run()` 把每一块的完整结果（preds + protos）都 push 进 `outputs`，全部跑完才解码。
按随库构建的真实形状：@1280 一块约 18.0 MiB（其中 protos `[1,32,320,320]` 就 12.5 MiB），
4024×6048 要 54 块 → 约 973 MiB；`tileMax` 上限 128 块 → 最坏约 2.2 GiB。

改法：`buildRegions` 允许一项「已解码」的结果自带 `candidates` 字段；`run()` 每块跑完
**立刻解码**，只留候选 —— 张量随即失去引用。几何逻辑一行没动，129 项断言全过就是保证。

### `1a6af82` 默认值与计数

- `merge` 默认 `near` → `union`。`near` 只保留高分框、**丢弃**与之重叠的低分框 ——
  两个类抢同一处时，被丢掉那个框覆盖的像素就没人管了（漏盖 = 泄露像素）。
  配一次性迁移：老浏览器 localStorage 里存着 near，不迁移这次改动对老用户等于没发生。
- 结论行只报**真跑了几个**模型（超 tileMax 被跳过的原来也算进去，会出现「识别 3 个」其实只跑 2 个）；
  全被跳过时清掉上一次的旧结论行。
- 等比缩放上限 200% → **500%**。

### `5944149` ComfyUI `no_region_policy` 默认翻回 error（安全）

`passthrough` 的行为是：**检测器漏检时原样返回未打码的图 + 全 0 MASK**，唯一信号是一句 stdout print；
下游 SaveImage 会用「成功打码」的文件名把这张原图写出去。作者把这个做成了默认值 ——
对打码工具是 fail-open。

改法：默认与选项顺序改回 `error`，**保留 passthrough 选项**（它是合法选择，只是不该当默认）；
16 个工作流的值同步；测试口径同步（原本断言默认是 passthrough 的改掉，原本「靠旧默认走直出」
的用例改成**显式**传 passthrough，因为它们本来就在验证 fail-open 行为本身）。

### `cc0d2ab` 多尺度徽标去重

多尺度构建的 id 已带 `@<imgsz>`，旁边再挂 `1280px` 徽标只是重复占宽、把名字挤成省略号。
id 带 `@\d+$` 时不挂徽标。

## 3. 怎么复验

### 3.1 纯逻辑（不需要浏览器/模型/GPU）

    node test/detect/detect-core.test.mjs          # 期望：✅ 全通：129 项断言

### 3.2 ComfyUI 节点包（需要 ComfyUI 的 python）

    PY=/path/to/ComfyUI/venv/bin/python
    cd integrations/comfyui/ComfyUI-CX-ImageScramble
    CX_COMFY_ROOT=/path/to/ComfyUI $PY tests/test_nodes.py
    $PY tests/test_regions.py
    $PY tests/test_workflows.py

期望三套都「全部通过」。`tests/test_segs_tools.py` 需要真 ComfyUI 服务 + Impact Pack，本环境未跑。

### 3.3 浏览器（真机）

    npm start          # 或 PORT=3000 node server/server.js
    # 打开 http://127.0.0.1:3000/image-crypto.html → V3 区域打码 → 展开「🧠 自动打框」

应看到（本轮修复后的实测值）：

| 检查项 | 期望 |
|---|---|
| 面板状态 | **就绪 N 个 · WASM**（不再是红色「不可用」） |
| 布局 | 头部在上、正文在下（`display:block`，不是 flex 行） |
| 模型行 | 名字完整不截断；`@960/@1280` 不重复挂尺度徽标 |
| 合并默认 | 合并为外接框（推荐） |
| 倍数滑杆 | 最大 5.00× |
| 大图 | 1664×2432 选 @1280 → 分 6 块（重叠 50%），WASM+int8 约 13–16 s，堆约 180 MB |

## 4. 本轮**没有**做的事（接手人请知情）

### 4.1 明确不修，留给后续

| 项 | 说明 |
|---|---|
| **CSP** | 全站仍无 Content-Security-Policy。真正的修复是转义（已在 `bfd9ffe` 做），CSP 是纵深防御；要做就得走 HTTP 头 + 全站内联脚本改造，是一整轮的事 |
| **ComfyUI 密码外泄（C1）** | `nodes.py` 每次运行仍把密码 print 到日志、密码错误时把密码塞进 `ValueError`；而 ComfyUI 会把节点异常持久化、由**未鉴权的 `GET /history`** 提供 → 共享 ComfyUI 上别人能读到密码。**这条优先级很高** |
| **ComfyUI 空密码（C2）** | 网页端拒绝空密码，移植件把空密码映射成公开常量 `"0"`；示例工作流仍自带 `key=20240117` / `password="cx-demo"` |
| **ComfyUI C3/C4** | 小图可触发 `v3_read_meta` IndexError；内存峰值约 41× 原图且无尺寸上限 |
| **无鉴权 `POST /api/detect/rescan`（M2）** | 仍存在，无 Origin 校验、无限速；`?force=1` 可让所有模型重跑一次导出 |
| **服务端仍会 spawn python** | 启动期仍做依赖探测；`.pt` 仍是 `torch.load(weights_only=False)` —— 「往模型目录丢文件」= 在服务器上执行代码。本轮**没有**动这条链路 |
| **源扫描口径（M3）** | `--imgsz 960` 导出的 `foo.pt` 找不到 `foo.json`，会永远 pending 或白跑一次 640 导出 |
| **`foot_prebuilt` 永不进列表（M4）** | 随库那份「只有构建产物」的样例因 id 无 `@`、无源而不出现在模型列表里（12 MB 死文件） |
| **ORT `inputMetadata`（L1）** | ORT 1.30 的 `inputMetadata` 是普通数组，`im.get`/`im[name]` 取不到 → 「按输入名取形状」永不生效，多输入模型会取错 |
| **对齐可越窗口（L2）** | `alignRegion` 的 floor 可把最终区域推出窗口最多 unit-1 px（实测 32/1687，最大 7px）。**已证不是泄露** —— 越界像素必落在相邻窗口内 |
| **仓库体积** | 权重与 ORT 入库后 `.git` 约 230 MB，且**已进历史、删文件不减小**。其中 14.26 MB 是死文件：`ort-wasm-simd-threaded.{mjs,wasm}` 被任何已入库的 js/mjs 引用 0 次 |

### 4.2 有意放弃的

原本还有一份「静态资产 + `index.json`、把转译彻底移出服务端」的重构
（分支 `fix/detect-offline-assets`，删掉 `server/detect-models.js` 368 行）。
作者后来把权重直接入库了，那套要解决的问题不存在了，硬合并只会删掉作者的
`adoptOnnx` 与 `@imgsz` 多尺度登记 —— 所以**整份放弃**，只保留了仍然成立的修复。

## 5. 回退

本轮是纯 fast-forward（`f0b0c1d..cc0d2ab`），原始提交一个没丢。要整体撤销：

    git push --force-with-lease <remote> <commit-f0b0c1d>:<branch>

只想撤单个：`git revert <sha>` 即可，7 个提交互不依赖（文件基本不重叠）。

## 6. 建议的下一步优先级

1. **ComfyUI C1（密码进日志与 /history）** —— 安全，且与功能无关，可以单独先修
2. **`POST /api/detect/rescan` 加开关/鉴权**，并把 `.pt` 转译挪到离线或隔离进程
3. ORT 死文件与仓库体积：如果在意，趁还没合进主干，先定「要 clone 即用还是要仓库轻」
4. M3/M4/L1 这类是功能正确性小洞，不急但会导致「明明有模型却用不上」

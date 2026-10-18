# 第三方集成：ComfyUI 自定义节点

这里的目录是**围绕 cx-E2EE 已有能力做的外围集成**，不是本项目运行所需的一部分：
`src/`、`server/`、`deploy/`、`single-file/` 一行都没动，npm 脚本、Docker 镜像、
GitHub Pages 构建也不引用本目录（零耦合，删掉整个 `integrations/` 对本项目没有任何影响）。

## 这是什么

把 `src/image-crypto.js` 里 V3 区域打码那套算法（`IA.hash` / `IA.rng` / `IA.perm` /
`IA.regionEnc`，以及 PNG 边框元数据 `metaBytes` / `borderMixup` 一侧的读写）
做成 **ComfyUI 自定义节点**，用 Python + NumPy **逐位等价**地重写了一遍，于是它有两条用处：

1. **本地流水线**：浏览器里一次点一张图很自然，但要批量处理文件夹、或者要先让检测模型
   自动框出人/脸/文字再打码时，图形节点流水线更省事。节点直接吃检测模型的输出
   （Impact Pack 的 `SEGS`、`BBOX`、`MASK`），不需要手抄坐标。
2. **一份可执行的规范**：移植件的价值不在代码而在**对照测试**——JS 参考实现是从
   `src/image-crypto.js` **原样抽取**（`tests/js_parity/make_ref_impl.py`，不手抄），
   两边喂同一份数据比字节。所以这套东西顺带成了"区域打码 + 边框元数据"格式的
   一份可运行的等价性证据：任何一侧改了算法，测试会立刻不同步报警。

**等价范围**：同样的图 + 同样的区域 + 同样的密码，输出与浏览器端**逐字节相同**；
节点写出的「自带区域表的打码图」与网页端写出的**逐字节相同**，同一个密码在两端互认
（解出来只需要那张图 + 密码，不需要区域坐标）。

## 目录

```
integrations/comfyui/
├── README.md                       # 本文件
└── ComfyUI-CX-ImageScramble/       # 节点包本体（可整个拷进 custom_nodes/）
    ├── __init__.py                 # 只用 V3 入口 comfy_entrypoint
    ├── nodes.py                    # 两个节点：CX_RegionScramble / CX_RegionUnscramble
    ├── cx_core.py                  # 算法核（JS 数值语义复刻 + 打框数据解析 + 元数据层）
    ├── pyproject.toml              # ComfyUI Registry 元数据（非 npm，不进本项目构建）
    ├── README.md                   # 节点自己的说明书（接线、参数、坑、实测数据）
    ├── workflows/                  # 6 组开箱即用示例工作流（UI 格式 + .api.json）
    ├── docs/img/                   # 3 张实拍对照图（输入 / 打码 / 还原）
    └── tests/                      # 5 个测试 + 工作流与对照图生成器 + js_parity/
```

## 安装

节点包需要放在 ComfyUI 的 `custom_nodes/` 下（ComfyUI 只扫描那里）。
两种方式，**同一份源码只维护一处**：

```bat
:: 方式 A：拷贝（仓库在哪无所谓）
xcopy /E /I integrations\comfyui\ComfyUI-CX-ImageScramble "%COMFY_ROOT%\custom_nodes\ComfyUI-CX-ImageScramble"
```

```powershell
# 方式 B：目录联接（Windows 无需管理员，改仓库里的源码即时生效）
New-Item -ItemType Junction `
  -Path   "$env:COMFY_ROOT\custom_nodes\ComfyUI-CX-ImageScramble" `
  -Target "<本仓库路径>\integrations\comfyui\ComfyUI-CX-ImageScramble"
```

装完重启 ComfyUI，节点出现在 **`CX-E2EE/图片混淆`** 分类下：

| 节点 | 用途 |
|---|---|
| `CX 图片区域混淆（打码）` | 图 + 区域（SEGS/BBOX/MASK/aabb）→ 打码图 + 实际打码块的 MASK |
| `CX 图片区域还原` | 打码图 + **同一个密码** → 原图（区域坐标与密码都一致才能还原） |

依赖只有 `numpy`；ComfyUI 本体已带。**只用 V3 节点入口**（`comfy_entrypoint`），
故意不导出 V1 的 `NODE_CLASS_MAPPINGS`：ComfyUI 的加载器见到 V1 映射就直接 `return`，
会跳过 V3 入口。已在 ComfyUI 0.36.0 与 0.25.1 两套环境实测加载通过。

## 验证

`tests/` 的五个脚本，用 ComfyUI 自带的 python 跑（需要 `numpy`；带 node 的两个还要 node）：

```bat
set PKG=integrations\comfyui\ComfyUI-CX-ImageScramble

:: 1) 与网页端 JS 逐位等价（真源自动定位到本仓库 src/image-crypto.js，需 node）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_parity.py
::    hash / rng / perm 对照 + regionEnc 40 组（unit 8|16 × soft × 加解密双向 × 越界/极小框）逐字节一致

:: 2) 边框元数据层：与网页端 JS 逐字节对照 + 「只给图 + 密码」闭环（需 node）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_meta.py

:: 3) 打框数据 → 区域（SEGS / BBOX / MASK / aabb，纯 numpy，不需要 ComfyUI）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_regions.py

:: 4) 节点级：V3 入口加载 / schema / execute / 非法输入 / 灰度
set CX_COMFY_ROOT=%COMFY_ROOT%
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_nodes.py

:: 5) 示例工作流能否被前端正常打开（加了 --server 还会核对控件顺序与必填项）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_workflows.py --server http://127.0.0.1:8188

:: 6) 真服务端端到端（aabb / MASK / SEGS 三条链路，需先起服务）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_e2e_server.py --server http://127.0.0.1:8188
```

`test_parity.py` / `test_meta.py` **不再写死路径**：`tests/js_parity/cx_src.py` 会按
`--src` → `CX_E2EE_SRC` → `CX_E2EE_ROOT` → 从包位置逐级向上找 `src/image-crypto.js`
的顺序定位真源，找不到就把所有找过的路径列出来报错——对照测试宁可失败，
也不接受"没找到源就当通过"。

## 与网页端的边界（有意留白，不是漏项）

- **JPEG 路径（`qv3 < 100`）没移植**：网页端那条路是 64px 边框 + J2 拍屏鲁棒码
  （RS(255,127) + 四角 Finder + 单应校正），目标是被拍照/二次压缩后仍可解。
  节点这边只做了 PNG 路径（8px 边框 + R 通道 LSB）。所以**网页端导出的 JPEG 打码图，
  目前请在网页端还原**；节点产出的 PNG 打码图两端都能解。
- **`sortRegion` / 诱饵图（decoy）两个 PNG 增强开关没移植**（网页端默认关闭）。
- 元数据路线只装**矩形区域表**（与网页端格式一致），所以 `region_shape=mask`
  （按分割形状打码）不能同时写元数据；形状路线要还原就得两边喂同一份掩膜。
- 这是**混淆**而不是无损加密，往返有损（平滑照片 ≈ 50–60 dB，大面积纯饱和色 ≈ 23 dB）。
  这个损失来自算法本身（`Y` 压到 `[50,205]` 再加 ±40 扰动后 `YUV→RGB` 钳制），
  `test_parity.py` 用真 JS"自己加密再自己解密"跑同一张图得到同一个数值。

## 维护约定

- 改动 `src/image-crypto.js` 的 `hash` / `rng` / `perm` / `regionEnc` / `metaBytes` 等
  被抽取的方法后，请跑一次 `test_parity.py` 与 `test_meta.py`：
  **测试失败 = 节点与网页端已经不同步**，两边应当一起改（这正是这套对照存在的意义）。
- 本目录不改动本项目任何现有文件的行为；如果更希望它以别的位置或别的形态存在
  （或者上游觉得它不该留在主仓库），挪走/删掉都不影响其余部分，说一声即可。

## 署名与出处

- 算法、像素格式、边框元数据编码、密码语义（**只有一个密码**：seed = `hash(密码 + '#' + 区域序号)`）
  全部来自本项目 `src/image-crypto.js`，实现与参数以此为准；
  节点侧只做等价移植，协议解释权归本项目。
- 本目录由 [`@noname200506-a11y`](https://github.com/noname200506-a11y) 贡献。
- 仓库目前没有 LICENSE 文件，因此本目录**不单独声明许可**，随本项目现有约定处理。

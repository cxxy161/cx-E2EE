# models/detect — 自动打框用的检测模型

这里放「图片混淆」页上**自动打框**用的本地识别模型。浏览器只跑 ONNX，
所以丢进来的 Ultralytics `.pt` 权重会在服务端启动时被自动转译（见
`tools/detect-export.py` 与 `server/detect-models.js`）。

```
models/detect/
├── segm/     分割模型（有掩膜）：区域取「掩膜外接框」，比整框更贴合
├── bbox/     检测模型（只有框）：区域直接用框
└── build/    转译产物（自动生成，不入库）：<id>.fp32.onnx / <id>.int8.onnx / <id>.json
```

## 怎么用

1. 把权重放进 `segm/` 或 `bbox/`（`.pt` / `.pth` 都行；已经是 `.onnx` 的会直接采用）。
2. 重启服务，或者 `curl -X POST http://127.0.0.1:3000/api/detect/rescan`。
3. 浏览器打开「图片混淆」页 → V3 区域打码 → 展开「🧠 自动打框」→ 勾选模型 → 开始自动识别。

转译是**增量**的：源文件 sha256 + imgsz + opset 与 `build/<id>.json` 一致就跳过，
所以第二次启动几乎是零成本。要强制重转：`CX_DETECT_FORCE=1`。

## 为什么权重不入库

这些权重多为 **AGPL-3.0**（Ultralytics 系）或训练者自定义许可，且单个 20~100 MB；
仓库里只保留目录结构、说明与转译脚本。需要固定分发时请单独确认许可后再决定。
（`.gitignore` 已忽略 `segm/*`、`bbox/*`，只放行本目录的 README。）

## 依赖

转译需要一个装了 `torch` / `ultralytics` / `onnx` / `onnxruntime` 的 python。
最省事的做法是指向 ComfyUI 自带的解释器：

```bat
set CX_PYTHON=D:\ComfyUI-new\venv\Scripts\python.exe
python tools/detect-export.py --check
```

体检不过时「自动打框」会整条降级为不可用（页面会显示原因），**不影响**加密、解密、
公钥库等其他能力。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CX_PYTHON` | 自动探测 `python3` / `python` | 转译用的解释器 |
| `CX_DETECT_AUTOCONVERT` | `1` | `0` = 启动时只扫描不转译 |
| `CX_DETECT_FORCE` | `0` | `1` = 忽略缓存强制重转 |
| `CX_DETECT_IMGSZ` / `CX_DETECT_OPSET` | `640` / `17` | 导出参数（改了会让缓存失效，属预期） |
| `CX_DETECT_TIMEOUT_MS` | `600000` | 单模型转译上限 |

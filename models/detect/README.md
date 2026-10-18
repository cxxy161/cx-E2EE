# models/detect — 自动打框用的检测模型

这里放「图片混淆」页上**自动打框**用的本地识别模型。浏览器只跑 ONNX，
所以丢进来的 Ultralytics `.pt` 权重会在服务端启动时被自动转译（见
`tools/detect-export.py` 与 `server/detect-models.js`）。

```
models/detect/
├── segm/     分割模型（有掩膜）：区域取「掩膜外接框」，比整框更贴合
├── bbox/     检测模型（只有框）：区域直接用框
└── build/    构建产物：<id>.fp32.onnx / <id>.int8.onnx / <id>.json
              （本 fork 随库附带，见下节「附带内容」；<id>@<imgsz> 是多尺度构建）
```

## 怎么用

1. 把权重放进 `segm/` 或 `bbox/`（`.pt` / `.pth` 都行；已经是 `.onnx` 的会直接采用）。
2. 重启服务，或者 `curl -X POST http://127.0.0.1:3000/api/detect/rescan`。
3. 浏览器打开「图片混淆」页 → V3 区域打码 → 展开「🧠 自动打框」→ 勾选模型 → 开始自动识别。

转译是**增量**的：源文件 sha256 + imgsz + opset 与 `build/<id>.json` 一致就跳过，
所以第二次启动几乎是零成本。要强制重转：`CX_DETECT_FORCE=1`。

## 附带内容（本 fork 直接随库分发）

为了让「clone 下来就能用」，本分支把**权重与构建产物一并入库**
（单文件最大 39 MB，低于 GitHub 的 50 MB 提醒线与 100 MB 硬上限，不会卡住 push/PR）：

| 路径 | 体积 | 说明 |
|---|---|---|
| `segm/ntd11_nsfw_segm.pt` | 19.6 MB | YOLO11s-seg，7 类；`imgsz` 640 / 960 / 1280 三档构建都已在本目录下 |
| `bbox/foot_yolov8n.pt` | 6.0 MB | 演示用单类检测模型（脚） |
| `build/*.fp32.onnx` | 11~39 MB | 原精度：WebGPU 上最快（1152×1920 实测 42~51 ms） |
| `build/*.int8.onnx` | 3~11 MB | 动态量化：WASM 后端省流量（10.2 MB / 0.66~0.9 s 每帧） |
| `build/*.json` | 1 KB | 元数据：类别表 / task / imgsz / opset / 源 sha256 |

构建参数：`ultralytics export(format="onnx", imgsz=<640|960|1280>, opset=17, dynamic=False)`，
int8 为 `quantize_dynamic(QUInt8)`（只动权重；静态 QDQ 会把检测头量化掉、检出归零，故不用）。
想自己重建（例如换成别的权重）：

```bat
python tools/detect-export.py --src models/detect/segm/<权重>.pt --kind segm --imgsz 1280
```

`.gitignore` 里对应的忽略条目是**故意注释掉**的：想回到"权重不入库"的干净状态，
把那四行放开即可（面板会在缺模型时提示怎么补）。

**许可提醒**：权重多为 **AGPL-3.0**（Ultralytics 系）或训练者自定义许可。
随库附带只是为了方便自托管测试；要再分发或以其它方式使用，请先向原作者确认许可。
运行时的 ONNX Runtime（`src/vendor/ort/`）是 **MIT**（见其 `ort-LICENSE`）。

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

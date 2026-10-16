# models/detect/bbox — 检测模型

放**只有框、没有掩膜**的检测模型（Ultralytics YOLO 检测系列，或现成的 `.onnx`）。
自动打框直接用它的框作为打码区域（不做掩膜细化）。

本 fork **随库附带**一个演示用小模型（文件就在本目录）：

| 文件 | 说明 |
|---|---|
| `foot_yolov8n.pt` | YOLOv8n 微调，单类 `foot`；6.0 MB。随附 `build/foot_yolov8n.{fp32,int8}.onnx` 与 `build/foot_prebuilt.fp32.onnx`（后者是"只有构建产物、没有源权重"那种条目的样例） |

其它可用例子：`face_yolov8m.pt`（人脸）、`hand_yolov8s.pt`（手）。这类模型通常只关心
「有没有 + 在哪」，对打码来说够用，而且比分割模型轻。

放进来之后（`.pt` 会被自动转译；已经是 `.onnx` 的会直接采用）：

```bat
copy "D:\路径\某人脸检测.pt" models\detect\bbox\
curl -X POST http://127.0.0.1:3000/api/detect/rescan
```

注意点：

- 纯检测模型的框往往**比目标紧**（例如人脸框不含下巴/耳朵），打码后边缘可能残留特征；
  页面上的「识别框扩张」默认 1.25×，可按需加大。
- 大模型（`face_yolov8m` 约 52 MB → ONNX 约 104 MB）不适合直接走网页：转译脚本会同时产出
  动态量化 int8（约 1/4 体积），页面默认按后端自动挑选（WebGPU 用 fp32、WASM 用 int8）。
  仍嫌大就换 `n`/`s` 尺寸的权重。

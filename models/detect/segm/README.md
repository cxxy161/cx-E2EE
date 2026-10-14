# models/detect/segm — 分割模型

放**带掩膜**的分割模型（Ultralytics YOLO-seg 系列）。自动打框取「掩膜外接框」作为打码区域，
比整个检测框更贴合目标；掩膜为空时才退回检测框。

已验证过的例子（本机实拍数据，非仓库附带）：

| 权重 | 架构 | 类别 | fp32 ONNX | int8 ONNX | 备注 |
|---|---|---|---|---|---|
| `ntd11_anime_nsfw_segm_v5-variant1.pt` | YOLO11s-seg / 10.07M 参数 | nipples / pussy / anus / penis / cross-section / x-ray / testicles | 38.7 MB | 10.2 MB | 1152×1920 实测：fp32+WebGPU 42~51 ms、int8+WASM 0.66~0.9 s |

放进来之后（`.pt` 会被自动转译；已经是 `.onnx` 的会直接采用）：

```bat
copy "D:\路径\某分割模型.pt" models\detect\segm\
curl -X POST http://127.0.0.1:3000/api/detect/rescan
```

注意点：

- 类别名以权重自带为准，会写进 `build/<id>.json` 供页面显示；**页面上的部位名只做展示**，
  同一处被多个类各框一次是常见现象（实测 `pussy` / `anus` 会互相抢同一个位置），
  所以默认按「敏感部位」合并处理，不按类别分级。
- 分割掩膜分辨率来自模型原型（YOLO-seg 为 160×160），小目标的掩膜外接框可能比检测框略小，
  页面上的「识别框扩张」就是给这种情况兜底的。

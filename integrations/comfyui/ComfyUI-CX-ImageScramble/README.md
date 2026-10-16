# ComfyUI-CX-ImageScramble

把 **cx-E2EE（C-X 安全终端）** 的「图片混淆 / 区域打码」算法做成 ComfyUI 自定义节点，
并且**直接吃检测模型输出的打框数据**（SEGS / BBOX / 掩膜），不需要手写坐标。

> 本目录位于 cx-E2EE 仓库的 `integrations/comfyui/` 下（集成总览见
> [`../README.md`](../README.md)）。它是可选的外围集成：装在 ComfyUI 的 `custom_nodes/`
> 下即可用，删掉不影响仓库其余部分。

- 算法来源：本仓库 `src/image-crypto.js` 的 V3 区域打码
  （`IA.hash` / `IA.rng` / `IA.perm` / `IA.regionEnc`，以及 PNG 边框元数据的读写）
- 本包是 **Python + NumPy 的逐位等价移植**：同样的图 + 同样的区域 + 同样的密码/种子，
  输出与浏览器端 **逐字节相同**（由 `tests/test_parity.py` 用真 JS 实现对照证明）。
- 在此之上加了「块级门（block gate）」：`region_shape=mask` 时按分割掩膜形状逐块打码，
  而不是只打一个矩形。

## 1.1.1 改了什么（相对 1.1.0）

- **没标记框不再打断工作流**：`no_region_policy` 的默认值从 `error` 改成 `passthrough` ——
  检测器在某张图/某一帧没检到框、`label_filter` 把框全过滤掉、掩膜为空、框太小或全在图像外，
  以及「只给图 + 密码」还原时图里没有元数据，这些都**原图直出**（IMAGE 原样透传、MASK 全 0）+ 控制台告警，
  批处理里不会再因为一张没框的图整批中断。老行为（尽早报错）把 `no_region_policy` 设成 `error` 即可；
  **密码不对依旧报错**（那是数据完整性问题，不静默）。
- **标记框的缩放 / 合并交给外部节点**（本节点不新增「框缩放」参数），并补上实测：
  新增示例工作流 [`workflows/cx-e2ee-scramble-boxscale.json`](workflows/cx-e2ee-scramble-boxscale.json)、
  [`workflows/cx-e2ee-scramble-boxmerge.json`](workflows/cx-e2ee-scramble-boxmerge.json) 与实测脚本
  [`tests/test_segs_tools.py`](tests/test_segs_tools.py)，节点与数字见下面「标记框的缩放 / 合并」一节。

## 节点

| 节点 | 输出 |
|---|---|
| **CX 图片区域混淆（打码）** `CX_RegionScramble` | `IMAGE` + `MASK`（实际被打码的块，接 `MaskPreview` 可核对） |
| **CX 图片区域还原** `CX_RegionUnscramble` | `IMAGE` + `MASK` |

### 输入

| 参数 | 类型 | 说明 |
|---|---|---|
| `image` | IMAGE | 要处理的图，支持批次（逐帧处理）。只动前 3 通道，alpha 原样保留 |
| **`segs`** | **SEGS** | **检测模型输出的打框数据**（bbox 模型 / segm 模型都汇成 SEGS）。支持 `((H,W), [SEG,…])` 与裸 `list[SEG]` |
| `bbox` | BBOX | 通用框数据：`[(x,y,w,h),…]` / `(N,4)` 张量 / 带 `.bbox` 的对象 / `dict{'bboxes':…}` |
| `mask` | MASK | 掩膜（SAM / 分割模型 / MaskEditor）。批次 1 帧广播到整批，或与 image 帧数相同 |
| `aabb` | STRING | 手写兜底（没接打框数据时才用）。格式见下 |
| `int (key)` | INT | 整数形式的密钥。**不是第二个密码**：密码只有一个（见下） |
| `region_shape` | COMBO | `bbox`＝只用框的矩形范围（＝网页端行为）；`mask`＝再用掩膜做块级门，按分割形状打码 |
| `pad` | INT | 框四边外扩像素（检测框常偏紧，4~16 可盖住边缘） |
| `max_regions` | INT | 最多用多少个区域（超出按稳定排序截断，控制台给提示） |
| `mask_threshold` | FLOAT | 块级门阈值：块内掩膜占比 ≥ 该值的块才参与打码（0.5 = 多数表决） |
| `label_filter` | STRING | 只取这些 label（逗号/空格分隔，不区分大小写）。留空=全部 |
| `sort_regions` | BOOLEAN | 按 `(label,y,x,w,h)` 稳定排序后再分配 seed，使结果与检测器返回顺序无关（建议开） |
| `no_region_policy` | COMBO | 解析出 0 个区域时怎么办（没检到标记框 / `label_filter` 全过滤掉 / 掩膜为空 / 框太小或全在图像外）：`passthrough`＝**默认**，原图直出（IMAGE 原样、MASK 全 0）+ 控制台告警，某张图或某帧没框时不中断整批；`error`＝直接报错（想尽早暴露接线/参数写错时选它） |
| `embed_meta` | BOOLEAN | **打码时**把区域表写进外扩 8px 边框（LSB），输出＝网页端那种「自带怎么还原」的图；**还原时不用勾**（没接打框数据就自动去读） |
| `unit` / `soft` | COMBO / BOOL | 置换单元边长（8=PNG 路径 / 16=JPEG 拍屏路径）；JPEG 友好亮度域 |
| `password` | STRING | **唯一密码**（网页端也是只用这一个）。填了它，`int (key)` 被忽略 |
| `box_mode` | COMBO | 四个数字怎么解释：`xywh`(默认) / `xyxy`。作用于 `aabb` 文本与 `bbox` 口 |

**优先级**：`segs` > `bbox` > `mask` > `aabb`（同时连多个时只用优先级最高的那个，控制台会提示忽略了谁）。
四个都没给 → 走 `no_region_policy`（默认原图直出，不报错）。

### 打框数据的几个实测口子（踩过的坑）

- **SEGS 的实际形态是 `((H, W), [SEG, ...])` 元组**，不是裸 list（`core.mask_to_segs` / 检测器的返回值都是这样）。
  两种都收。
- **`SEG.bbox` 是 `(x1, y1, x2, y2)`（xyxy）**，与 `crop_region` 同坐标系 —— 用 `MaskToSEGS` 实测确认：
  `bbox=(330,250,460,330)`、`cropped_mask.shape=(80,130)`（= y2-y1, x2-x1）。本包按 xyxy 换算；
  若遇到第 3/4 个数比第 1/2 个数还小的数据，自动按 xywh 兜底。
- `region_shape=mask` 时，掩膜取自 `SEG.cropped_mask` 按 `SEG.crop_region` 拼回全图（两者尺寸不一致时最近邻适配）。
- 纯 bbox 检测器的 `cropped_mask` 通常是整块 1，此时 `mask` 口径自然退化成矩形。
- `sort_regions` 建议保持开启：检测器每次返回的框顺序可能不同，开了之后 seed 只跟框的几何/标签有关，
  同一批框打乱顺序也能对上（`tests/test_regions.py` 有专门验证）。

### 典型接线

```
UltralyticsDetectorProvider ──(BBOX_DETECTOR / SEGM_DETECTOR)──┐
                                                              ├─→ ImpactSimpleDetectorSEGS / BBOXDetectorSEGS
LoadImage ────────────────────────────────────────────────────┘        │
                                                                       ├─→ CX_RegionScramble(segs=…)  ← 打码
LoadImage（同一张）─────────────────────────────────────────────────────┤
                                                                       └─→ CX_RegionUnscramble(segs=…) ← 还原
```

分割路线：`SAM / 分割模型 → MASK → CX_RegionScramble(mask=…, region_shape=mask)`。
建议把 `segs` / `mask` 用同一条连线分别接到两个 CX 节点（不要各跑一次检测器）。

### 标记框的缩放 / 合并：交给**外部节点**（本包不掺和框的加工）

本节点**不提供**「框缩放倍数」这类参数 —— 标记框的加工留在 SEGS 线上，用现成节点做，本节点只按最终区域打码。
（我们的 `pad` 只是「四边各外扩 N 像素」的手感微调；比例缩放 / 合并 / 去重请用下表的外部节点。）

| 想做的事 | 现成节点（本机 ComfyUI-Impact-Pack V8.28.3 实测可用） | 接法 |
|---|---|---|
| **按轴心缩放**（框中心不动、宽高按比例） | `ImpactScaleBy_BBOX_SEG_ELT`（`scale_by` 0.01~8.0） | `SEGS → ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT → ImpactAssembleSEGS → SEGS`（见下） |
| **标记框合并**（多框 → 1 框：bbox 并集、掩膜并集、label=`merged`） | `ImpactSEGSMerge` | `SEGS → ImpactSEGSMerge → CX(segs=…)` |
| 拼接两批框 | `ImpactSEGSConcat` | `SEGS1 + SEGS2 → ImpactSEGSConcat`（UI 里由 Impact 的 JS 动态加口；脚本/API 直接写 `segs2`） |
| 重叠去重 | `ImpactSEGSNMSFilter`（按掩膜 IoU） | `SEGS → ImpactSEGSNMSFilter(iou_threshold) → CX` |
| 只要最大的那个框 | `ImpactSEGSOrderedFilter` / `ImpactSEGSRangeFilter` | `target=area(=w*h)` 排序/范围过滤 |
| 数一下检到几个框 | `ImpactCount_Elts_in_SEGS` → `PreviewAny` | 出文本，UI 上直接看（`0` = 没框 → 本节点默认原图直出） |
| 掩膜膨胀/收缩（像素级，不是比例） | `ImpactDilateMaskInSEGS`（±512） | 只改 `cropped_mask`，**bbox 不动** → `region_shape=bbox` 时无效果，`region_shape=mask` 才影响打码形状 |

`ImpactScaleBy_BBOX_SEG_ELT` 是 **SEG_ELT 级**节点（一次一个框），所以必须配
`ImpactDecomposeSEGS`（`SEGS → (SEGS_HEADER, [SEG_ELT…])`，第二个输出是列表）+ `ImpactAssembleSEGS`
（`INPUT_IS_LIST`，装回 SEGS）：ComfyUI 会自动把列表逐项喂给它，不用手写循环。

```
BboxDetectorSEGS ─SEGS─► ImpactDecomposeSEGS ─┬─(SEG_ELT 列表)─► ImpactScaleBy_BBOX_SEG_ELT(scale_by=1.5)─┐
                                             └─(SEGS_HEADER)─────────────────────────► ImpactAssembleSEGS ─┴─SEGS─► CX_RegionScramble
```

缩放规则（Impact 源码 `modules/impact/segs_nodes.py` 的 `doit`）：
`dw = int((w*scale_by - w)/2)`、`dh = int((h*scale_by - h)/2)`、`bbox = (x1-dw, y1-dh, x2+dw, y2+dh)`
—— **以框中心为轴**按比例缩放；`crop_region` 不动，掩膜在新框之外清零。

**实测数字**（`tests/test_segs_tools.py`，真服务端跑，逐像素与 `cx_core` 参考核对）：

| 操作 | 框数 | 有效打码块 | 结论 |
|---|---|---|---|
| 不后处理（掩膜 3 个斑块 → `MaskToSEGS`） | 3 | 14912 px | 基线 |
| `ImpactScaleBy_BBOX_SEG_ELT(1.5)` | 3 | 33024 px | 中心不变（0 偏差）、尺寸 ×1.5（±0 块） |
| `ImpactScaleBy_BBOX_SEG_ELT(0.6)` | 3 | 6144 px | 中心不变、尺寸 ×0.6 |
| `ImpactSEGSMerge` | 1 | 101376 px（外接框口径）/ 14208 px（掩膜口径） | bbox 与掩膜都取并集，label=`merged` |
| `ImpactSEGSConcat`（同一份接两次） | 6 | 14912 px | 重合框叠加，区域不变 |
| `ImpactSEGSConcat` → `ImpactSEGSNMSFilter(0.5)` | 3 | 14912 px | 回到基线，打码结果与基线**逐像素相同** |

三条容易踩的地方：

1. **还原端必须接同一份「加工后」的 SEGS**（缩放/合并之后那份）。把后处理结果拉两条线，分别接打码和还原，
   别在还原端重跑一遍检测器。
2. **`region_shape=mask` 时放大框不会增加打码面积**：`ImpactScaleBy_BBOX_SEG_ELT` 只把掩膜在新框之外清零，
   放大后掩膜照旧，而本节点的门只看掩膜 → 想真多打一点，用 `ImpactDilateMaskInSEGS`（像素级膨胀）
   或改 `region_shape=bbox`。
3. **合并后是「一个框 + 一张并集掩膜」**：`region_shape=bbox` 连两个斑块之间那片也一起打（实测 101376 px），
   只想打分割形状就配 `region_shape=mask`（实测 14208 px）。
   另外 `ImpactSEGSMerge` 在**空 SEGS** 上会造出一个畸形框（`crop_region=(maxsize,…0,0)`），本节点会整个丢掉
   → 走 `no_region_policy`（默认原图直出），不会报错。

### `aabb` 文本格式（手写兜底 / 与网页端互通时用）

```
100,50,64,64                    # x,y,w,h（默认）；多区域用 ; 或换行分隔
100,50,164,114                  # box_mode=xyxy 时按 x1,y1,x2,y2 读
[[10 10 20 20] [30 30 10 10]]   # 括号 + 空格也认
all                             # 整张图
```

坐标会先按 `unit` 向下对齐到整块：`aabb=(101,57,200,150)` 在 `unit=8` 下的**实际影响范围**是
`(96,56,304,208)`（节点会打印到控制台，第二个 MASK 输出也能直接看到）。
数字个数不对 / 宽高非正 / 完全在图像外 → 报错，不静默。

## 实拍效果（`docs/img/`）

| 文件 | 展示 |
|---|---|
| `docs/img/demo-aabb.png` | aabb 手写坐标：输入 / 打码 / 还原 |
| `docs/img/demo-boxes.png` | 打框数据（SEGS/MASK）：输入 / 节点 MASK 输出（实际打码的块）/ 打码 / 还原 |
| `docs/img/demo-meta.png` | 元数据路线：输入 / 打码图（外扩 8px 边框，区域表在边框里）/ **只给这张图 + 密码**还原 |

## 怎么连（三条路线，都在真机上验证过）

现成的示例工作流（已生成并在 aki/8188 上真跑通，可直接拖进 ComfyUI 或从「工作流」列表打开）：

| 文件 | 路线 |
|---|---|
| [`workflows/cx-e2ee-scramble-detect.json`](workflows/cx-e2ee-scramble-detect.json) | **bbox 检测模型**：`LoadImage → UltralyticsDetectorProvider → BboxDetectorSEGS → CX(segs=…)` |
| [`workflows/cx-e2ee-scramble-mask.json`](workflows/cx-e2ee-scramble-mask.json) | **分割掩膜**：`LoadImage(原图) + LoadImage(掩膜图) → ImageToMask → MaskToSEGS → CX(segs=…)` |
| [`workflows/cx-e2ee-scramble-aabb.json`](workflows/cx-e2ee-scramble-aabb.json) | **手写坐标**：`LoadImage → CX(aabb=…)` |
| [`workflows/cx-e2ee-scramble-meta-write.json`](workflows/cx-e2ee-scramble-meta-write.json) | **打码 + 写元数据**：`LoadImage → CX(aabb=…, embed_meta=True) → SaveImage`（输出＝网页端那种自带区域表的打码图） |
| [`workflows/cx-e2ee-scramble-meta-read.json`](workflows/cx-e2ee-scramble-meta-read.json) | **只给图 + 密码还原**：`LoadImage(打码图) → CX_RegionUnscramble(只填 key)` |
| [`workflows/cx-e2ee-segm-roundtrip.json`](workflows/cx-e2ee-segm-roundtrip.json) | **一体验证**：segm 模型（`segm/person_yolov8m-seg.pt`）→ 打码（元数据版 + 形状版两条支路）→ 元数据那条**只给「图 + 密码」**就还原，跑一遍同时验证"segm 打码"与"纯图+密码解码" |
| [`workflows/cx-e2ee-scramble-boxscale.json`](workflows/cx-e2ee-scramble-boxscale.json) | **标记框按轴心缩放（外部节点）**：`BboxDetectorSEGS → ImpactDecomposeSEGS → ImpactScaleBy_BBOX_SEG_ELT(1.5) → ImpactAssembleSEGS → CX`，另带 `ImpactCount_Elts_in_SEGS → PreviewAny` 看框数 |
| [`workflows/cx-e2ee-scramble-boxmerge.json`](workflows/cx-e2ee-scramble-boxmerge.json) | **标记框合并（外部节点）**：`BboxDetectorSEGS → ImpactSEGSMerge → CX`（外接框口径 + 掩膜口径两条支路，另留一条不合并的对照） |

同一目录还有 `*.api.json`（同拓扑的 API 格式，脚本用）。生成脚本：`tests/make_workflow.py`
（控件顺序是从目标服务 `/object_info` 读出来的，不手写，换 ComfyUI 版本也不会错位）。
工作流文件有一项**前端契约**：`extra` 里**不要**写 `ds`。
前端 `loadGraphData→fitView` 的写法是

```js
e.extra?.ds ? (this.canvas.ds.offset = e.extra.ds.offset, this.canvas.ds.scale = e.extra.ds.scale, ...)
            : useLitegraphService().fitView()
```

只要 `extra.ds` 存在就会执行 `canvas.ds.offset = extra.ds.offset`，而
`DragAndScale.set offset(e){this.state.offset[0]=e[0]}` 中任一侧缺字段都会抛
`TypeError: Cannot read properties of undefined (reading '0')`，导致**工作流打不开**。
不写 `ds` 就永远走安全的 `useLitegraphService().fitView()`（自动适配视图）；
`LGraph` 自身 `extra` 初始化为 `{}`，所以 `"extra": {}` 也安全。
`tests/test_workflows.py` 专门守这条（以及链接/槽位/控件顺序）。

### 路线 1：bbox / segm 检测模型（你要的那种）

```
LoadImage ──────────────IMAGE─────────────┬──────────────► CX_RegionScramble.image
                                          │                      │
UltralyticsDetectorProvider               │                      ├─IMAGE─► SaveImage
   └─BBOX_DETECTOR─► BboxDetectorSEGS ────┼──SEGS────────────────┤
        (bbox 模型)      ▲                │                      └─MASK──► MaskToImage ─► PreviewImage
                         │                │
LoadImage ───IMAGE───────┘                └──────────────► CX_RegionUnscramble.image
                                                         ▲
                    BboxDetectorSEGS ────SEGS────────────┘   ← 注意：同一份 SEGS
```

- 节点名（你的 GUI 里就这些）：`UltralyticsDetectorProvider`（bbox 模型选 `bbox/face_yolov8m.pt` 这类）
  → `BboxDetectorSEGS`（**bbox 模型**）或 `SegmDetectorSEGS`（**segm 模型**，如 `segm/person_yolov8m-seg.pt`）
  → 输出 `SEGS` → 接 `CX_RegionScramble.segs`。
- 也可以走 `ImpactSimpleDetectorSEGS`（bbox 检测 + SAM/segm 细化，输出同样是 SEGS）。
- **一条 SEGS 线同时喂给打码节点和还原节点**：`BboxDetectorSEGS.SEGS` 拉两条线，分别接
  `CX_RegionScramble.segs` 和 `CX_RegionUnscramble.segs`。这样两边拿到的是同一份框，
  不会因为检测器两次输出不同而还原失败。
- 想只处理（比如）脸：给 `BboxDetectorSEGS.labels` 填 `face`，或在 CX 节点上用 `label_filter`。
  想少检点：把 `threshold` 调高；框太紧：`pad` 给 4~16；`crop_factor` 保持 1.0 最合适（只影响 crop，不影响打码区域）。
- 只想打**矩形**（与网页端口径一致）：`region_shape=bbox`；想让 segm 模型按**分割形状**打码：`region_shape=mask`。
- `region_shape=mask` + 纯 bbox 模型时，`cropped_mask` 是整块 1，会自动退化成矩形，不会出错。

### 路线 2：分割掩膜（SAM / 分割模型 / 遮罩编辑器）

```
LoadImage(原图) ─IMAGE─────────────────────────────► CX_RegionScramble.image
LoadImage(掩膜图) ─IMAGE─► ImageToMask(red) ─MASK─┐
                                                  ├─► MaskToSEGS ─SEGS─► CX_RegionScramble.segs
                                                  └─► 或直接接 CX_RegionScramble.mask（region_shape=mask）
```
`mask` 口也可以直接吃 SAM/分割节点的 MASK 输出，不必过 `MaskToSEGS`（这时区域＝掩膜外接框 + 掩膜做块级门）。
`combined=False` 时 `MaskToSEGS` 会给每个连通块一个 SEG；`combined=True` 则整张掩膜算一个。

### 路线 3：手写坐标（没有检测器时）

```
LoadImage ─IMAGE─► CX_RegionScramble(aabb="101,57,200,150") ─IMAGE─► SaveImage
                                                             └─MASK──► MaskToImage ─► PreviewImage
```

### 通用要点

- **第二个输出 `MASK` 一定要看一眼**：`CX_RegionScramble.MASK → MaskToImage → PreviewImage`，
  预览里白色的地方就是实际会被打码的块。打框数据接错了这里立刻能看出来。
- 还原节点的所有参数要与打码节点**逐项一致**（key/region_shape/pad/max_regions/label_filter/
  sort_regions/unit/soft/password/box_mode），建议直接把打码节点的参数复制过去，或两边都用同一份工作流里复制出来的节点。
- 检测器某帧没检到东西时，默认就会**原图直出**（`no_region_policy=passthrough`，IMAGE 原样、MASK 全 0，
  控制台给告警）：批处理里某一帧没有标记框不会中断整批。想让它报错就显式把 `no_region_policy` 设成 `error`。
- 走 API/脚本调用时注意：ComfyUI 的 prompt 校验**不会**给 required 输入补默认值，所有 required 都要显式给
  （见 `workflows/*.api.json`）。

## 还原只要「图 + 密码」（与网页端一致）

网页端加密时会把**区域表 + 签名**写进图片自带的边框里，所以解密只需要那张图加密码。
本节点现在同样支持：

```
打码：CX_RegionScramble(embed_meta=True)   输出 = 外扩 8px 边框 + 原图居中，区域表写在边框像素 R 通道 LSB
      ↓ 存成 PNG（必须无损：PNG、不要缩放、不要再压 JPEG）
还原：CX_RegionUnscramble  ← 只接 这张图 + 同一个 key/密码，segs/bbox/mask/aabb 一个都不用接
      → 自动读出区域表 → 用密码重算签名比对（不符就报「密码不对」）→ 逆变换 → 裁掉边框
```

实测（真 ComfyUI 服务端，`tests/test_e2e_server.py` 第 7 段）：`LoadImage → CX(embed_meta) → SaveImage`
存盘后再 `LoadImage → CX_RegionUnscramble(只填 key) → SaveImage`，还原尺寸、质量、区域外像素都与显式传
`aabb` 的结果一致；错 key 报「签名不符」。

几条硬约束：

- **必须全程无损**：元数据是像素最低位，任何 JPEG 重压、缩放、颜色调整都会抹掉它（网页端也是这个前提）。
- 元数据只存**矩形区域表**，所以 `embed_meta=True` 会强制 `region_shape=bbox`、`unit=8`、`soft=False`（会打印提示）；
  用 `region_shape=mask`（分割形状）就不适合走元数据路线。
- 区域数上限 12（网页端同一上限），超出会截断并提示。
- 写出的元数据与网页端**逐字节相同**（`metaBytes` / `borderOrd` / `wMetaPng` / `rMetaPng` / `parseMeta`
  都做了与真 JS 的对照，见 `tests/test_meta.py`）；因此这张打码图在网页端也应能被同一个密码解开。
- **还没做的**：网页端的 **JPEG（qv3<100）路径**用的是 64px 边框 + J2 拍屏鲁棒码（RS(255,127) +
  四角 Finder + 单应校正）。那套还没移植，所以「网页端存的 JPEG 打码图」目前还不能在本节点里读。

## 密钥只有一个（与网页端一致）

网页端加密和解密都只用**一个密码** k，区域 seed = `IA.hash(k + '#' + 区域序号)`。
本节点完全照此实现，`int (key)` 只是同一个秘密的整数写法糖：

| 你填的 | 实际用的秘密 | 区域 seed |
|---|---|---|
| `password="pw"`（`key` 随便） | `"pw"` | `hash("pw#0")`, `hash("pw#1")`, … |
| `password=""`, `key=12345` | `"12345"` | `hash("12345#0")`, … |
| `password="12345"`, `key=0` | `"12345"` | **与上一行完全相同** |

所以 `key=12345` ⇔ `password="12345"`：打码用一个、还原用另一个，照样能还原
（`tests/test_regions.py` 第 12 段有交叉验证）。**两者同时给时 `password` 生效**，
`key` 被忽略 —— 控制台会打印 `密码来源=password（唯一秘密 = …）` 并显式告警，不会静默。
每次执行还会打印 `seed[0]=…`，方便你在浏览器控制台里用同一密码核对。

原来 `int` 与 `password` 并列看起来像两个密码，这个锅在 UI 描述上，现在两处都写明了。

## 与 cx-E2EE 网页端互通

1. **直接填密码**（推荐）：`password = 网页端密码`，区域用 `aabb` 给原图像素坐标。
2. 自己算种子：`key = cx_core.region_seed(0, "你的密码", 区域序号)`。

网页端产物是「外扩边框 + 原图居中」，要先裁边框（`ImageCrop`）再喂进本节点：

- 网页端输出 **PNG**（`qv3=100`）：去掉四周 `8px`；`unit=8`、`soft=false`、`region_shape=bbox`。
- 网页端输出 **JPEG**（`qv3<100`）：去掉四周 `64px`；`unit=16`、`soft=true`、`region_shape=bbox`。
  JPEG 路径原设计配合四角 Finder 做透视校正，拍屏/二次压缩过的图建议仍用网页端扫码还原。

## 算法要点（也是使用时必须知道的四件事）

单区域处理：区域按 `unit` 对齐成整块 → `seed` 驱动 xorshift32 PRNG 做 Fisher-Yates **块级置换** →
每块一组同源扰动参数（亮度偏移 `ns`、U/V 取反、U/V 互换）→ `RGB→YUV`，`Y` 压到 `[50,205]`
（soft：[20,235]）加 `ns`，色度翻转，`YUV→RGB`，按 `Uint8ClampedArray` 语义落值。

1. **还原必须参数全同**：打框数据（同一份 SEGS/BBOX/MASK，或同一段 aabb）、`key`/`password`、
   `region_shape`、`pad`、`max_regions`、`label_filter`、`sort_regions`、`mask_threshold`、`unit`、`soft`
   任一不同 → 出来的是噪声。多区域重叠时加密正序、解密倒序（与网页端一致）。
2. **建议缓存复用打框数据**：不要把检测器接成两条独立支路各跑一次；框变了就对不上。
   开了 `sort_regions` 能免疫「顺序变化」，但免疫不了「框本身变化」。
3. **这是「混淆」不是无损加密**：`Y` 压到 `[50,205]` 再加 ±40 扰动，极端饱和色在 `YUV→RGB` 时被钳制，
   所以还原**有损**：平滑照片往返 PSNR ≈ 50~60dB（肉眼几乎无损），含大面积纯饱和色块的图 ≈ 23dB。
   这个损失是 cx-E2EE 算法自身固有的 —— `tests/test_parity.py` 用真 JS「自己加密再自己解密」跑同一张图，
   结果与本实现**逐字节相同**。
4. **块级门的取舍**：`region_shape=mask` 只打掩膜覆盖的块，形状更贴合，但置换表建在「被选中的块」之间，
   所以掩膜必须一致；`region_shape=bbox` 只用框，鲁棒性更好（也与网页端等价）。

网页端的「色块排序（sort）」「诱饵图（decoy）」两个 PNG 增强开关未移植（默认关闭），需要时可照
`image-crypto.js` 的 `sortRegion` / `decoy*` 继续补。

## 安装与验证

节点包必须出现在 ComfyUI 的 `custom_nodes/` 下（ComfyUI 只扫描那里）。仓库内这份是唯一真源，
建议用**目录联接**挂过去（Windows 无需管理员，改源码即时生效）：

```powershell
New-Item -ItemType Junction `
  -Path   "$env:COMFY_ROOT\custom_nodes\ComfyUI-CX-ImageScramble" `
  -Target "<本仓库路径>\integrations\comfyui\ComfyUI-CX-ImageScramble"
```

也可以直接 `xcopy /E /I` 拷一份过去（多套 ComfyUI 时就是多份副本，注意同步）。

> 本包**只用 V3 入口**（`comfy_entrypoint`），故意不导出 `NODE_CLASS_MAPPINGS`：
> ComfyUI 的加载器见到 V1 的 `NODE_CLASS_MAPPINGS` 就 `return`，会跳过 V3 入口。
> 已在 **ComfyUI 0.36.0**（ComfyUI-new）与 **0.25.1**（aki 整合包）两套环境实测加载通过。

六组验证（都用 ComfyUI 自带 python 跑；`PKG` 指本目录，直接在仓库里跑也行）：

```bat
set COMFY_ROOT=D:\ComfyUI-new
set PKG=%COMFY_ROOT%\custom_nodes\ComfyUI-CX-ImageScramble
:: 仓库内跑就用：set PKG=<本仓库路径>\integrations\comfyui\ComfyUI-CX-ImageScramble

:: 1) 与 cx-E2EE 网页端 JS 实现逐位等价（需要 node；真源自动定位到仓库 src/image-crypto.js）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_parity.py

:: 2) V3 元数据层：与网页端 JS 逐字节对照 + 「只给图+密码」闭环（需要 node）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_meta.py

:: 2b) 打框数据链路：SEGS / BBOX / MASK / aabb（纯 numpy，不需服务）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_regions.py

:: 3) 节点级：schema / 注册 / execute / 非法输入 / 灰度（不在 custom_nodes 下跑时给 CX_COMFY_ROOT）
set CX_COMFY_ROOT=%COMFY_ROOT%
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_nodes.py

:: 3b) 工作流文件能否被前端正常打开（给了 --server 还会核对控件顺序/必填项）
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_workflows.py --server http://127.0.0.1:8195

:: 4) 端到端：真服务跑 aabb / MASK / SEGS 三条链路（需先起服务）
::    venv\Scripts\python.exe main.py --port 8195 --cpu
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_e2e_server.py --server http://127.0.0.1:8195

:: 5) 标记框后处理（外部 Impact 节点：按轴心缩放 / 合并 / 拼接 / 去重 / 空框直出）× 本节点
::    需要服务端装了 ComfyUI-Impact-Pack；缩放的数学、合并的口径、空框直出都在这里实测
%COMFY_ROOT%\venv\Scripts\python.exe %PKG%\tests\test_segs_tools.py --server http://127.0.0.1:8195
```

`test_parity.py` / `test_meta.py` 不写死真源路径：`tests/js_parity/cx_src.py` 按
`--src` → `CX_E2EE_SRC` → `CX_E2EE_ROOT` → 从包位置逐级向上找的顺序定位 `src/image-crypto.js`，
找不到就列出全部候选路径报错（对照测试不允许"没找到源就当通过"）。
`test_nodes.py` 同理：自动向上找 ComfyUI 根（同时有 `main.py` 和 `comfy_api/` 的那层），
找不到会打印提示让你设 `CX_COMFY_ROOT`。换另一套 ComfyUI 试加载：`set CX_COMFY_ROOT=<那套根目录>`。

实测结果摘要：

| 测试 | 结果 |
|---|---|
| `hash` / `rng` / `perm` 与 JS 对照 | 全部一致（含中文密码） |
| `regionEnc` 40 组（unit 8/16 × soft × 加解密双向 × 全图/非对齐/越界/极小框/单块） | **逐字节相同** |
| 饱和色块图 JS「加密→解密」 vs 本实现 | **逐字节相同** |
| SEGS/BBOX/MASK 解析、形状门、pad/label/max_regions、顺序无关、多帧广播、错参数不可还原 | 全部通过 |
| 真服务端 `LoadImage→打码→还原→SaveImage`（aabb / ImageToMask+MASK / ImageToMask+MaskToSEGS 真 SEGS） | 输出与 NumPy 参考 `max\|Δ\|=0`，框外像素零改动，节点 MASK 输出与参考**逐像素相同** |
| 真服务端 元数据链路：打码(embed_meta)→存 PNG→只给图+key→还原 | 尺寸/质量/框外像素与显式 aabb 一致；错 key 报「签名不符」 |
| 元数据层 vs 网页端 JS | `metaBytes`/`borderOrd`/`wMetaPng` 写出像素**逐字节相同**，双向交叉可读 |
| 真服务端 标记框后处理（`test_segs_tools.py`）：`ImpactScaleBy_BBOX_SEG_ELT` 1.5×/0.6×、`ImpactSEGSMerge`、`ImpactSEGSConcat`、`ImpactSEGSNMSFilter` × 打码/还原 | 后处理后的区域与 `cx_core` 参考**逐像素相同**；缩放中心不变、尺寸按比例；合并后外接框=并集、掩膜口径=并集掩膜；NMS 去重后与基线逐像素等价；**空框默认原图直出** |

对照图脚本：`tests\make_demo.py --preset boxes`（或 `--preset aabb`）。

## 目录

```
ComfyUI-CX-ImageScramble/
├── __init__.py                     # V3 入口（comfy_entrypoint）
├── nodes.py                        # 两个节点的 schema / execute
├── cx_core.py                      # 算法核：JS 数值语义复刻 + hash/rng/perm + regionEnc(+块级门)
│                                   #          + 打框数据解析（SEGS/BBOX/MASK/aabb）
├── pyproject.toml                  # ComfyUI Registry 元数据
├── README.md
├── docs/img/                       # 3 张实拍对照图
├── workflows/                      # 八组示例工作流（UI 格式 + .api.json）
└── tests/
    ├── test_parity.py              # 与网页端 JS 的逐位等价性
    ├── test_meta.py                # V3 元数据层（区域表 LSB，与 JS 逐字节对照）
    ├── test_regions.py             # 打框数据 → 区域（SEGS/BBOX/MASK/aabb）
    ├── test_nodes.py               # 节点级测试
    ├── test_e2e_server.py          # 真服务端端到端（aabb / MASK / SEGS 三条链路）
    ├── test_segs_tools.py          # 标记框后处理交给外部节点（缩放/合并/拼接/去重）× 本节点，真服务实测
    ├── make_demo.py                # 生成对照图
    ├── make_workflow.py            # 生成/验证示例工作流
    ├── test_workflows.py           # 工作流文件的前端契约校验（能否被正常打开）
    └── js_parity/
        ├── cx_src.py               # 定位真源 src/image-crypto.js（仓库内/节点目录两种位置都能找）
        ├── make_ref_impl.py        # 从 image-crypto.js 原样抽取 hash/rng/perm/regionEnc/metaBytes…
        ├── ref_impl.mjs            # 自动生成的 JS 参考实现
        ├── ref_harness.mjs         # 用 JS 参考实现处理裸 RGBA 字节
        ├── ref_meta.mjs            # 元数据层的 JS 对照装置
        └── ref_probe.mjs           # hash / perm / rng 对照值
```

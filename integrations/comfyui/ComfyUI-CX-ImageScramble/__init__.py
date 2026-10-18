# -*- coding: utf-8 -*-
"""
ComfyUI-CX-ImageScramble — CX 图片区域混淆（打码 / 还原）自定义节点

节点：
    CX_RegionScramble    输入 IMAGE + aabb + int(key) → IMAGE（区域打码）
    CX_RegionUnscramble  输入 IMAGE + aabb + int(key) → IMAGE（区域还原）

算法来源：cx-E2EE（C-X 安全终端）src/image-crypto.js 的 V3 区域打码
         IA.hash / IA.rng / IA.perm / IA.regionEnc —— Python/NumPy 逐位等价移植，
         与网页端同图同 aabb 同密码输出字节完全一致（tests/test_parity.py 证明）。

注意：本包只用 V3 extension 入口（comfy_entrypoint），**故意不导出 NODE_CLASS_MAPPINGS**，
      因为 ComfyUI 的加载器见到 V1 的 NODE_CLASS_MAPPINGS 就会 return，跳过 V3 入口。
"""

from .nodes import (  # noqa: F401
    CXImageScrambleExtension,
    CXRegionScramble,
    CXRegionUnscramble,
    comfy_entrypoint,
)

__version__ = "1.1.0"
__all__ = [
    "comfy_entrypoint",
    "CXImageScrambleExtension",
    "CXRegionScramble",
    "CXRegionUnscramble",
]

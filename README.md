# C-X 安全终端 (CX-E2EE)

基于 Web Crypto / TweetNaCl / NIST 后量子算法（ML-KEM-768 / ML-DSA-65）的端到端加密终端：
文本信道、图片加密（Canvas 像素级抗干扰）、数字签名、对称加密、后量子文本/签名信道，以及自托管公钥库（PKI）。

## 项目结构

```
cx-E2EE/
├── src/                    # 前端唯一真源（页面 + 样式 + 脚本 + PQ 算法模块）
│   ├── index.html          # 控制台首页
│   ├── text-crypto.html    # 文本信道 (Curve25519)
│   ├── image-crypto.html   # 图片加密 (Canvas)
│   ├── signature.html      # 数字签名 (EdDSA)
│   ├── symmetric.html      # 对称加密 (AES-GCM)
│   ├── pq-text-crypto.html # 后量子文本信道 (ML-KEM-768)
│   ├── pq-signature.html   # 后量子签名 (ML-DSA-65)
│   ├── pq-account.html     # 后量子密钥管理 (离线派生)
│   ├── account.html        # 公钥库 (PKI) — 唯一需要服务器的页面
│   ├── style.css / pq-style.css
│   ├── core.js             # 公共工具函数
│   ├── pow-worker.js       # PoW 防滥写 Worker (仅 account 用)
│   └── lib/                # 动态 import 的 PQ 算法 bundle
│       ├── ml-kem.bundle.mjs
│       └── ml-dsa.bundle.mjs
├── server/                 # 后端（静态托管 + PKI API）
│   ├── server.js           # 生产服务器：express.static(src) + /api/update + /api/pubkey/:id
│   └── serve.js            # 本地纯静态预览（端口 9091，零依赖）
├── deploy/                 # 生产部署装配
│   ├── Dockerfile          # 整站单容器镜像（server + src）
│   └── docker-compose.yml  # 一键起服务 + data 卷挂载
├── single-file/            # 单文件压缩版（离线分发，双击即用，无服务器依赖）
│   ├── CX秘制安全终端-V6.html  # 合并 8 信道的单页产物 (~134KB)
│   └── COMPRESSION.md          # 合并/压缩过程文档
├── data/                   # 运行时数据（gitignore：公钥库 JSON 等）
├── archive/                # 测试素材留档（gitignore）
└── package.json / package-lock.json / .gitignore / .dockerignore
```

## 三种交付形态

| 形态 | 位置 | 说明 |
|---|---|---|
| **生产 Web 版** | `src/` + `server/server.js` + `deploy/` | 前端与后端整体部署在一台服务器：浏览器访问页面，account 页写/查 PKI API |
| **本地版** | `src/` + `node server/serve.js` | 纯静态本地预览（9091），离线可用（PQ 模块经本地 http 加载） |
| **单文件版** | `single-file/CX秘制安全终端-V6.html` | 全部页面+算法合并为一个 HTML，可离线分发/双击打开，不含 PKI 服务端 |

## 快速开始

```bash
# 本地预览（纯静态，端口 9091）
node server/serve.js

# 生产（完整应用：静态 + PKI API，端口 3000）
npm start          # = node server/server.js
# 或 Docker：
docker compose -f deploy/docker-compose.yml up -d --build   # 宿主机 1211 → 容器 3000
```

## 生产要点

- 前端与 API **必须同源**：`account.html` 固定的 `fetch('/api/update')` 是相对路径，
  页面与 API 应由同一 origin 提供（正是 `server.js` 单进程托管两者的原因）。
- 公钥库为单 JSON（`data/pubkey_store.json`），**请勿多副本并发写入**，单实例运行即可；
  定期备份该文件即为备份策略。
- TLS 不在 node 内做；如需 HTTPS，在宿主机用 nginx/caddy 终结 443 反代到容器 3000，
  可选对 `/api/update` 做 per-IP 限速补充 PoW（现状 PoW=16bit）防刷。

## 离线口

单文件版已剔除 PKI（无 `/api/update`），其余 8 个信道完整可用，适合无网络环境；
生产 Web 版多一个"公钥库"能力，其余功能完全一致。
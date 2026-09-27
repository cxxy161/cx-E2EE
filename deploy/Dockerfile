# C-X Security Terminal — whole-site production image
# Serves frontend static (src/) + PKI API (server/server.js) in one container.
FROM node:24-alpine
WORKDIR /app

# 1) Dependencies first (cache layer)
COPY package.json package-lock.json ./
RUN npm install --production

# 2) Application: backend + frontend only (no test assets / single-file builds)
COPY server/ server/
COPY src/ src/

# 3) 语言隐写模型资产：server.js 的 /stego-model 路由指向
#    /app/.pcd/pcd-v3-6M-fixedpoint/model，不 COPY 则整条路由 404。
#    （只拷 model/，python 侧与 golden/ 是导出期工具，运行时不用）
COPY .pcd/pcd-v3-6M-fixedpoint/model/ .pcd/pcd-v3-6M-fixedpoint/model/

EXPOSE 3000
CMD ["node", "server/server.js"]
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

EXPOSE 3000
CMD ["node", "server/server.js"]
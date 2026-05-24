# C-X Security Terminal
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]

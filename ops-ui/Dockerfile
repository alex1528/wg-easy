# wg-easy 运维页面（ops-ui）：零第三方依赖，只需要 Node 基础镜像，不需要 npm install
# 连不上 Docker Hub 时：.env 设 OPS_UI_BASE_REGISTRY=ccr.ccs.tencentyun.com/vpn-server/（末尾带 /，先用 scripts/mirror-images.sh 同步 node:22-alpine）
ARG NODE_BASE_REGISTRY=
FROM ${NODE_BASE_REGISTRY}node:22-alpine

WORKDIR /app
ENV NODE_ENV=production OPS_UI_PORT=8080 OPS_UI_BASE=/ops

COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

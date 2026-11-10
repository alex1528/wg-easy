# 官方 caddy 镜像不含以下模块，这里用 xcaddy 编译进去：
#   - mholt/caddy-ratelimit                   限流
#   - caddy-dns/tencentcloud                  腾讯云 DNSPod 的 ACME DNS-01 验证
#   - caddy-dns/alidns                        阿里云解析的 ACME DNS-01 验证
#   - hslatman/caddy-crowdsec-bouncer/http    CrowdSec 封禁（按 CrowdSec 决策拦截 IP）
# 若某个插件与最新 Caddy 不兼容导致编译失败，可在 .env 里把 CADDY_VERSION 固定到较早的小版本（如 2.9）
ARG CADDY_VERSION=2
# 基础镜像前缀：留空 = Docker Hub
# 服务器连不上 Docker Hub 时，先用 scripts/mirror-images.sh 同步，再在 .env 设 CADDY_BASE_REGISTRY=ccr.ccs.tencentyun.com/vpn-server/（末尾带 /）
ARG CADDY_BASE_REGISTRY=

FROM ${CADDY_BASE_REGISTRY}caddy:${CADDY_VERSION}-builder-alpine AS builder
# 国内构建加速；海外机器可在 compose build.args 里改成 https://proxy.golang.org,direct
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
RUN xcaddy build \
      --with github.com/mholt/caddy-ratelimit \
      --with github.com/caddy-dns/tencentcloud \
      --with github.com/caddy-dns/alidns \
      --with github.com/hslatman/caddy-crowdsec-bouncer/http

FROM ${CADDY_BASE_REGISTRY}caddy:${CADDY_VERSION}-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# 构建时自检：任一模块缺失则构建失败
RUN caddy list-modules > /tmp/mods && \
    for m in http.handlers.rate_limit dns.providers.tencentcloud dns.providers.alidns crowdsec http.handlers.crowdsec; do \
      grep -qx "$m" /tmp/mods || { echo "缺少模块: $m"; exit 1; }; \
    done && rm /tmp/mods

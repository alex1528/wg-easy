#!/usr/bin/env bash
# 把部署要用的 Docker Hub 镜像同步到腾讯云镜像仓库（CCR），供连不上 Docker Hub 的服务器使用
#
# 在能访问 Docker Hub 的机器上运行：海外机器、开了代理的电脑，
# 或在 /etc/docker/daemon.json 配置了 registry-mirrors 的服务器（如腾讯云的 mirror.ccs.tencentyun.com）
#
# 用法（Linux 或 Windows 的 Git Bash）：
#   bash scripts/mirror-images.sh             # 同步全部镜像
#   bash scripts/mirror-images.sh --dry-run   # 只列出要同步的镜像
#
# 配置（优先级：当前环境变量 > .env > 默认值）：
#   MIRROR_NAMESPACE  目标前缀，默认 ccr.ccs.tencentyun.com/vpn-server
#   CROWDSEC_VERSION  CrowdSec 版本，默认 v1.8.2
#   CADDY_VERSION     Caddy 版本，默认 2（与 caddy/Dockerfile 一致）
#   MIRROR_SOURCE     源镜像前缀，默认空（Docker Hub）；也可以填可用的 Docker Hub 镜像站，末尾带 /
#   CCR_USERNAME 和 CCR_PASSWORD  两个都设置时自动 docker login；否则使用已有登录状态
set -euo pipefail
# Git Bash 下禁止把 /xxx 这类参数自动改写成 Windows 路径
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

die() { echo "✘ $*" >&2; exit 1; }

DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *)         die "未知参数: $1（-h 查看帮助）" ;;
  esac
  shift
done

# 从 .env 读取指定键（不 source：有些值带空格）
env_get() {
  [ -f .env ] || return 0
  grep -E "^[[:space:]]*$1=" .env | tail -n 1 \
    | sed -E "s/^[[:space:]]*$1=//; s/\r$//; s/^[\"']//; s/[\"'][[:space:]]*$//" || true
}

NS="${MIRROR_NAMESPACE:-$(env_get MIRROR_NAMESPACE)}"
NS="${NS:-ccr.ccs.tencentyun.com/vpn-server}"
NS="${NS%/}"
CROWDSEC_VERSION="${CROWDSEC_VERSION:-$(env_get CROWDSEC_VERSION)}"
CROWDSEC_VERSION="${CROWDSEC_VERSION:-v1.8.2}"
CADDY_VERSION="${CADDY_VERSION:-$(env_get CADDY_VERSION)}"
CADDY_VERSION="${CADDY_VERSION:-2}"
SRC="${MIRROR_SOURCE:-$(env_get MIRROR_SOURCE)}"
REGISTRY="${NS%%/*}"

# 源镜像|目标镜像
PAIRS=(
  "${SRC}crowdsecurity/crowdsec:${CROWDSEC_VERSION}|${NS}/crowdsec:${CROWDSEC_VERSION}"
  "${SRC}library/caddy:${CADDY_VERSION}-builder-alpine|${NS}/caddy:${CADDY_VERSION}-builder-alpine"
  "${SRC}library/caddy:${CADDY_VERSION}-alpine|${NS}/caddy:${CADDY_VERSION}-alpine"
)

echo "源      : ${SRC:-Docker Hub}"
echo "目标    : $NS"
echo
for p in "${PAIRS[@]}"; do echo "  ${p%%|*}  →  ${p#*|}"; done
echo

if [ "$DRY" = 1 ]; then exit 0; fi

command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker info >/dev/null 2>&1      || die "docker 守护进程未运行，或当前用户没有权限"

if [ -n "${CCR_USERNAME:-}" ] && [ -n "${CCR_PASSWORD:-}" ]; then
  printf '%s' "$CCR_PASSWORD" | docker login "$REGISTRY" -u "$CCR_USERNAME" --password-stdin >/dev/null \
    || die "docker login $REGISTRY 失败，请检查 CCR_USERNAME 和 CCR_PASSWORD"
fi

HAS_IMAGETOOLS=0
docker buildx imagetools --help >/dev/null 2>&1 && HAS_IMAGETOOLS=1

failed=()
for p in "${PAIRS[@]}"; do
  src="${p%%|*}"; dst="${p#*|}"
  echo "==> $src"
  # 方式 1：registry 之间直接复制，保留全部 CPU 架构，不占本地磁盘
  #        不经过 daemon.json 的 registry-mirrors，所以本机只能靠镜像加速访问 Docker Hub 时会失败，自动改用方式 2
  if [ "$HAS_IMAGETOOLS" = 1 ] && docker buildx imagetools create --tag "$dst" "$src" >/dev/null 2>&1; then
    echo "    ✔ 已复制（全部架构）"
    continue
  fi
  # 方式 2：拉到本地再推送，只包含本机 CPU 架构
  if docker pull "$src" && docker tag "$src" "$dst" && docker push "$dst"; then
    echo "    ✔ 已推送（仅本机架构 $(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo '?')）"
  else
    echo "    ✘ 失败"
    failed+=("$src")
  fi
done

echo
if [ ${#failed[@]} -gt 0 ]; then
  printf '✘ 以下镜像同步失败：\n'; printf '    %s\n' "${failed[@]}"
  echo "  拉取失败：本机也连不上 Docker Hub，换一台机器，或设置 MIRROR_SOURCE"
  echo "  推送失败：先 docker login $REGISTRY（用户名是腾讯云账号 ID）；提示仓库不存在时，在容器镜像服务控制台创建 crowdsec 和 caddy 两个仓库"
  exit 1
fi

echo "✔ 同步完成。在服务器的 .env 中设置："
echo "    CROWDSEC_IMAGE=$NS/crowdsec:$CROWDSEC_VERSION"
echo "    CADDY_BASE_REGISTRY=$NS/"
echo "然后执行："
echo "    docker compose -f docker-compose-dirty.yml up -d"

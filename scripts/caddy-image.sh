#!/usr/bin/env bash
# 构建带「限流 + 腾讯云/阿里云 DNS 插件 + CrowdSec 封禁」的 Caddy 镜像，自检通过后推送到腾讯云镜像仓库（CCR）
#
# 用法（在 Linux 或 Windows 的 Git Bash 中运行）：
#   bash scripts/caddy-image.sh                    # 构建 + 自检 + 推送（本机架构）
#   bash scripts/caddy-image.sh --no-push          # 只构建 + 自检，不推送
#   bash scripts/caddy-image.sh --platform linux/amd64,linux/arm64   # 多架构推送（需 buildx）
#   bash scripts/caddy-image.sh --no-latest        # 不更新 latest 标签
#
# 配置（优先级：当前环境变量 > .env > 默认值）：
#   CADDY_IMAGE_REPO  推送目标，默认 ccr.ccs.tencentyun.com/vpn-server/caddy-ratelimit-dns
#   CADDY_VERSION     Caddy 主版本或固定小版本，默认 2（插件不兼容时改成 2.9 之类）
#   GOPROXY           Go 模块代理，默认 https://goproxy.cn,direct
#   CCR_USERNAME 和 CCR_PASSWORD  两个都设置时自动 docker login（CI 用）；否则使用已有登录状态
set -euo pipefail
# Git Bash 下禁止把 /tmp/... 这类参数自动改写成 Windows 路径
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

die() { echo "✘ $*" >&2; exit 1; }

# ---------- 命令行参数 ----------
PUSH=1
LATEST=1
PLATFORMS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-push)    PUSH=0 ;;
    --no-latest)  LATEST=0 ;;
    --platform)   shift; PLATFORMS="${1:-}"; [ -n "$PLATFORMS" ] || die "--platform 需要参数，如 linux/amd64,linux/arm64" ;;
    --platform=*) PLATFORMS="${1#*=}" ;;
    -h|--help)    sed -n '2,14p' "$0"; exit 0 ;;
    *)            die "未知参数: $1（-h 查看帮助）" ;;
  esac
  shift
done

# ---------- 从 .env 读取指定键（不 source：WG_ALLOW_IPS 等值带空格，source 会出错）----------
env_get() {
  [ -f .env ] || return 0
  grep -E "^[[:space:]]*$1=" .env | tail -n 1 \
    | sed -E "s/^[[:space:]]*$1=//; s/\r$//; s/^[\"']//; s/[\"'][[:space:]]*$//" || true
}

REPO="${CADDY_IMAGE_REPO:-$(env_get CADDY_IMAGE_REPO)}"
REPO="${REPO:-ccr.ccs.tencentyun.com/vpn-server/caddy-ratelimit-dns}"
CADDY_VERSION="${CADDY_VERSION:-$(env_get CADDY_VERSION)}"
CADDY_VERSION="${CADDY_VERSION:-2}"
GOPROXY="${GOPROXY:-$(env_get GOPROXY)}"
GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
REGISTRY="${REPO%%/*}"
BUILD_TAG="wg-easy-caddy:build-$$"
LOCAL_ALIAS="wg-easy-caddy:ratelimit-dns"   # compose 默认使用的本地标签
REQUIRED_MODULES="http.handlers.rate_limit dns.providers.tencentcloud dns.providers.alidns crowdsec http.handlers.crowdsec"

# ---------- 环境检查 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker info >/dev/null 2>&1      || die "docker 守护进程未运行，或当前用户没有权限（试试 sudo 或加入 docker 组）"
for f in caddy/Dockerfile caddy/Caddyfile; do
  [ -f "$f" ] || die "缺少 $f，请在 wg-easy 仓库中运行"
done

cleanup() { docker image rm "$BUILD_TAG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "目标仓库 : $REPO"
echo "Caddy    : $CADDY_VERSION"
echo "GOPROXY  : $GOPROXY"
echo "推送     : $([ "$PUSH" = 1 ] && echo "是${PLATFORMS:+（$PLATFORMS）}" || echo 否)"
echo

# ---------- 1. 构建 ----------
echo "==> [1/4] 构建镜像"
docker build --pull \
  --build-arg CADDY_VERSION="$CADDY_VERSION" \
  --build-arg GOPROXY="$GOPROXY" \
  -t "$BUILD_TAG" caddy

# ---------- 2. 自检：版本 + 模块 ----------
echo "==> [2/4] 自检版本和模块"
CADDY_VER="$(docker run --rm "$BUILD_TAG" caddy version | awk '{print $1}' | sed 's/^v//')"
echo "$CADDY_VER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' || die "无法识别 Caddy 版本: '$CADDY_VER'"
echo "    Caddy 实际版本: $CADDY_VER"

MODS="$(docker run --rm "$BUILD_TAG" caddy list-modules)"
for m in $REQUIRED_MODULES; do
  grep -qx "$m" <<<"$MODS" || die "镜像缺少模块 $m"
  echo "    ✔ $m"
done

# ---------- 3. 自检：Caddyfile 在 4 种证书模式下都能通过校验 ----------
# 用 stdin 把 Caddyfile 传进容器，避免 Windows 下挂载路径的问题
# 只检查语法和模块配置，不会真去申请证书，也不验证云 API 密钥是否正确
# CrowdSec 用占位密钥和本机地址，校验时不需要 CrowdSec 在运行
echo "==> [3/4] 校验 caddy/Caddyfile"
for mode in internal http tencentcloud alidns; do
  if out="$(docker run --rm -i \
        -e WG_WEB_HOST=vpn.example.com \
        -e CADDY_TLS_MODE="$mode" \
        -e ACME_EMAIL=ci@example.com \
        -e CROWDSEC_BOUNCER_KEY=validateonly \
        -e CROWDSEC_LAPI_URL=http://127.0.0.1:8080 \
        "$BUILD_TAG" \
        sh -c 'cat > /tmp/Caddyfile && caddy validate --adapter caddyfile --config /tmp/Caddyfile' \
        < caddy/Caddyfile 2>&1)"; then
    echo "    ✔ $mode"
  else
    echo "$out" | tail -n 20 >&2
    die "Caddyfile 在 $mode 模式下校验失败，已停止（未推送）"
  fi
done

# ---------- 生成标签 ----------
DATE="$(date +%Y%m%d)"
if git rev-parse --git-dir >/dev/null 2>&1; then
  REV="$(git rev-parse --short HEAD)"
  # caddy/ 目录有未提交改动时加 -dirty，免得以后对不上源码
  [ -z "$(git status --porcelain -- caddy)" ] || REV="${REV}-dirty"
else
  REV="nogit"
fi
TAGS=("$CADDY_VER" "${CADDY_VER}-${DATE}-${REV}")
if [ "$LATEST" = 1 ]; then TAGS+=("latest"); fi

docker tag "$BUILD_TAG" "$LOCAL_ALIAS"
for t in "${TAGS[@]}"; do docker tag "$BUILD_TAG" "$REPO:$t"; done

if [ "$PUSH" = 0 ]; then
  echo
  echo "✔ 构建和自检完成，未推送。本地标签："
  echo "    $LOCAL_ALIAS"
  for t in "${TAGS[@]}"; do echo "    $REPO:$t"; done
  exit 0
fi

# ---------- 4. 推送 ----------
echo "==> [4/4] 推送到 $REGISTRY"
if [ -n "${CCR_USERNAME:-}" ] && [ -n "${CCR_PASSWORD:-}" ]; then
  printf '%s' "$CCR_PASSWORD" | docker login "$REGISTRY" -u "$CCR_USERNAME" --password-stdin >/dev/null \
    || die "docker login $REGISTRY 失败，请检查 CCR_USERNAME 和 CCR_PASSWORD"
  echo "    已登录 $REGISTRY"
else
  echo "    未设置 CCR_USERNAME 和 CCR_PASSWORD，使用本机已有的登录状态"
fi

push_hint="推送失败：先运行 docker login $REGISTRY（用户名是腾讯云账号 ID，密码在容器镜像服务控制台设置），并确认命名空间 ${REPO#*/} 的上级已存在"

if [ -z "$PLATFORMS" ]; then
  for t in "${TAGS[@]}"; do
    docker push "$REPO:$t" || die "$push_hint"
  done
  DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$REPO:${TAGS[0]}" 2>/dev/null || true)"
else
  docker buildx version >/dev/null 2>&1 || die "多架构推送需要 docker buildx"
  BUILDER="wg-easy-builder"
  docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
    || docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
  tag_args=()
  for t in "${TAGS[@]}"; do tag_args+=(-t "$REPO:$t"); done
  # 用上面测出来的确切版本号，保证各架构和自检过的版本一致
  docker buildx build --builder "$BUILDER" \
    --platform "$PLATFORMS" \
    --build-arg CADDY_VERSION="$CADDY_VER" \
    --build-arg GOPROXY="$GOPROXY" \
    "${tag_args[@]}" --push caddy \
    || die "$push_hint（跨架构编译还需要 QEMU：docker run --privileged --rm tonistiigi/binfmt --install all）"
  DIGEST=""
fi

echo
echo "✔ 已推送："
for t in "${TAGS[@]}"; do echo "    $REPO:$t"; done
[ -z "$DIGEST" ] || echo "    digest: $DIGEST"
echo
echo "服务器上使用：在 .env 中设置"
echo "    CADDY_IMAGE=$REPO:${CADDY_VER}-${DATE}-${REV}"
echo "然后执行："
echo "    docker compose -f docker-compose-dirty.yml pull caddy"
echo "    docker compose -f docker-compose-dirty.yml up -d --no-build caddy"

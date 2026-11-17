#!/usr/bin/env bash
# 构建部署用的两个自编译镜像，自检通过后推送到腾讯云镜像仓库（CCR）：
#   caddy   ccr.ccs.tencentyun.com/vpn-server/caddy:ratelimit-dns（限流 + DNS 插件 + CrowdSec）
#   ops-ui  ccr.ccs.tencentyun.com/vpn-server/ops-ui:latest（运维页面）
# wg-easy、crowdsec 不在这里构建：docker-compose-dirty.yml 直接拉取 .env 里的镜像地址
#   （crowdsec 连不上 Docker Hub 时用 scripts/mirror-images.sh 同步到 CCR）
#
# 用法（在 Linux 或 Windows 的 Git Bash 中运行）：
#   bash scripts/build-images.sh                 # 两个都做：构建 + 自检 + 推送
#   bash scripts/build-images.sh ops-ui          # 只做指定的（可选 caddy ops-ui）
#   bash scripts/build-images.sh --no-push       # 只构建 + 自检，不推送；镜像留在本机，可用于服务器现场编译
#   bash scripts/build-images.sh --no-latest     # 不更新浮动标签（caddy:ratelimit-dns、ops-ui:latest）
#   bash scripts/build-images.sh --platform linux/amd64,linux/arm64   # 多架构推送（需 buildx）
#
# 各镜像做什么：
#   caddy   调用 scripts/caddy-image.sh：编译插件、检查模块、在多种证书模式下校验 Caddyfile
#           标签 ratelimit-dns、ratelimit-dns-<Caddy 版本>、ratelimit-dns-<Caddy 版本>-<日期>-<提交号>
#   ops-ui  跑单元测试 → 构建 → 按 compose 的约束（只读、去掉全部 capability）启动容器检查 /healthz
#           标签 latest、<版本>、<版本>-<日期>-<提交号>（版本取 ops-ui/package.json）
# 某一项失败时这一项不推送，其余项照常进行；最后汇总，有失败时退出码为 1
#
# 配置（优先级：当前环境变量 > .env > 默认值），都在 .env.example 的“构建 / 同步镜像”一节：
#   CADDY_IMAGE_REPO      caddy 推送目标，默认 ccr.ccs.tencentyun.com/vpn-server/caddy
#   CADDY_VERSION、GOPROXY、CADDY_BASE_REGISTRY  见 scripts/caddy-image.sh
#   OPS_UI_IMAGE_REPO     ops-ui 推送目标，默认 ccr.ccs.tencentyun.com/vpn-server/ops-ui
#   OPS_UI_BASE_REGISTRY  ops-ui 的 Node 基础镜像前缀，默认空（Docker Hub），末尾带 /
#   CCR_USERNAME 和 CCR_PASSWORD  两个都设置时自动 docker login（CI 用）；否则使用已有登录状态
set -euo pipefail
# Git Bash 下禁止把 /xxx 这类参数自动改写成 Windows 路径
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

die() { echo "✘ $*" >&2; exit 1; }
# 帮助：打印文件开头的注释
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; }

# ---------- 命令行参数 ----------
PUSH=1
LATEST=1
PLATFORMS=""
TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-push)    PUSH=0 ;;
    --no-latest)  LATEST=0 ;;
    --platform)   shift; PLATFORMS="${1:-}"; [ -n "$PLATFORMS" ] || die "--platform 需要参数，如 linux/amd64,linux/arm64" ;;
    --platform=*) PLATFORMS="${1#*=}" ;;
    -h|--help)    usage; exit 0 ;;
    caddy|ops-ui) TARGETS+=("$1") ;;
    crowdsec|wg-easy)
      die "$1 不由本脚本构建：compose 直接拉取 .env 里配置的镜像地址（crowdsec 连不上 Docker Hub 时用 scripts/mirror-images.sh 同步到 CCR）" ;;
    *)            die "未知参数: $1（可选镜像：caddy ops-ui；-h 查看帮助）" ;;
  esac
  shift
done
[ ${#TARGETS[@]} -gt 0 ] || TARGETS=(caddy ops-ui)
want() { local t; for t in "${TARGETS[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }

# ---------- 从 .env 读取指定键（不 source：WG_ALLOW_IPS 等值带空格，source 会出错）----------
env_get() {
  [ -f .env ] || return 0
  grep -E "^[[:space:]]*$1=" .env | tail -n 1 \
    | sed -E "s/^[[:space:]]*$1=//; s/\r$//; s/^[\"']//; s/[\"'][[:space:]]*$//" || true
}

CADDY_REPO="${CADDY_IMAGE_REPO:-$(env_get CADDY_IMAGE_REPO)}"
CADDY_REPO="${CADDY_REPO:-ccr.ccs.tencentyun.com/vpn-server/caddy}"
OPS_REPO="${OPS_UI_IMAGE_REPO:-$(env_get OPS_UI_IMAGE_REPO)}"
OPS_REPO="${OPS_REPO:-ccr.ccs.tencentyun.com/vpn-server/ops-ui}"
NODE_BASE="${OPS_UI_BASE_REGISTRY:-$(env_get OPS_UI_BASE_REGISTRY)}"
# 补上末尾的 /，免得拼成 ccr.ccs.tencentyun.com/vpn-servernode
if [ -n "$NODE_BASE" ]; then NODE_BASE="${NODE_BASE%/}/"; fi
DATE="$(date +%Y%m%d)"

# ---------- 环境检查 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker info >/dev/null 2>&1      || die "docker 守护进程未运行，或当前用户没有权限（试试 sudo 或加入 docker 组）"
for f in scripts/caddy-image.sh ops-ui/Dockerfile ops-ui/package.json ops-ui/server.mjs; do
  [ -f "$f" ] || die "缺少 $f，请在 wg-easy 仓库中运行"
done

TMPD="$(mktemp -d)"
RESULT_FILE="$TMPD/result"   # 每行：服务名|.env 里要设置的 KEY=VALUE
: >"$RESULT_FILE"
OPS_BUILD_TAG="wg-easy-ops-ui:build-$$"
OPS_CHECK="wg-easy-ops-ui-check-$$"
cleanup() {
  docker rm -f "$OPS_CHECK" >/dev/null 2>&1 || true
  docker image rm "$OPS_BUILD_TAG" >/dev/null 2>&1 || true
  rm -rf "$TMPD"
}
trap cleanup EXIT

# 源码目录有未提交改动时加 -dirty，免得以后对不上源码（与 caddy-image.sh 一致）
git_rev() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    local r
    r="$(git rev-parse --short HEAD)"
    [ -z "$(git status --porcelain -- "$1")" ] || r="${r}-dirty"
    echo "$r"
  else
    echo nogit
  fi
}

ccr_login() {  # $1 = 镜像仓库地址
  local pw
  pw="$(printenv CCR_PASSWORD || true)"
  if [ -n "${CCR_USERNAME:-}" ] && [ -n "$pw" ]; then
    printf '%s' "$pw" | docker login "$1" -u "$CCR_USERNAME" --password-stdin >/dev/null \
      || die "docker login $1 失败，请检查 CCR_USERNAME 和 CCR_PASSWORD"
    echo "    已登录 $1"
  else
    echo "    未设置 CCR_USERNAME 和 CCR_PASSWORD，使用本机已有的登录状态"
  fi
}

# ==================== caddy ====================
build_caddy() {
  local args=()
  [ "$PUSH" = 1 ]      || args+=(--no-push)
  [ "$LATEST" = 1 ]    || args+=(--no-latest)
  [ -z "$PLATFORMS" ]  || args+=(--platform "$PLATFORMS")
  CADDY_IMAGE_REPO="$CADDY_REPO" bash scripts/caddy-image.sh ${args[@]+"${args[@]}"} 2>&1 | tee "$TMPD/caddy.log"
  [ "$PUSH" = 1 ] || return 0
  # caddy-image.sh 推送成功时最后会打印 CADDY_IMAGE=<固定标签>
  local line
  line="$(grep -E '^[[:space:]]+CADDY_IMAGE=' "$TMPD/caddy.log" | tail -n 1 | sed -E 's/^[[:space:]]+//' || true)"
  [ -z "$line" ] || echo "caddy|$line" >>"$RESULT_FILE"
}

# ==================== ops-ui ====================
build_ops_ui() {
  local base="${NODE_BASE}node:22-alpine"
  local reg="${OPS_REPO%%/*}"
  local pkg_ver
  pkg_ver="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' ops-ui/package.json | head -n 1)"
  [ -n "$pkg_ver" ] || die "读不到 ops-ui/package.json 里的 version"
  echo "目标仓库 : $OPS_REPO"
  echo "基础镜像 : $base"
  echo "版本     : $pkg_ver"

  echo "==> [1/4] 单元测试"
  local log="$TMPD/ops-ui-test.log"
  if command -v node >/dev/null 2>&1 \
     && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null; then
    if ! (cd ops-ui && node --test test/*.test.mjs) >"$log" 2>&1; then
      tail -n 30 "$log" >&2
      die "ops-ui 测试失败（未构建、未推送）"
    fi
  else
    # 本机没有 Node 20+：把源码用 tar 传进 Node 容器里跑，避免 Windows 下挂载路径的问题
    echo "    本机没有 Node 20+，在 $base 容器里跑"
    if ! tar -C ops-ui --exclude=node_modules -cf - . \
         | docker run --rm -i "$base" sh -c 'mkdir -p /t && cd /t && tar -xf - && node --test test/*.test.mjs' >"$log" 2>&1; then
      tail -n 30 "$log" >&2
      die "ops-ui 测试失败（未构建、未推送）"
    fi
  fi
  echo "    ✔ $(grep -m1 -E '^(ℹ|#) pass ' "$log" | sed -E 's/^(ℹ|#) //' || echo '全部通过')"

  echo "==> [2/4] 构建镜像"
  docker build --pull --build-arg NODE_BASE_REGISTRY="$NODE_BASE" -t "$OPS_BUILD_TAG" ops-ui

  echo "==> [3/4] 自检：按 compose 的约束启动（只读、去掉全部 capability），检查 /healthz"
  docker rm -f "$OPS_CHECK" >/dev/null 2>&1 || true
  docker run -d --name "$OPS_CHECK" \
    --read-only --tmpfs /tmp --user 0:0 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    "$OPS_BUILD_TAG" >/dev/null
  local ok=0 i
  for i in $(seq 1 15); do
    if docker exec "$OPS_CHECK" node -e "Promise.all(['/healthz','/ops/healthz'].map((p)=>fetch('http://127.0.0.1:8080'+p).then((r)=>{if(!r.ok)throw new Error(p)}))).then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if [ "$ok" != 1 ]; then
    docker logs "$OPS_CHECK" 2>&1 | tail -n 20 >&2
    die "ops-ui 容器启动后 15 秒内 /healthz 不通（未推送），容器日志见上"
  fi
  echo "    ✔ /healthz、/ops/healthz 返回 200"
  docker exec "$OPS_CHECK" sh -c 'test ! -e /app/test && test ! -e /app/node_modules' \
    || die "镜像里带了 test/ 或 node_modules，检查 ops-ui/.dockerignore（未推送）"
  echo "    ✔ 镜像不含 test/、node_modules"
  docker rm -f "$OPS_CHECK" >/dev/null 2>&1 || true

  # ---------- 生成标签：latest 是 compose 的默认标签（浮动，指向最近一次构建）----------
  local rev
  rev="$(git_rev ops-ui)"
  local fixed="$OPS_REPO:${pkg_ver}-${DATE}-${rev}"
  local tags=("$pkg_ver" "${pkg_ver}-${DATE}-${rev}")
  if [ "$LATEST" = 1 ]; then tags+=(latest); fi
  local t
  for t in "${tags[@]}"; do docker tag "$OPS_BUILD_TAG" "$OPS_REPO:$t"; done

  if [ "$PUSH" = 0 ]; then
    echo "✔ 构建和自检完成，未推送。本地标签："
    for t in "${tags[@]}"; do echo "    $OPS_REPO:$t"; done
    echo "本机直接使用（镜像已在本机，up 不会去拉；不要先执行 pull）：.env 设 OPS_UI_IMAGE=$fixed，然后"
    echo "    docker compose -f docker-compose-dirty.yml up -d ops-ui"
    return 0
  fi

  echo "==> [4/4] 推送到 $reg"
  ccr_login "$reg"
  local hint="推送失败：先 docker login $reg（用户名是腾讯云账号 ID）；提示仓库不存在时，在容器镜像服务控制台创建 ${OPS_REPO##*/} 仓库"
  if [ -z "$PLATFORMS" ]; then
    for t in "${tags[@]}"; do docker push "$OPS_REPO:$t" || die "$hint"; done
  else
    docker buildx version >/dev/null 2>&1 || die "多架构推送需要 docker buildx"
    local builder="wg-easy-builder" targs=()
    docker buildx inspect "$builder" >/dev/null 2>&1 \
      || docker buildx create --name "$builder" --driver docker-container >/dev/null
    for t in "${tags[@]}"; do targs+=(-t "$OPS_REPO:$t"); done
    # ops-ui 没有编译步骤，各架构用同一份源码和同一个基础镜像标签，和上面自检过的内容一致
    docker buildx build --builder "$builder" \
      --platform "$PLATFORMS" \
      --build-arg NODE_BASE_REGISTRY="$NODE_BASE" \
      "${targs[@]}" --push ops-ui \
      || die "$hint（跨架构构建还需要 QEMU：docker run --privileged --rm tonistiigi/binfmt --install all）"
  fi
  echo "    ✔ 已推送："
  for t in "${tags[@]}"; do echo "      $OPS_REPO:$t"; done
  echo "ops-ui|OPS_UI_IMAGE=$fixed" >>"$RESULT_FILE"
}

# ==================== 执行 ====================
echo "镜像     : ${TARGETS[*]}"
echo "推送     : $([ "$PUSH" = 1 ] && echo "是${PLATFORMS:+（$PLATFORMS）}" || echo 否)"
want caddy  && echo "caddy    : $CADDY_REPO"
want ops-ui && echo "ops-ui   : $OPS_REPO"

OK_LIST=()
FAIL_LIST=()
run_one() {  # $1 = 名称，$2 = 函数；在子 shell 里跑，一项失败不影响其余项
  echo
  echo "==================== $1 ===================="
  local rc
  set +e
  ( set -e; "$2" )
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    OK_LIST+=("$1")
  else
    FAIL_LIST+=("$1")
    echo "✘ $1 失败，未推送" >&2
  fi
}

want caddy  && run_one caddy  build_caddy
want ops-ui && run_one ops-ui build_ops_ui

echo
echo "==================== 汇总 ===================="
[ ${#OK_LIST[@]} -eq 0 ] || echo "✔ 成功：${OK_LIST[*]}"
if [ -s "$RESULT_FILE" ]; then
  echo
  echo "服务器上使用：在 .env 的“镜像地址”一节设置（固定标签便于回滚）"
  cut -d'|' -f2- "$RESULT_FILE" | sed 's/^/    /'
  svcs="$(cut -d'|' -f1 "$RESULT_FILE" | tr '\n' ' ' | sed 's/ $//')"
  echo "然后执行（ops-ui 需要 .env 里 COMPOSE_PROFILES 含 ops）："
  echo "    docker compose -f docker-compose-dirty.yml pull $svcs"
  echo "    docker compose -f docker-compose-dirty.yml up -d $svcs"
fi
if [ ${#FAIL_LIST[@]} -gt 0 ]; then
  echo "✘ 失败：${FAIL_LIST[*]}（原因见上面对应一节的输出）" >&2
  exit 1
fi

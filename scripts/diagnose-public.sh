#!/usr/bin/env bash
# 排查“公开接口（如同步配置）访问不到”：从 Caddy 配置到 wg-easy 逐层检查，指出卡在哪一层
#
# 在服务器的 wg-easy 目录下运行：
#   bash scripts/diagnose-public.sh                          # 默认检查 /api/livewireguard/config
#   bash scripts/diagnose-public.sh /api/auth/oidc/callback  # 检查其他路径
set -uo pipefail
cd "$(dirname "$0")/.."

P="${1:-/api/livewireguard/config}"
C=wg-easy-caddy
W=wg-easy
ok()   { echo "  ✔ $*"; }
bad()  { echo "  ✘ $*"; }
info() { echo "  · $*"; }

docker ps --format '{{.Names}}' | grep -qx "$C" || { bad "容器 $C 没有运行"; exit 1; }
HOST="$(docker exec "$C" printenv WG_WEB_HOST 2>/dev/null || true)"
echo "检查路径：$P    域名：${HOST:-<未知>}"

echo
echo "== 1. Caddy 容器里的配置是不是新版"
if docker exec "$C" grep -q 'import /etc/caddy/admin-ips.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  ok "容器内 Caddyfile 是新版（管理员 IP + 公开接口）"
else
  bad "容器内 Caddyfile 还是旧版"
fi
if [ -f caddy/Caddyfile ] && cmp -s caddy/Caddyfile <(docker exec "$C" cat /etc/caddy/Caddyfile 2>/dev/null); then
  ok "与宿主机 caddy/Caddyfile 一致"
else
  bad "与宿主机 caddy/Caddyfile 不一致：git pull 后只 restart 不会换文件，要执行"
  info "docker compose -f docker-compose-dirty.yml up -d --no-build --force-recreate caddy"
fi
if docker exec "$C" test -s /etc/caddy/admin-ips.caddy 2>/dev/null; then
  ok "管理员名单已挂载：$(docker exec "$C" grep -c . /etc/caddy/admin-ips.caddy) 行"
else
  bad "容器里没有 /etc/caddy/admin-ips.caddy"
fi
old="$(docker exec "$C" printenv WG_ALLOW_IPS 2>/dev/null || true)"
[ -z "$old" ] || bad "容器里还有旧变量 WG_ALLOW_IPS=$old，说明容器没有按新 compose 重建"

PP="$(docker exec "$C" printenv WG_PUBLIC_PATHS 2>/dev/null || true)"
PP="${PP:-/api/livewireguard/* /api/auth/oidc /api/auth/oidc/* /cnf/*}"
hit=""
set -f
for pat in $PP; do
  # shellcheck disable=SC2053
  [[ "$P" == $pat ]] && hit="$pat"
done
set +f
if [ -n "$hit" ]; then
  ok "WG_PUBLIC_PATHS=[$PP]，$P 匹配 $hit"
else
  bad "WG_PUBLIC_PATHS=[$PP]，不包含 $P：非管理员 IP 访问会被 Caddy 拦下（403）"
fi

echo
echo "== 2. wg-easy 自己怎么回应（不经过 Caddy 的 IP 判断）"
direct="$(docker exec "$C" wget -S -O /dev/null "http://$W:51821$P" 2>&1 | grep -m1 -E 'HTTP/|refused|timed out|bad address' || true)"
case "$direct" in
  *refused*|*"bad address"*|*"timed out"*)
    bad "连不上 wg-easy：$direct（wg-easy 没起来，看 docker logs --tail 60 $W）" ;;
  *" 404"*)
    bad "wg-easy 返回 404：当前镜像里没有 $P 这个接口，问题在镜像，不在 Caddy"
    info "镜像：$(docker inspect -f '{{.Config.Image}}' "$W" 2>/dev/null)" ;;
  *HTTP/*)
    ok "wg-easy 返回：$(echo "$direct" | sed -E 's/^ *//')（不带客户端令牌时 400/401 都正常）" ;;
  *)
    bad "没拿到响应：$direct" ;;
esac

echo
echo "== 3. 经过 Caddy（从本机走域名，来源 IP 不是管理员 IP，模拟普通客户端）"
if [ -n "$HOST" ] && command -v curl >/dev/null 2>&1; then
  out="$(curl -sk -o /dev/null -D - --max-time 10 --resolve "$HOST:51821:127.0.0.1" "https://$HOST:51821$P" 2>&1 || true)"
  code="$(printf '%s\n' "$out" | grep -m1 -E '^HTTP/' | awk '{print $2}')"
  gate="$(printf '%s\n' "$out" | grep -i -m1 '^x-wg-gate:' | tr -d '\r' || true)"
  case "$code" in
    "")  bad "没有响应（连接被断开或超时）。旧版 Caddyfile 拦截时就是直接断开，见第 1 步" ;;
    403) if [ -n "$gate" ]; then bad "403，$gate：被管理员 IP 判断拦下，路径没匹配上 WG_PUBLIC_PATHS"
         else bad "403，没有 X-Wg-Gate 头：多半是 CrowdSec 封禁了来源 IP（cscli decisions list）"; fi ;;
    429) bad "429：触发限流（RL_PUBLIC_PER_MIN）" ;;
    502) bad "502：Caddy 连不上 wg-easy，见第 2 步" ;;
    *)   ok "HTTP $code：请求已经到了 wg-easy，Caddy 这一层没有问题" ;;
  esac
else
  info "跳过：不知道域名或本机没有 curl"
fi

echo
echo "== 4. 访问日志里最近 5 次 $P"
if [ -f caddy/logs/access.log ]; then
  lines="$(tail -n 5000 caddy/logs/access.log | grep -F "\"uri\":\"$P" | tail -n 5 \
    | sed -E 's/.*"client_ip":"([^"]*)".*"status":([0-9]+).*/  · client_ip=\1  status=\2/')"
  if [ -n "$lines" ]; then
    echo "$lines"
    info "status=0 表示连接被直接断开（旧版拦截方式）；403/429/502 见第 3 步"
  else
    info "最近没有这个路径的请求：客户端可能根本没连到这台服务器（DNS、端口、网络）"
  fi
else
  info "没有 caddy/logs/access.log"
fi

echo
echo "== 5. CrowdSec 当前封禁"
if docker ps --format '{{.Names}}' | grep -qx wg-easy-crowdsec; then
  n="$(docker exec wg-easy-crowdsec cscli decisions list -o raw 2>/dev/null | tail -n +2 | grep -c . || true)"
  info "当前封禁 ${n:-0} 条；查某个 IP：docker exec wg-easy-crowdsec cscli decisions list --ip <IP>"
fi

echo
echo "== 6. 最近被管理员 IP 规则拦下的请求（来源 IP / 方法 / 路径 / 次数）"
info "这里出现的路径就是客户端需要、但不在 WG_PUBLIC_PATHS 里的路径"
if [ -f caddy/logs/access.log ]; then
  blocked="$(tail -n 20000 caddy/logs/access.log | grep -F '"X-Wg-Gate":["admin-only"]' \
    | sed -E 's/.*"client_ip":"([^"]*)".*"method":"([A-Z]+)".*"uri":"([^"?]*).*/\1 \2 \3/' \
    | sort | uniq -c | sort -rn | head -n 20)"
  if [ -n "$blocked" ]; then
    echo "$blocked" | sed 's/^/  · /'
  else
    info "最近没有被管理员 IP 规则拦下的请求"
  fi
  echo
  echo "== 7. 最近 403 / 429 但不是管理员 IP 规则（CrowdSec 封禁或限流）"
  other="$(tail -n 20000 caddy/logs/access.log | grep -E '"status":(403|429)' | grep -vF '"X-Wg-Gate":["admin-only"]' \
    | sed -E 's/.*"client_ip":"([^"]*)".*"uri":"([^"?]*).*"status":([0-9]+).*/\1 \3 \2/' \
    | sort | uniq -c | sort -rn | head -n 10)"
  if [ -n "$other" ]; then
    echo "$other" | sed 's/^/  · /'
    info "403：查 docker exec wg-easy-crowdsec cscli decisions list --ip <IP>；429：调大 RL_PUBLIC_PER_MIN"
  else
    info "没有"
  fi
fi

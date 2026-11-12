#!/usr/bin/env bash
# 排查“公开接口（如同步配置）访问不到”：从 Caddy 配置到 wg-easy 逐层检查，指出卡在哪一层
#
# 在服务器的 wg-easy 目录下运行：
#   bash scripts/diagnose-public.sh                          # 默认检查 /api/livewireguard/config
#   bash scripts/diagnose-public.sh /api/auth/oidc/callback  # 检查其他路径
#   bash scripts/diagnose-public.sh --ip <客户端公网IP>      # 列出这个 IP 最近的全部请求（看客户端同步时访问了什么）
#   bash scripts/diagnose-public.sh --watch [客户端公网IP]   # 实时显示请求：运行后在客户端点“立即同步配置”
#   sudo bash scripts/diagnose-public.sh --capture [客户端公网IP]  # 抓 TCP 新连接：和 --watch 对照，区分“没到服务器”和“TLS 握手失败”
#   bash scripts/diagnose-public.sh --oidc                   # 列出客户端登录要访问的 OIDC 端点，并生成在客户端网络上执行的测试命令
#   bash scripts/diagnose-public.sh --setup '<livewireguard://setup?d=...>'  # 解码 App 实际使用的设置链接（首页“复制链接”）
#   bash scripts/diagnose-public.sh --dns [域名 ...]         # 查 A / AAAA：有没有 IPv6 记录、不同 DNS（线路）是否返回不同地址
#
# 客户端同步超时、但 --watch 里什么都没出现：请求根本没到这台服务器的 Caddy，
#   问题在客户端连的地址、DNS、上游防火墙/安全组，或者客户端卡在 OIDC 登录（第 8 步）
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=caddy/logs/access.log

# 把 Caddy 的 JSON 访问日志转成一行：时间 来源IP 方法 状态 路径 耗时 主机 客户端
# 各字段单独匹配，不依赖 JSON 字段顺序；解析不了的行原样显示（以 ? 开头），不会被静默丢掉
RE_TS='"ts":([0-9]+)'
RE_IP='"client_ip":"([^"]*)"'
RE_M='"method":"([A-Z]+)"'
RE_H='"host":"([^"]*)"'
RE_U='"uri":"([^"?]*)'
RE_S='"status":([0-9]+)'
RE_D='"duration":([0-9.eE+-]+)'
RE_UA='"User-Agent":\["([^"]*)"'
m() { if [[ "$line" =~ $1 ]]; then R="${BASH_REMATCH[1]}"; else R=""; fi; }
fmt() {
  local line R ts ip me h u s d ua tm
  while IFS= read -r line; do
    m "$RE_TS"; ts=$R
    if [ -z "$ts" ]; then printf '  ? %s\n' "${line:0:200}"; continue; fi
    m "$RE_IP"; ip=$R; m "$RE_M"; me=$R; m "$RE_H"; h=$R; m "$RE_U"; u=$R
    m "$RE_S"; s=$R; m "$RE_D"; d=$R; m "$RE_UA"; ua=$R
    printf -v tm '%(%m-%d %H:%M:%S)T' "$ts" 2>/dev/null || tm=$ts
    printf -v d '%.2f' "${d:-0}" 2>/dev/null || true
    printf '  · %s  %-15s %-6s %-4s %-40s %6ss  %s  %s\n' "$tm" "$ip" "$me" "${s:-?}" "$u" "$d" "$h" "${ua:0:40}"
  done
}
legend() {
  echo "  列：时间 来源IP 方法 状态 路径 耗时 主机 客户端(User-Agent)"
  echo "  状态 0 = 请求处理完之前连接已断开（客户端先超时放弃了，看耗时）；403 = 被拦；429 = 限流；502/504 = 后端问题"
}

case "${1:-}" in
  --ip)
    IP="${2:-}"; [ -n "$IP" ] || { echo "用法：$0 --ip <客户端公网IP>"; exit 2; }
    [ -f "$LOG" ] || { echo "没有 $LOG"; exit 1; }
    echo "== $IP 最近 40 次请求（$LOG）"
    legend
    out="$(tail -n 50000 "$LOG" | grep -F "\"client_ip\":\"$IP\"" | tail -n 40 | fmt)"
    if [ -n "$out" ]; then
      echo "$out"
    else
      echo "  ✘ 日志里没有来自 $IP 的请求：这个 IP 的流量没到这台服务器的 Caddy"
      echo "    · 客户端里填的服务器地址是不是这台（$(docker exec wg-easy-caddy printenv WG_WEB_HOST 2>/dev/null)）"
      echo "    · 从该网络执行：curl -sS -o /dev/null -w '%{http_code}\\n' https://<域名>:51821/api/livewireguard/config"
      echo "      超时 = 上游防火墙/安全组/端口转发只放行了部分来源；能返回 400 = 网络通，客户端卡在别处（如 OIDC 登录）"
    fi
    exit 0
    ;;
  --watch)
    IP="${2:-}"
    [ -f "$LOG" ] || { echo "没有 $LOG"; exit 1; }
    H="$(docker exec wg-easy-caddy printenv WG_WEB_HOST 2>/dev/null || true)"
    echo "实时显示${IP:+ $IP 的}请求，Ctrl+C 结束"
    legend
    # 非交互 shell 里后台进程会忽略 Ctrl+C，所以收到信号时结束整个进程组
    trap 'trap - INT TERM; kill 0 2>/dev/null' INT TERM
    if [ -n "$IP" ]; then
      tail -n 0 -F "$LOG" 2>/dev/null | grep --line-buffered -F "\"client_ip\":\"$IP\"" | fmt &
    else
      tail -n 0 -F "$LOG" 2>/dev/null | fmt &
    fi
    sleep 1
    # 自检：从本机发一个请求，证明这个工具本身能看到请求
    if [ -n "$H" ] && command -v curl >/dev/null 2>&1; then
      curl -sk -o /dev/null --max-time 8 -A diagnose-selftest --resolve "$H:51821:127.0.0.1" "https://$H:51821/api/livewireguard/config" || true
      sleep 1
      if [ -n "$IP" ]; then
        echo "  （已发自检请求，它的来源不是 $IP，被过滤掉了；想看自检就去掉 IP 参数）"
      else
        echo "  （已发自检请求：屏幕上应出现一行客户端为 diagnose-selftest 的记录；没有出现说明访问日志没写到 $LOG）"
      fi
    fi
    echo "  现在去客户端点“立即同步配置”"
    wait
    exit 0
    ;;
  --capture)
    IP="${2:-}"
    command -v tcpdump >/dev/null 2>&1 || { echo "需要 tcpdump：apt install -y tcpdump（CentOS：yum install -y tcpdump）"; exit 1; }
    [ "$(id -u)" = 0 ] || { echo "需要 root：sudo bash $0 --capture ${IP}"; exit 1; }
    # 只抓“发往 51821 的 SYN”（每次新连接一行）；去掉 Docker 转发到容器后的第二份（目的 10.42.42.0/24）和本机自测
    F='tcp dst port 51821 and (tcp[tcpflags] & (tcp-syn|tcp-ack)) == tcp-syn and not dst net 10.42.42.0/24 and not src net 10.42.42.0/24 and not src host 127.0.0.1'
    [ -z "$IP" ] || F="$F and src host $IP"
    echo "抓取发往 51821 的新 TCP 连接${IP:+（只看 $IP）}，Ctrl+C 结束"
    echo "  建议另开一个终端同时运行：bash scripts/diagnose-public.sh --watch"
    echo "  · 这里有记录、--watch 没有  = TCP 到了，TLS 握手失败（证书/SNI/客户端 TLS 设置），看 docker logs wg-easy-caddy"
    echo "  · 这里也没有记录            = 请求没到这台服务器（客户端连的地址、上游防火墙/安全组/端口转发，或卡在 OIDC 登录：--oidc）"
    echo "  现在去客户端点“立即同步配置”"
    exec tcpdump -lnni any "$F"
    ;;
  --setup)
    LINK="${2:-}"
    [ -n "$LINK" ] || { echo "用法：$0 --setup '<livewireguard://setup?d=...>'（wg-easy 首页 Connect → LiveWireGuard 设置 → 复制链接；整段用单引号括起来）"; exit 2; }
    D="${LINK#*d=}"; D="${D%%&*}"
    D="$(printf '%s' "$D" | tr '_-' '/+')"
    while [ $(( ${#D} % 4 )) -ne 0 ]; do D="$D="; done
    J="$(printf '%s' "$D" | base64 -d 2>/dev/null || true)"
    [ -n "$J" ] || { echo "✘ 解码失败：不是 livewireguard://setup?d=<base64url> 格式"; exit 1; }
    jget() { printf '%s' "$J" | grep -oE "\"$1\" *: *\"[^\"]*\"" | head -n 1 | sed -E 's/.*: *"([^"]*)"/\1/'; }
    ISS="$(jget issuer)"; EP="$(jget endpoint)"; CID="$(jget client_id)"; RURI="$(jget redirect_uri)"
    echo "== App 实际使用的设置（来自二维码 / 设置链接）"
    echo "  issuer     : ${ISS:-<空>}"
    echo "  client_id  : ${CID:-<空>}"
    echo "  redirect   : ${RURI:-<空>}"
    echo "  endpoint   : ${EP:-<空>}"
    echo
    echo "== 这两个地址的主机名在本服务器上解析到"
    warn=0
    for u in "$ISS" "$EP"; do
      [ -n "$u" ] || continue
      h="${u#*://}"; h="${h%%/*}"; h="${h%%:*}"
      a="$(getent ahosts "$h" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
      [ -n "$a" ] || a="$h"
      echo "  · $h → ${a:-<解析失败>}"
      for ip in $a; do
        case "$ip" in
          10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|127.*|fd*|fe80*|::1)
            echo "    ✘ $ip 是内网地址：只有内网 / 办公网（白名单 IP 所在网络）能访问，4G 等外网的 App 访问不到"; warn=1 ;;
        esac
      done
      case "$u" in http://*) echo "    ⚠ $u 是 http：App 要求 HTTPS"; warn=1 ;; esac
    done
    [ "$warn" = 1 ] || echo "  ✔ 本服务器看到的是公网地址（外网是否放行，还要在客户端网络上实测，见下）"
    echo
    echo "== 发现文档里 App 要访问的 OIDC 端点"
    URLS=""
    if [ -n "$ISS" ]; then
      DISC="${ISS%/}/.well-known/openid-configuration"
      URLS="$DISC"
      DJSON="$(curl -sS -m 10 "$DISC" 2>/dev/null || docker exec wg-easy wget -q -T 8 -O - "$DISC" 2>/dev/null || true)"
      if [ -z "$DJSON" ]; then
        echo "  ✘ 从本服务器也取不到 $DISC"
      else
        for k in authorization_endpoint token_endpoint userinfo_endpoint jwks_uri; do
          v="$(printf '%s' "$DJSON" | grep -oE "\"$k\" *: *\"[^\"]+\"" | head -n 1 | sed -E 's/.*: *"([^"]+)"/\1/')"
          [ -z "$v" ] || { echo "  · $k: $v"; URLS="$URLS $v"; }
        done
      fi
    fi
    [ -z "$EP" ] || URLS="$URLS $EP"
    echo
    echo "== 在非白名单网络（手机 4G 热点下的电脑）逐条执行；或手机浏览器逐个打开"
    echo "   任何 HTTP 状态码都说明网络通；000 / 超时说明 App 在这个网络上走不通这一步"
    echo "-----------------------------------------------------------------"
    for u in $URLS; do
      printf "curl -sS -o /dev/null -m 10 -w '%%{http_code} %%{time_total}s  %s\\\\n' '%s'\n" "$u" "$u"
    done
    echo "-----------------------------------------------------------------"
    echo "   App 同步顺序：issuer 发现 → 浏览器打开 authorization_endpoint 登录 → token_endpoint 换 / 刷新令牌 → 请求 endpoint。"
    echo "   前面任一步不通，App 就会超时，而且请求根本不会到 wg-easy（--watch 里看不到）"
    exit 0
    ;;
  --dns)
    shift
    HOSTS="$*"
    if [ -z "$HOSTS" ]; then
      H1="$(docker exec wg-easy-caddy printenv WG_WEB_HOST 2>/dev/null || true)"
      O="$(docker exec wg-easy printenv OAUTH_OIDC_SERVER 2>/dev/null || true)"
      H2="${O#*://}"; H2="${H2%%/*}"; H2="${H2%%:*}"
      HOSTS="$H1 $H2"
    fi
    HOSTS="$(echo $HOSTS)"
    [ -n "$HOSTS" ] || { echo "用法：$0 --dns <wg-easy 域名> <Authentik 域名>"; exit 2; }
    command -v dig >/dev/null 2>&1 || { echo "需要 dig：apt install -y dnsutils（CentOS：yum install -y bind-utils）"; exit 1; }
    RES="${DNS_RESOLVERS:-system 223.5.5.5 119.29.29.29 114.114.114.114 8.8.8.8}"
    q() {
      local s=""
      [ "$3" = system ] || s="@$3"
      dig +short +time=3 +tries=1 $s "$2" "$1" 2>/dev/null | grep -E "$4" | sort -u | tr '\n' ' '
    }
    any6=0
    for h in $HOSTS; do
      echo "== $h"
      cn="$(dig +short +time=3 +tries=1 "$h" CNAME 2>/dev/null | tr '\n' ' ')"
      [ -z "$cn" ] || echo "  · CNAME：$cn（AAAA 也可能来自 CNAME 指向的 CDN / 负载均衡）"
      a_all=""; six=""
      for r in $RES; do
        a="$(q A "$h" "$r" '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')"
        aaaa="$(q AAAA "$h" "$r" '^[0-9a-fA-F]*:[0-9a-fA-F:.]*$')"
        printf '  · %-16s A: %-34s AAAA: %s\n' "$r" "${a:-<无>}" "${aaaa:-<无>}"
        a_all="$a_all $a"; six="$six $aaaa"
      done
      nA="$(echo $a_all | tr ' ' '\n' | sed '/^$/d' | sort -u | grep -c . || true)"
      if [ -n "$(echo $six)" ]; then
        any6=1
        echo "  ✘ 有 AAAA（IPv6）记录：iOS 在 4G 上会优先连这些 IPv6 地址，IPv6 不通时同步就会卡住"
      else
        echo "  ✔ 没有 AAAA：客户端只会走 IPv4（纯 IPv6 的 4G 网络由运营商 NAT64 转成 IPv4），不存在 IPv6 优先的问题"
      fi
      [ "${nA:-0}" -le 1 ] || echo "  ⚠ 不同 DNS 返回的 A 记录不一样：域名按线路 / 地区返回不同地址（智能解析），4G 用户可能被解析到别的 IP"
    done
    echo
    echo "== 在 4G 热点下的电脑上执行（用运营商 DNS 解析，和上面对比）"
    for h in $HOSTS; do
      echo "nslookup -type=A $h"
      echo "nslookup -type=AAAA $h"
    done
    echo "  A 记录应和上面一致，AAAA 应为空。不一致时去 DNS 服务商（如 DNSPod）检查“线路”类记录（移动 / 联通 / 电信 / 境外），"
    echo "  以及 CDN 或 DNS 的“IPv6 自动解析”开关"
    if [ "$any6" = 1 ]; then
      echo
      echo "== 让客户端改走 IPv4：删除上面的 AAAA 记录（或关闭 CDN / DNS 的 IPv6 解析），等 TTL 过期后再试"
      echo "   确认是否 IPv6 不通：在 4G 热点下的电脑上分别执行 curl -4 / curl -6 访问同一地址，-6 超时即是"
    fi
    exit 0
    ;;
  --oidc)
    OIDC="$(docker exec wg-easy printenv OAUTH_OIDC_SERVER 2>/dev/null || true)"
    if [ -z "$OIDC" ]; then
      echo "wg-easy 没有设置 OAUTH_OIDC_SERVER 环境变量：OIDC 可能是在管理面板（管理 → OIDC）里配置的，环境变量看不到。"
      echo "改用 App 实际使用的设置链接检查：bash $0 --setup '<livewireguard://setup?d=...>'"
      exit 1
    fi
    echo "注意：管理面板（管理 → OIDC）里的设置优先于环境变量；以 App 实际使用的为准，用 --setup 检查更可靠"
    DISC="${OIDC%/}/.well-known/openid-configuration"
    echo "== OIDC 服务：$OIDC"
    DJSON="$(docker exec wg-easy wget -q -T 8 -O - "$DISC" 2>/dev/null || true)"
    URLS="$DISC"
    if [ -z "$DJSON" ]; then
      echo "  ✘ 从服务器取不到发现文档：$DISC"
    else
      echo "  ✔ 从服务器取到发现文档"
      for k in authorization_endpoint token_endpoint userinfo_endpoint jwks_uri; do
        v="$(printf '%s' "$DJSON" | grep -oE "\"$k\" *: *\"[^\"]+\"" | head -n 1 | sed -E 's/.*: *"([^"]+)"/\1/')"
        [ -z "$v" ] || { echo "  · $k: $v"; URLS="$URLS $v"; }
      done
    fi
    W_HOST="$(docker exec wg-easy-caddy printenv WG_WEB_HOST 2>/dev/null || true)"
    [ -z "$W_HOST" ] || URLS="$URLS https://$W_HOST:51821/api/livewireguard/config"
    echo
    echo "== 在客户端所在网络执行（手机 4G 热点下的电脑；或手机浏览器逐个打开）"
    echo "   任何 HTTP 状态码（200/302/400/401/405）都说明网络通；000 或超时说明这个地址对该网络不可达"
    echo "-----------------------------------------------------------------"
    for u in $URLS; do
      printf "curl -sS -o /dev/null -m 10 -w '%%{http_code} %%{time_total}s  %s\\\\n' '%s'\n" "$u" "$u"
    done
    echo "-----------------------------------------------------------------"
    echo "   客户端同步前要先在浏览器里打开 authorization_endpoint 登录，再由客户端访问 token / userinfo / jwks，"
    echo "   最后才请求 wg-easy。OIDC 任一端点不可达，客户端就会超时，wg-easy / Caddy 日志里也不会有记录"
    exit 0
    ;;
  -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
esac

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
GATE="$(docker exec "$C" printenv WG_ADMIN_GATE 2>/dev/null || true)"
GATE="${GATE:-on}"
if [ "$GATE" = off ]; then
  info "管理员 IP 开关：off（所有 IP 都能访问登录页和后台，白名单只用于 CrowdSec 不封禁）"
else
  info "管理员 IP 开关：$GATE（非管理员 IP 只能访问 WG_PUBLIC_PATHS）"
fi

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

echo
echo "== 8. 客户端同步前要先登录的 OIDC 服务（Authentik）"
OIDC="$(docker exec "$W" printenv OAUTH_OIDC_SERVER 2>/dev/null || true)"
if [ -z "$OIDC" ]; then
  info "wg-easy 没有设置 OAUTH_OIDC_SERVER"
else
  DISC="${OIDC%/}/.well-known/openid-configuration"
  info "OIDC 服务：$OIDC"
  r="$(docker exec "$W" wget -q -T 8 -O /dev/null -S "$DISC" 2>&1 | grep -m1 -E 'HTTP/|timed out|bad address|refused' || true)"
  case "$r" in
    *" 200"*) ok "从服务器访问发现地址正常：$(echo "$r" | sed -E 's/^ *//')" ;;
    "")      bad "从服务器访问发现地址没有响应：$DISC" ;;
    *)       bad "从服务器访问发现地址异常：$(echo "$r" | sed -E 's/^ *//')" ;;
  esac
  info "客户端也要能访问它。在非管理员网络（如手机 4G）上执行："
  info "  curl -sS -o /dev/null -w '%{http_code} %{time_total}s\\n' $DISC"
  info "超时说明 OIDC 服务只对办公网/内网开放：客户端拿不到令牌，同步就会超时，请求也不会出现在本机 Caddy 日志里"
  info "完整的端点列表和测试命令：bash scripts/diagnose-public.sh --oidc"
fi

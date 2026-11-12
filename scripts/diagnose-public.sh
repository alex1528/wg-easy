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
#   sudo bash scripts/diagnose-public.sh --lines [线路IP ...] # 双线服务器：检查每条线路的入口、回程路由，给出修正命令
#   sudo bash scripts/diagnose-public.sh --trace [秒数]       # 逐层计数：SYN 到网卡 → rp_filter → 转发给容器 → SYN-ACK 从哪张网卡出
#
# 客户端同步超时、但 --watch 里什么都没出现：请求根本没到这台服务器的 Caddy，
#   问题在客户端连的地址、DNS、上游防火墙/安全组，或者客户端卡在 OIDC 登录（第 8 步）
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=caddy/logs/access.log

# 当前部署实际使用的 compose 文件（容器标签里记录的），找不到时用 docker-compose-dirty.yml
compose_file() {
  local f
  f="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' wg-easy-caddy 2>/dev/null || true)"
  f="${f%%,*}"
  if [ -n "$f" ] && [ "$f" != "<no value>" ]; then basename "$f"; else echo docker-compose-dirty.yml; fi
}

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
    # 抓 51821 的 SYN（客户端发起）和 SYN-ACK（服务器回应），每次新连接两行；
    # 去掉 Docker 网桥上的那一份（10.42.42.0/24）和本机自测
    F='tcp port 51821 and (tcp[tcpflags] & tcp-syn) != 0 and not net 10.42.42.0/24 and not host 127.0.0.1'
    [ -z "$IP" ] || F="$F and host $IP"
    echo "抓取 51821 的 TCP 建连${IP:+（只看 $IP）}，Ctrl+C 结束"
    echo "  本机网卡："
    ip -4 -o addr show 2>/dev/null | awk '$2 != "lo" && $2 !~ /^(docker|br-|veth)/ {print "    · " $2 "  " $4}'
    echo "  建议另开一个终端同时运行：bash scripts/diagnose-public.sh --watch"
    echo "  · 只有 SYN [S]，没有 SYN-ACK [S.]          = 包到了网卡，被本机防火墙丢弃或没有转给 Caddy"
    echo "  · [S] 从网卡 A 进、[S.] 从网卡 B 出         = 双线回程走错线路（运营商会丢掉），见 --lines"
    echo "  · [S] 和 [S.] 都有，--watch 没有           = TCP 通了，TLS 握手失败，看 docker logs wg-easy-caddy"
    echo "  · 什么都没有                               = 请求没到这台服务器（上游端口转发 / 防火墙 / 客户端地址）"
    echo "  （tcpdump 4.99 及以上会在每行开头显示网卡名和 In / Out）"
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
      if [ "${nA:-0}" -eq 0 ] && [ -z "$(echo $six)" ]; then
        echo "  ✘ 所有 DNS 都解析不到任何地址：域名拼写错误，或还没有添加解析记录"
        continue
      fi
      if [ -n "$(echo $six)" ]; then
        any6=1
        echo "  ✘ 有 AAAA（IPv6）记录：iOS 在 4G 上会优先连这些 IPv6 地址，IPv6 不通时同步就会卡住"
      else
        echo "  ✔ 没有 AAAA：客户端只会走 IPv4（纯 IPv6 的 4G 网络由运营商 NAT64 转成 IPv4），不存在 IPv6 优先的问题"
      fi
      if [ "${nA:-0}" -gt 1 ]; then
        echo "  ⚠ 不同 DNS 返回的 A 记录不一样：域名按线路 / 地区返回不同地址（智能解析），4G 用户可能被解析到别的 IP"
        for ip in $(echo $a_all | tr ' ' '\n' | sed '/^$/d' | sort -u); do
          echo "    · $ip 的 51821（从本机访问，只说明这个地址上有没有服务在应答）："
          r="$(curl -sk -o /dev/null -m 6 -w '%{http_code}' --resolve "$h:51821:$ip" "https://$h:51821/api/livewireguard/config" 2>/dev/null || true)"
          echo "      HTTP ${r:-000}（400 = wg-easy 在应答；000 = 不通或不是这套服务）"
        done
      fi
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
  --lines)
    shift
    command -v ip >/dev/null 2>&1 || { echo "需要 iproute2（ip 命令）"; exit 1; }
    LIPS="$*"
    H="$(docker exec wg-easy-caddy printenv WG_WEB_HOST 2>/dev/null || true)"
    if [ -z "$LIPS" ] && [ -n "$H" ] && command -v dig >/dev/null 2>&1; then
      LIPS="$(for r in "" @223.5.5.5 @119.29.29.29 @114.114.114.114 @8.8.8.8; do
        dig +short +time=3 +tries=1 $r "$H" A 2>/dev/null; done | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u | tr '\n' ' ')"
    fi
    LIPS="$(echo $LIPS)"
    [ -n "$LIPS" ] || { echo "用法：sudo $0 --lines <线路1公网IP> <线路2公网IP>"; exit 2; }
    echo "== 线路公网 IP：$LIPS${H:+（$H 在各 DNS 的解析结果）}"
    echo
    echo "== 本机网卡 IPv4"
    ip -4 -o addr show | awk '$2 != "lo" {print "  · " $2 "  " $4}'
    echo "== 默认路由"
    ip -4 route show default | sed 's/^/  · /'
    ndef="$(ip -4 route show default | grep -c . || true)"
    # 先存进变量：规则多时 "ip rule show | grep -q" 会因 SIGPIPE + pipefail 误判
    RULES_NOW="$(ip -4 rule show)"
    echo "== 策略路由（ip rule，共 $(grep -c . <<<"$RULES_NOW") 条；相同规则合并显示，括号里是条数）"
    sed -E 's/^[0-9]+:[[:space:]]+//' <<<"$RULES_NOW" | awk '{c[$0]++; if (c[$0] == 1) o[++n] = $0} END {for (i = 1; i <= n; i++) printf "  · %s%s\n", o[i], (c[o[i]] > 1 ? "  (" c[o[i]] ")" : "")}' | head -n 60
    nfw="$(grep -cE 'from all fwmark 0x[0-9a-f]+/0xff lookup' <<<"$RULES_NOW" || true)"
    echo
    nlocal=0; HOST_BAD=0; DOCKER_BAD=0; DL_ON=0; RPF_BAD=0
    CIP_L="${TRACE_CADDY_IP:-10.42.42.43}"
    BR="$(ip -4 route get "$CIP_L" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1)"
    if [ "${nfw:-0}" -gt 0 ]; then DL_ON=1; fi
    for ip in $LIPS; do
      dev="$(ip -4 -o addr show | awk -v ip="$ip" '{split($4, a, "/"); if (a[1] == ip) print $2}' | head -n 1)"
      echo "== 线路 $ip"
      if [ -z "$dev" ]; then
        echo "  · 不是本机网卡上的地址：由前置路由器 / 防火墙做端口转发进来"
        echo "    请在这条线路的出口设备上确认，并且不要限制来源 IP："
        echo "      51821/tcp → 本机 51821（Web UI、同步配置）"
        echo "      51820/udp → 本机 51820（WireGuard 隧道）"
        echo "      80/tcp    → 本机 80（仅 CADDY_TLS_MODE=http 需要）"
        continue
      fi
      nlocal=$((nlocal + 1))
      echo "  · 本机网卡 $dev 上的地址"
      via="$(ip -4 route get 1.1.1.1 from "$ip" 2>/dev/null | head -n 1)"
      odev="$(printf '%s' "$via" | sed -nE 's/.* dev ([^ ]+).*/\1/p')"
      echo "  · 以 $ip 为源地址的回程：${via:-<无路由>}"
      if [ -n "$odev" ] && [ "$odev" != "$dev" ]; then
        echo "  ✘ 本机进程的回程从 $odev 出去，不是进来的 $dev：先给这条线路配 \"from $ip lookup <表>\" 策略路由"
        HOST_BAD=1
      else
        echo "  ✔ 本机进程（如 sshd）的回程走 $dev"
      fi
      rp_a="$(cat /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null || echo 0)"
      rp_d="$(cat "/proc/sys/net/ipv4/conf/$dev/rp_filter" 2>/dev/null || echo 0)"
      rp_e=$(( rp_a > rp_d ? rp_a : rp_d ))
      if [ "$rp_e" = 1 ]; then
        echo "  ✘ rp_filter 严格模式（all=$rp_a $dev=$rp_d）：从 $dev 进来、DNAT 到容器的连接会被内核丢弃"
        RPF_BAD=1
      else
        echo "  ✔ rp_filter=$rp_e（all=$rp_a $dev=$rp_d），不会丢弃 DNAT 到容器的连接"
      fi
      if [ -n "$BR" ]; then
        cvia="$(ip -4 route get 1.1.1.1 from "$CIP_L" iif "$BR" 2>/dev/null | head -n 1)"
        cdev="$(printf '%s' "$cvia" | sed -nE 's/.* dev ([^ ]+).*/\1/p')"
        if [ "$DL_ON" = 1 ]; then
          echo "  · Docker 容器回包：已启用 deploy/dual-line-route.sh（fwmark 规则 $nfw 条，按连接标记选线路），详情 sudo bash deploy/dual-line-route.sh status"
        elif [ -n "$cdev" ] && [ "$cdev" != "$dev" ]; then
          echo "  ✘ Docker 容器（Caddy / wg-easy）的回包：$cvia"
          echo "    从 $cdev 出去，不是 $dev。51821/tcp、51820/udp 是 DNAT 到容器的，回包源地址是 10.42.42.x，"
          echo "    匹配不到 \"from $ip\" 策略路由，只能走默认路由：普通外网客户端收不到回包"
          DOCKER_BAD=1
        else
          echo "  ✔ Docker 容器回包也走 $dev"
        fi
      fi
    done
    echo
    nl="$(echo $LIPS | wc -w)"
    if [ "${nfw:-0}" -gt $((nl + 1)) ]; then
      echo "== ⚠ fwmark 规则有 $nfw 条，远多于线路数：旧版 dual-line-route.sh 把重复的 from 规则当成多条线路。"
      echo "   更新脚本后执行 sudo bash deploy/dual-line-route.sh apply，会先清理再按去重后的线路重建"
    fi
    if [ "$nlocal" -eq 0 ]; then
      echo "== 结论：线路 IP 都不在本机网卡上，由前置设备转发。本机不用改，检查前置设备的 51821/tcp 转发和来源限制"
    elif [ "$DOCKER_BAD" = 1 ]; then
      echo "== 结论：Docker 发布端口的回包走默认路由，不走进来的线路。这就是“只有部分来源能同步配置”的原因"
      echo "   能用的只有默认网关能路由回去的地址（如公司其他出口 = 管理员白名单里的 IP），和白名单功能本身无关"
      echo "   修正：sudo bash deploy/dual-line-route.sh apply      # 立即生效；有问题 remove 回退"
      echo "         sudo bash deploy/dual-line-route.sh install    # 确认没问题后，安装为开机自动生效"
      echo "   验证：sudo bash deploy/dual-line-route.sh status，再在 4G 下执行下面的 curl"
    elif [ "$HOST_BAD" = 0 ]; then
      echo "== 结论：本机进程和 Docker 容器的回程都走原线路"
    fi
    if [ "$RPF_BAD" = 1 ]; then
      echo "== rp_filter：线路网卡是严格模式。DNAT 之后反向路由查到默认网关，从线路网卡进来、转给容器的连接会被内核丢弃"
      echo "   修正：sudo bash deploy/dual-line-route.sh apply（会把线路网卡 rp_filter 设为 2）"
    fi
    echo
    echo "== 在 4G 热点下的电脑上逐条执行（直接指定线路 IP，绕开智能解析）"
    for ip in $LIPS; do
      echo "curl -sS -o /dev/null -m 10 -w '%{http_code} %{time_total}s  $ip\\n' --resolve ${H:-vrh.verycloud.cn}:51821:$ip https://${H:-vrh.verycloud.cn}:51821/api/livewireguard/config"
    done
    echo "  每条都应返回 400（Missing headers）；某条超时或 000 = 这条线路的 51821 不通"
    echo
    echo "== hairpin（隧道内访问 Web UI）也要覆盖所有线路：.env 中设置"
    echo "   WG_HAIRPIN_DST4=$LIPS"
    echo "   然后 docker compose -f $(compose_file) up -d --no-build --force-recreate wg-easy"
    exit 0
    ;;
  --trace)
    SECS="${2:-60}"
    case "$SECS" in ''|*[!0-9]*) echo "用法：sudo bash $0 --trace [秒数，默认 60]"; exit 2 ;; esac
    [ "$(id -u)" = 0 ] || { echo "需要 root：sudo bash $0 --trace $SECS"; exit 1; }
    command -v iptables >/dev/null 2>&1 || { echo "需要 iptables"; exit 1; }
    TT=wgdiag
    CIP="${TRACE_CADDY_IP:-10.42.42.43}"
    TP=51821
    DEVS="$(ip -4 -o addr show | awk '$2 != "lo" && $2 !~ /^(docker|br-|veth)/ {print $2}' | sort -u | tr '\n' ' ')"
    rpd() { awk '/^TcpExt:/ { if (!h) { for (i = 2; i <= NF; i++) n[i] = $i; h = 1 } else { for (i = 2; i <= NF; i++) if (n[i] == "IPReversePathFilter") v = $i } } END { print v + 0 }' /proc/net/netstat 2>/dev/null; }
    cnt() { iptables -t "$1" -L "$2" -v -n -x 2>/dev/null | awk -v k="/* $3 */" 'index($0, k) { s += $1 } END { print s + 0 }'; }
    tclean() {
      local tb l
      for tb in raw mangle filter; do
        while IFS= read -r l; do
          [ -n "$l" ] || continue
          read -ra a <<<"$l"; a[0]=-D
          iptables -t "$tb" "${a[@]}" 2>/dev/null || true
        done < <(iptables -t "$tb" -S 2>/dev/null | grep -F -- "--comment $TT-" || true)
      done
    }
    tclean
    trap 'tclean; echo; echo "已删除临时计数规则"; exit 130' INT TERM
    for d in $DEVS; do
      iptables -t raw -I PREROUTING 1 -i "$d" -p tcp --dport "$TP" --syn -m comment --comment "$TT-in-$d"
      iptables -t mangle -I POSTROUTING 1 -o "$d" -p tcp --sport "$TP" --tcp-flags SYN,ACK SYN,ACK -m comment --comment "$TT-out-$d"
    done
    iptables -t filter -I FORWARD 1 -d "$CIP" -p tcp --dport "$TP" --syn -m comment --comment "$TT-fwd"
    R0="$(rpd)"
    H="$(docker exec wg-easy-caddy printenv WG_WEB_HOST 2>/dev/null || true)"; H="${H:-vrh.verycloud.cn}"
    echo "已插入临时计数规则（只计数，不改变任何流量）。网卡：$DEVS"
    echo "接下来 $SECS 秒内（按回车提前结束），只用 4G 网络执行下面的命令，或在 App 里点“立即同步配置”："
    for d in $DEVS; do
      for ad in $(ip -4 -o addr show dev "$d" | awk '{split($4, x, "/"); print x[1]}'); do
        case "$ad" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) continue ;; esac
        echo "  curl -sS -o /dev/null -m 10 -w '%{http_code}\\n' --resolve $H:$TP:$ad https://$H:$TP/api/livewireguard/config"
      done
    done
    echo "  测试期间不要从白名单网络访问，否则会混进统计"
    if [ -t 0 ]; then read -r -t "$SECS" _ || true; else sleep "$SECS"; fi
    R1="$(rpd)"
    tin=0; tout=0; ins=""; outs=""
    echo
    echo "== 统计"
    for d in $DEVS; do
      i="$(cnt raw PREROUTING "$TT-in-$d")"; o="$(cnt mangle POSTROUTING "$TT-out-$d")"
      printf '  · %-8s 进来的 SYN：%-5s 发出的 SYN-ACK：%s\n' "$d" "$i" "$o"
      tin=$((tin + i)); tout=$((tout + o))
      if [ "$i" -gt 0 ]; then ins="$ins $d"; fi
      if [ "$o" -gt 0 ]; then outs="$outs $d"; fi
    done
    fwd="$(cnt filter FORWARD "$TT-fwd")"
    rpdelta=$(( ${R1:-0} - ${R0:-0} ))
    echo "  · 转发给容器 $CIP:$TP 的 SYN：$fwd"
    echo "  · 内核反向路径过滤（rp_filter）新增丢包：$rpdelta"
    tclean; trap - INT TERM
    echo "  （临时计数规则已删除）"
    echo
    echo "== 结论"
    if [ "$tin" -eq 0 ]; then
      echo "  ✘ 没有任何发往 $TP 的新连接到达本机网卡：包在到达服务器之前就被丢了（上游 ACL / 安全组 / 运营商），"
      echo "    或者测试时连的不是本机 IP。这里的计数在本机所有防火墙和路由之前，本机配置改不了这种情况"
    elif [ "$fwd" -eq 0 ]; then
      if [ "$rpdelta" -gt 0 ]; then
        echo "  ✘ 连接到了网卡（$ins），但被内核反向路径过滤丢弃（rp_filter 严格模式）："
        echo "    Docker 端口是 DNAT 到容器的，DNAT 之后反向路由按 $CIP 查，匹配不到 from <线路IP> 规则，"
        echo "    查到默认网关所在的网卡，和进来的网卡不一致"
        echo "    修正：sudo bash deploy/dual-line-route.sh apply   # 会把线路网卡 rp_filter 设为 2（宽松）"
      else
        echo "  ✘ 连接到了网卡（$ins），但没有转发给容器：在转发前被本机丢弃。检查："
        echo "    iptables -t raw -S PREROUTING; iptables -t mangle -S PREROUTING; iptables -t nat -S PREROUTING"
        echo "    firewall-cmd --state && firewall-cmd --list-all-zones   # firewalld 的 zone 来源限制"
      fi
    elif [ "$tout" -eq 0 ]; then
      echo "  ✘ 转发给了容器，但没有 SYN-ACK 发出：Caddy 没在 $CIP:$TP 监听，或回包在本机被丢弃（iptables -S FORWARD、DOCKER-USER）"
    else
      bad_out=""
      for d in $outs; do case " $ins " in *" $d "*) ;; *) bad_out="$bad_out $d" ;; esac; done
      if [ -n "$bad_out" ]; then
        echo "  ✘ SYN 从$ins 进来，SYN-ACK 却从$bad_out 发出：回包走错线路，运营商会丢掉"
        echo "    修正：sudo bash deploy/dual-line-route.sh apply，再 sudo bash deploy/dual-line-route.sh status 确认"
      else
        echo "  ✔ 网络层正常：SYN 从$ins 进来，SYN-ACK 从同一网卡发出"
        echo "    仍然超时就是 TLS / HTTP 层的问题：同时运行 --watch，并看 docker logs --since 5m wg-easy-caddy"
      fi
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
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
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
  info "docker compose -f $(compose_file) up -d --no-build --force-recreate caddy"
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

#!/bin/sh
# wg-easy 启动包装：VPN 客户端在隧道内访问【本机】Web UI 时，直接在容器内转给 Caddy，不再绕公网
#
# 问题：隧道建立后（AllowedIPs 包含 0.0.0.0/0 或服务器公网 IP），客户端访问
#   https://<WG_WEB_HOST>:51821 的流量会先进隧道，到 wg-easy 容器后再出公网回到服务器自己的公网 IP。
#   这条“回环”路径常被拦住：服务器在路由器/防火墙 NAT 后面且不支持 NAT 回流，
#   或宿主机防火墙丢弃来自 Docker 网桥的入站。表现就是请求超时，访问其他网站正常。
#
# 做法：在 wg-easy 容器里，把从 wg0 进来、【目的地址是本机公网 IP】、目的端口是 51821 的 TCP
#   直接 DNAT 到 Caddy（10.42.42.43:51821）。域名、证书、URL 都不变。
#   另外给进出 wg0 的 TCP 做 MSS 钳制，避免大包（如 TLS 证书链）在隧道里被丢导致握手卡住。
#
# 目的地址必须限定为本机：多台服务器用同一份配置时（vpn1、vpn2），连着 vpn1 的隧道去访问
#   vpn2:51821，流量也从 vpn1 的 wg0 进来；不限目的地址就会被 vpn1 的 Caddy 截走，
#   客户端拿到的是 vpn1 对 vpn2 域名的空响应（“不是有效的 JSON”）。
#
# 目的地址来源（按优先级）：
#   WG_HAIRPIN_DST4 / WG_HAIRPIN_DST6 显式填写（空格分隔）；填 any 表示不限目的地址（只有单台服务器时可用）
#   否则启动时解析 WG_HAIRPIN_HOST（compose 里取 WG_WEB_HOST）的 A / AAAA 记录
#   解析不到时该地址族不加 DNAT 规则（只警告），绝不退回“不限目的地址”
#
# 规则失败只打印警告，不阻止 wg-easy 启动（VPN 优先）。
# 规则建在容器自己的网络命名空间里，容器重启后由本脚本重新添加；wg-easy 重启接口（PostDown/PostUp）不会删除它们。
# 域名改了解析，需要重启 wg-easy 容器才会更新规则。

ENABLE="${WG_HAIRPIN:-true}"
DEV="${WG_HAIRPIN_DEV:-wg0}"
# 客户端访问的目的端口，空格分隔
DPORTS="${WG_HAIRPIN_DPORTS:-51821}"
HOST="${WG_HAIRPIN_HOST:-}"
DST4="${WG_HAIRPIN_DST4:-}"
DST6="${WG_HAIRPIN_DST6:-}"
# Caddy 在内部网络的地址和端口（与 docker-compose-dirty.yml 中 caddy 的 ipv4_address / ipv6_address 一致）
CADDY4="${WG_HAIRPIN_CADDY_IPV4:-10.42.42.43}"
CADDY6="${WG_HAIRPIN_CADDY_IPV6:-fdcc:ad94:bacf:61a3::2b}"
CADDY_PORT="${WG_HAIRPIN_CADDY_PORT:-51821}"

log() { echo "[hairpin] $*"; }

# rule <iptables|ip6tables> <表> <链> <匹配条件...>：已存在则跳过，失败只警告
rule() {
  bin="$1"; tbl="$2"; shift 2
  command -v "$bin" >/dev/null 2>&1 || { log "WARN: 没有 $bin，跳过：$*"; return 0; }
  if "$bin" -t "$tbl" -C "$@" 2>/dev/null; then
    return 0
  fi
  if "$bin" -t "$tbl" -A "$@" 2>/dev/null; then
    log "+ $bin -t $tbl -A $*"
  else
    log "WARN: 添加失败：$bin -t $tbl -A $*"
  fi
}

# unrule <iptables|ip6tables> <表> <链> <匹配条件...>：存在则删除（清理旧版本留下的“不限目的地址”规则）
unrule() {
  bin="$1"; tbl="$2"; shift 2
  command -v "$bin" >/dev/null 2>&1 || return 0
  while "$bin" -t "$tbl" -C "$@" 2>/dev/null; do
    "$bin" -t "$tbl" -D "$@" 2>/dev/null || break
    log "- $bin -t $tbl -D $*"
  done
}

# resolve <4|6> <域名>：用镜像自带的 node 解析，每行输出一个地址；最多重试 3 次（容器刚启动时 DNS 可能还没就绪）
resolve() {
  fam="$1"; name="$2"
  command -v node >/dev/null 2>&1 || return 1
  n=0
  while [ "$n" -lt 3 ]; do
    out="$(node -e '
      const dns = require("dns").promises;
      dns.lookup(process.argv[1], { all: true, family: Number(process.argv[2]) })
        .then(r => { for (const a of r) console.log(a.address); })
        .catch(() => process.exit(1));
    ' "$name" "$fam" 2>/dev/null)" && [ -n "$out" ] && { echo "$out" | sort -u; return 0; }
    n=$((n + 1)); sleep 2
  done
  return 1
}

# targets <4|6> <显式值>：输出目的地址列表；any → 输出 any；都没有 → 输出空
targets() {
  fam="$1"; explicit="$2"
  if [ -n "$explicit" ]; then
    echo "$explicit" | tr ' ' '\n' | sed '/^$/d'
    return 0
  fi
  if [ -n "$HOST" ]; then
    if r="$(resolve "$fam" "$HOST")"; then
      echo "$r"
      return 0
    fi
    log "WARN: 解析 $HOST 的 IPv$fam 地址失败" >&2
  fi
  return 0
}

dnat() {
  fam="$1"; list="$2"
  if [ "$fam" = 4 ]; then bin=iptables; to="$CADDY4:$CADDY_PORT"; else bin=ip6tables; to="[$CADDY6]:$CADDY_PORT"; fi
  for p in $DPORTS; do
    if [ "$list" = any ]; then
      log "WARN: IPv$fam 不限目的地址：隧道内访问任何服务器的 tcp/$p 都会转给本机 Caddy（多台服务器时不要用）"
      rule "$bin" nat PREROUTING -i "$DEV" -p tcp --dport "$p" -j DNAT --to-destination "$to"
      continue
    fi
    # 旧版本默认不限目的地址，这里先删掉，避免截走访问其他服务器的流量
    unrule "$bin" nat PREROUTING -i "$DEV" -p tcp --dport "$p" -j DNAT --to-destination "$to"
    if [ -z "$list" ]; then
      log "WARN: 没有 IPv$fam 目的地址，不添加 tcp/$p 的 DNAT（设置 WG_HAIRPIN_DST$fam 或检查 WG_HAIRPIN_HOST 的解析）"
      continue
    fi
    for d in $list; do
      rule "$bin" nat PREROUTING -i "$DEV" -p tcp -d "$d" --dport "$p" -j DNAT --to-destination "$to"
    done
  done
}

mss() {
  for bin in iptables ip6tables; do
    rule "$bin" mangle FORWARD -i "$DEV" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
    rule "$bin" mangle FORWARD -o "$DEV" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
  done
}

case "$ENABLE" in
  true|1|yes)
    T4="$(targets 4 "$DST4" | tr '\n' ' ' | sed 's/ *$//')"
    T6="$(targets 6 "$DST6" | tr '\n' ' ' | sed 's/ *$//')"
    case " $T4 " in *" any "*) T4=any ;; esac
    case " $T6 " in *" any "*) T6=any ;; esac
    log "本机地址：IPv4=[${T4:-无}] IPv6=[${T6:-无}]；tcp/${DPORTS} → Caddy ${CADDY4}:${CADDY_PORT} / [${CADDY6}]:${CADDY_PORT}"
    dnat 4 "$T4"
    dnat 6 "$T6"
    mss
    ;;
  *)
    log "WG_HAIRPIN=$ENABLE，跳过"
    ;;
esac

# 交给 wg-easy 原来的启动命令（compose 的 command）
if [ "$#" -eq 0 ]; then
  set -- /usr/bin/dumb-init node server/index.mjs
fi
exec "$@"

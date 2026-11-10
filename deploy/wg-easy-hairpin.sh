#!/bin/sh
# wg-easy 启动包装：VPN 客户端在隧道内访问本机 Web UI 时，直接在容器内转给 Caddy，不再绕公网
#
# 问题：隧道建立后（AllowedIPs 包含 0.0.0.0/0 或服务器公网 IP），客户端访问
#   https://<WG_WEB_HOST>:51821 的流量会先进隧道，到 wg-easy 容器后再出公网回到服务器自己的公网 IP。
#   这条“回环”路径常被拦住：服务器在路由器/防火墙 NAT 后面且不支持 NAT 回流，
#   或宿主机防火墙丢弃来自 Docker 网桥的入站。表现就是请求超时，访问其他网站正常。
#
# 做法：在 wg-easy 容器里，把从 wg0 进来、目的端口是 51821 的 TCP 直接 DNAT 到 Caddy（10.42.42.43:51821）。
#   域名、证书、URL 都不变；Caddy 按 Host 头和 SNI 照常匹配站点。
#   另外给进出 wg0 的 TCP 做 MSS 钳制，避免大包（如 TLS 证书链）在隧道里被丢导致握手卡住。
#
# 规则失败只打印警告，不阻止 wg-easy 启动（VPN 优先）。
# 规则建在容器自己的网络命名空间里，容器重启后由本脚本重新添加；wg-easy 重启接口（PostDown/PostUp）不会删除它们。

ENABLE="${WG_HAIRPIN:-true}"
DEV="${WG_HAIRPIN_DEV:-wg0}"
# 客户端访问的目的端口，空格分隔
DPORTS="${WG_HAIRPIN_DPORTS:-51821}"
# 只拦截这些目的地址（服务器公网 IP），空格分隔；留空 = 不限目的地址（VPN 客户端访问任何地址的这些端口都会转给 Caddy）
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

dnat4() {
  for p in $DPORTS; do
    if [ -n "$DST4" ]; then
      for d in $DST4; do
        rule iptables nat PREROUTING -i "$DEV" -p tcp -d "$d" --dport "$p" -j DNAT --to-destination "$CADDY4:$CADDY_PORT"
      done
    else
      rule iptables nat PREROUTING -i "$DEV" -p tcp --dport "$p" -j DNAT --to-destination "$CADDY4:$CADDY_PORT"
    fi
  done
}

dnat6() {
  for p in $DPORTS; do
    if [ -n "$DST6" ]; then
      for d in $DST6; do
        rule ip6tables nat PREROUTING -i "$DEV" -p tcp -d "$d" --dport "$p" -j DNAT --to-destination "[$CADDY6]:$CADDY_PORT"
      done
    else
      rule ip6tables nat PREROUTING -i "$DEV" -p tcp --dport "$p" -j DNAT --to-destination "[$CADDY6]:$CADDY_PORT"
    fi
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
    log "VPN 客户端访问 tcp/${DPORTS} → Caddy ${CADDY4}:${CADDY_PORT} / [${CADDY6}]:${CADDY_PORT}"
    dnat4
    dnat6
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

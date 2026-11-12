#!/usr/bin/env bash
# 多线服务器：让 Docker 发布端口（51821/tcp、51820/udp 等）的回包从进来的那条线路出去
#
# 背景：本机每条公网线路都有 "from <线路IP> lookup <表>" 策略路由，本机进程（如 sshd）的回包没问题；
#   但 Docker 发布的端口是 DNAT 到容器的，容器回包的源地址是 10.42.42.x，选路时匹配不到
#   "from <线路IP>"，只能走 main 表的默认路由（如内网网关），源地址出网卡时才改回线路 IP。
#   结果：普通外网客户端收不到回包，只有默认网关能路由回去的地址（如公司其他出口）正常。
# 做法：从某条线路网卡进来的新连接打上连接标记（CONNMARK），容器的回包恢复标记后按 fwmark 查这条线路的路由表。
#
# 用法（root）：
#   bash deploy/dual-line-route.sh status      # 查看线路、规则、容器回包实际走哪张网卡（默认）
#   bash deploy/dual-line-route.sh apply       # 添加规则（幂等，可重复执行）
#   bash deploy/dual-line-route.sh remove      # 删除本脚本添加的全部规则
#   bash deploy/dual-line-route.sh install     # 安装 systemd 服务，开机自动 apply（并立即 apply）
#   bash deploy/dual-line-route.sh uninstall   # 卸载 systemd 服务并 remove
#
# 线路自动发现：ip rule 里的 "from <IP> lookup <表>"，且 IP 在本机网卡上、该表有默认路由
#   只处理部分线路：DUAL_LINE_ONLY="112.82.241.42 61.160.196.211"
#   探测容器回包用的源地址：DUAL_LINE_PROBE_SRC（默认 10.42.42.43，即 Caddy）
# 本脚本只改 mangle 表和 ip rule，不动 Docker 管理的 nat / filter 规则；firewalld reload 会清掉 mangle 规则，之后重新 apply
set -euo pipefail

ACTION="${1:-status}"
TAG=wg-easy-dual-line
MASK=0xff
MARK_BASE=16     # 0x10，第 1 条线路用 0x11
PRIO_BASE=100    # ip rule 优先级 101、102...，排在 "from <IP>" 规则（32763 起）前面
PROBE_SRC="${DUAL_LINE_PROBE_SRC:-10.42.42.43}"
PROBE_DST=1.1.1.1
UNIT=wg-easy-dual-line.service

die()  { echo "✘ $*" >&2; exit 1; }
ok()   { echo "  ✔ $*"; }
bad()  { echo "  ✘ $*"; }
info() { echo "  · $*"; }

case "$ACTION" in
  status|apply|remove|install|uninstall) ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) die "未知操作: $ACTION（status | apply | remove | install | uninstall）" ;;
esac
[ "$(id -u)" = 0 ] || die "需要 root：sudo bash $0 $ACTION"
command -v ip >/dev/null 2>&1 || die "需要 iproute2（ip 命令）"
command -v iptables >/dev/null 2>&1 || die "需要 iptables"

# 输出每行：线路IP 路由表 网卡 网关
discover() {
  ip -4 rule show | sed -nE 's/^[0-9]+:[[:space:]]+from ([0-9.]+) lookup ([^ ]+).*/\1 \2/p' \
  | while read -r lip tbl; do
      if [ -n "${DUAL_LINE_ONLY:-}" ]; then
        case " $DUAL_LINE_ONLY " in *" $lip "*) ;; *) continue ;; esac
      fi
      dev="$(ip -4 -o addr show | awk -v ip="$lip" '{split($4, a, "/"); if (a[1] == ip) print $2}' | head -n 1)"
      [ -n "$dev" ] || continue
      gw="$(ip -4 route show default table "$tbl" 2>/dev/null | sed -nE 's/.*via ([0-9.]+).*/\1/p' | head -n 1)"
      [ -n "$gw" ] || continue
      echo "$lip $tbl $dev $gw"
    done
}

mark_of() { printf '0x%x' $((MARK_BASE + $1)); }

ipt_add() { iptables -t mangle -C "$@" 2>/dev/null || iptables -t mangle -A "$@"; }

rules_for() {   # $1=add|check  $2=网卡 $3=标记
  local op="$1" dev="$2" mark="$3" rc=0 f
  for f in \
    "PREROUTING -i $dev -m conntrack --ctstate NEW -m comment --comment $TAG -j CONNMARK --set-xmark $mark/$MASK" \
    "PREROUTING ! -i $dev -m connmark --mark $mark/$MASK -m comment --comment $TAG -j CONNMARK --restore-mark --nfmask $MASK --ctmask $MASK" \
    "OUTPUT -m connmark --mark $mark/$MASK -m comment --comment $TAG -j CONNMARK --restore-mark --nfmask $MASK --ctmask $MASK"
  do
    # shellcheck disable=SC2086
    if [ "$op" = add ]; then ipt_add $f; else iptables -t mangle -C $f 2>/dev/null || rc=1; fi
  done
  return $rc
}

bridge_of_probe() { ip -4 route get "$PROBE_SRC" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1; }
dev_of() { sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1; }

do_status() {
  local lines br i=0 lip tbl dev gw mark prio r0 r1 d0 d1 all_ok=1
  lines="$(discover)"
  echo "== 线路（ip rule 中 from <IP> lookup <表>，且 IP 在本机网卡上）"
  [ -n "$lines" ] || { bad "没有发现线路：本机没有按源地址的策略路由，或线路 IP 不在本机网卡上（前置设备转发时本脚本不适用）"; return 1; }
  br="$(bridge_of_probe)"
  echo "  探测：容器 $PROBE_SRC（网桥 ${br:-<未找到>}）发往 $PROBE_DST 的回包"
  while read -r lip tbl dev gw; do
    i=$((i + 1)); mark="$(mark_of "$i")"; prio=$((PRIO_BASE + i))
    echo
    echo "== $lip（$dev，表 $tbl，网关 $gw，标记 $mark）"
    if rules_for check "$dev" "$mark" && ip -4 rule show | grep -qE "^$prio:.*fwmark $mark/$MASK lookup $tbl"; then
      ok "规则已添加"
    else
      bad "规则未添加（apply 后生效）"; all_ok=0
    fi
    if [ -n "$br" ]; then
      r0="$(ip -4 route get "$PROBE_DST" from "$PROBE_SRC" iif "$br" 2>&1 | head -n 1)"; d0="$(printf '%s' "$r0" | dev_of)"
      r1="$(ip -4 route get "$PROBE_DST" from "$PROBE_SRC" iif "$br" mark "$mark" 2>&1 | head -n 1)"; d1="$(printf '%s' "$r1" | dev_of)"
      info "不带标记（未经本脚本处理）：$r0"
      info "带标记 $mark（从 $dev 进来的连接）：$r1"
      if [ "$d1" = "$dev" ]; then ok "从 $dev 进来的连接，容器回包从 $dev 出去"
      else bad "从 $dev 进来的连接，容器回包从 ${d1:-?} 出去（应为 $dev）"; all_ok=0; fi
      [ "$d0" = "$dev" ] || info "未标记的流量仍走 ${d0:-?}（正常：只影响从线路网卡进来的连接）"
    fi
  done <<<"$lines"
  echo
  if [ "$all_ok" = 1 ]; then
    echo "✔ 所有线路的容器回包都走原线路"
  else
    echo "✘ 有线路未处理：sudo bash $0 apply"
  fi
  if systemctl is-enabled "$UNIT" >/dev/null 2>&1; then info "开机自动生效：已安装 $UNIT"
  else info "开机自动生效：未安装（sudo bash $0 install）"; fi
}

do_apply() {
  local lines i=0 lip tbl dev gw mark prio
  lines="$(discover)"
  [ -n "$lines" ] || die "没有发现线路（见 status）"
  echo "== 添加规则"
  while read -r lip tbl dev gw; do
    i=$((i + 1)); mark="$(mark_of "$i")"; prio=$((PRIO_BASE + i))
    rules_for add "$dev" "$mark"
    if ! ip -4 rule show | grep -qE "^$prio:.*fwmark $mark/$MASK lookup $tbl"; then
      ip -4 rule del priority "$prio" 2>/dev/null || true
      ip -4 rule add fwmark "$mark/$MASK" lookup "$tbl" priority "$prio"
    fi
    ok "$lip（$dev）→ 标记 $mark → 表 $tbl（经 $gw）"
  done <<<"$lines"
  ip -4 route flush cache 2>/dev/null || true
  echo
  do_status
}

do_remove() {
  local l n=0 p
  echo "== 删除规则"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    read -ra args <<<"$l"
    args[0]=-D
    iptables -t mangle "${args[@]}" && n=$((n + 1))
  done < <(iptables -t mangle -S | grep -F -- "--comment $TAG" || true)
  info "删除 mangle 规则 $n 条"
  for p in $(ip -4 rule show | sed -nE 's/^(1[0-9][0-9]):.*fwmark 0x1[0-9a-f]\/0xff lookup .*/\1/p'); do
    ip -4 rule del priority "$p" && info "删除 ip rule 优先级 $p"
  done
  ip -4 route flush cache 2>/dev/null || true
  ok "已恢复为原来的选路方式"
}

do_install() {
  local self
  command -v systemctl >/dev/null 2>&1 || die "没有 systemd：把 'bash $(readlink -f "$0") apply' 加到开机脚本（如 /etc/rc.local）"
  self="$(readlink -f "$0")"
  {
    echo "[Unit]"
    echo "Description=wg-easy 多线回程：Docker 发布端口按进线回包"
    echo "After=network-online.target docker.service"
    echo "Wants=network-online.target"
    echo
    echo "[Service]"
    echo "Type=oneshot"
    echo "RemainAfterExit=yes"
    [ -z "${DUAL_LINE_ONLY:-}" ] || echo "Environment=\"DUAL_LINE_ONLY=$DUAL_LINE_ONLY\""
    echo "ExecStart=/usr/bin/env bash $self apply"
    echo "ExecStop=/usr/bin/env bash $self remove"
    echo
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } >"/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null 2>&1
  ok "已安装 /etc/systemd/system/$UNIT（脚本路径 $self；仓库目录移动后需重新 install）"
  do_apply
}

do_uninstall() {
  if command -v systemctl >/dev/null 2>&1 && [ -f "/etc/systemd/system/$UNIT" ]; then
    systemctl disable "$UNIT" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$UNIT"
    systemctl daemon-reload
    ok "已卸载 $UNIT"
  fi
  do_remove
}

case "$ACTION" in
  status)    do_status ;;
  apply)     do_apply ;;
  remove)    do_remove ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac

#!/usr/bin/env bash
# 多线服务器：让 Docker 发布端口（51821/tcp、51820/udp 等）的回包从进来的那条线路出去
#
# 背景：本机每条公网线路都有 "from <线路IP> lookup <表>" 策略路由，本机进程（如 sshd）的回包没问题；
#   但 Docker 发布的端口是 DNAT 到容器的，容器回包的源地址是 10.42.42.x，选路时匹配不到
#   "from <线路IP>"，只能走 main 表的默认路由，源地址出网卡时才改回线路 IP。
#   结果：普通外网客户端收不到回包，只有默认网关能路由回去的地址（如公司其他出口）正常。
# 做法：从某条线路网卡进来的新连接打上连接标记（CONNMARK），容器的回包恢复标记后按 fwmark 查这条线路的路由表。
# 另外把线路网卡的 rp_filter 设为 2（宽松）：DNAT 发生在路由之前，内核做反向路径检查时目的地址已经是 10.42.42.x，
#   匹配不到 "from <线路IP>" 规则，反向路由查到默认网关所在网卡，和进来的线路网卡不一致；
#   严格模式（1）下这些连接的 SYN 会被内核直接丢弃。本机 sshd 等不经 DNAT 的服务不受影响，所以平时看不出来
#
# 用法（root）：
#   bash deploy/dual-line-route.sh status      # 查看线路、规则、rp_filter、容器回包实际走哪张网卡（默认）
#   bash deploy/dual-line-route.sh apply       # 先清掉本脚本以前加的规则，再按当前线路重新添加（可重复执行）
#   bash deploy/dual-line-route.sh remove      # 删除本脚本添加的全部规则，恢复 rp_filter
#   bash deploy/dual-line-route.sh install     # 安装 systemd 服务，开机自动 apply（并立即 apply）
#   bash deploy/dual-line-route.sh uninstall   # 卸载 systemd 服务并 remove
#
# 线路自动发现：ip rule 里的 "from <IP> lookup <表>"（同一 IP 重复出现只算一条），且 IP 在本机网卡上、该表有默认路由
#   只处理部分线路：DUAL_LINE_ONLY="112.82.241.42 61.160.196.211"
#   探测容器回包用的源地址：DUAL_LINE_PROBE_SRC（默认 10.42.42.43，即 Caddy）
# 本脚本只改 mangle 表、ip rule 和线路网卡的 rp_filter，不动 Docker 管理的 nat / filter 规则；
#   firewalld reload 会清掉 mangle 规则，之后重新 apply
set -euo pipefail

ACTION="${1:-status}"
TAG=wg-easy-dual-line
MASK=0xff
MARK_BASE=16       # 0x10，第 1 条线路用 0x11
MAX_LINES=200      # 标记 0x11~0xd8，优先级 101~300
PRIO_BASE=100      # ip rule 优先级 101、102...，排在系统的 "from <IP>" 规则（通常 32700 以上）前面
PROBE_SRC="${DUAL_LINE_PROBE_SRC:-10.42.42.43}"
PROBE_DST=1.1.1.1
UNIT=wg-easy-dual-line.service
RPF_SAVE=/run/wg-easy-dual-line.rpfilter   # apply 前各网卡原来的 rp_filter，remove 时恢复

die()  { echo "✘ $*" >&2; exit 1; }
ok()   { echo "  ✔ $*"; }
bad()  { echo "  ✘ $*"; }
info() { echo "  · $*"; }

case "$ACTION" in
  status|apply|remove|install|uninstall) ;;
  -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
  *) die "未知操作: $ACTION（status | apply | remove | install | uninstall）" ;;
esac
[ "$(id -u)" = 0 ] || die "需要 root：sudo bash $0 $ACTION"
command -v ip >/dev/null 2>&1 || die "需要 iproute2（ip 命令）"
command -v iptables >/dev/null 2>&1 || die "需要 iptables"

# 注意：不要写 "ip rule show | grep -q ..."。规则多时 grep -q 先退出，ip 收到 SIGPIPE，
#   在 set -o pipefail 下整个管道算失败，会把“已存在”误判成“不存在”。一律先存进变量再匹配
rules_now() { ip -4 rule show 2>/dev/null; }

# 输出每行：线路IP 路由表 网卡 网关（同一线路 IP 只输出一次）
discover() {
  local rules lip tbl dev gw
  rules="$(rules_now)"
  sed -nE 's/^[0-9]+:[[:space:]]+from ([0-9.]+) lookup ([^ ]+).*/\1 \2/p' <<<"$rules" | awk '!seen[$1]++' \
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

# 本脚本加过的 ip rule（含旧版本重复添加的）：输出 “优先级 标记 表”
our_ip_rules() {
  local rules
  rules="$(rules_now)"
  sed -nE 's/^([0-9]+):[[:space:]]+from all fwmark (0x[0-9a-f]+)\/0xff lookup ([^ ]+).*/\1 \2 \3/p' <<<"$rules" \
  | awk -v lo=$((PRIO_BASE + 1)) -v hi=$((PRIO_BASE + MAX_LINES)) '$1 >= lo && $1 <= hi'
}

rpf_get() { cat "/proc/sys/net/ipv4/conf/$1/rp_filter" 2>/dev/null || echo "?"; }
# 生效值 = max(all, 网卡)
rpf_eff() {
  local a d
  a="$(rpf_get all)"; d="$(rpf_get "$1")"
  case "$a$d" in *[!0-9]*|"") echo "?"; return 0 ;; esac
  if [ "$a" -gt "$d" ]; then echo "$a"; else echo "$d"; fi
}
# 内核反向路径过滤累计丢包数（/proc/net/netstat 的 TcpExt IPReversePathFilter）
rpf_drops() {
  awk '/^TcpExt:/ { if (!h) { for (i = 2; i <= NF; i++) n[i] = $i; h = 1 } else { for (i = 2; i <= NF; i++) if (n[i] == "IPReversePathFilter") v = $i } } END { print v + 0 }' /proc/net/netstat 2>/dev/null || echo 0
}

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

# 删除本脚本加过的全部 mangle 规则和 ip rule（不碰 rp_filter）。输出删除数量
purge_ours() {
  local l n=0 m=0 p mk t
  local -a args
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    read -ra args <<<"$l"
    args[0]=-D
    iptables -t mangle "${args[@]}" 2>/dev/null && n=$((n + 1))
  done < <(iptables -t mangle -S 2>/dev/null | grep -F -- "--comment $TAG" || true)
  while read -r p mk t; do
    [ -n "$p" ] || continue
    ip -4 rule del priority "$p" fwmark "$mk/$MASK" lookup "$t" 2>/dev/null && m=$((m + 1))
  done < <(our_ip_rules)
  echo "$n $m"
}

bridge_of_probe() { ip -4 route get "$PROBE_SRC" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1; }
dev_of() { sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1; }

do_status() {
  local lines br i=0 lip tbl dev gw mark prio r0 r1 d0 d1 eff all_ok=1 nlines nours rules dups
  lines="$(discover)"
  echo "== 线路（ip rule 中 from <IP> lookup <表>，且 IP 在本机网卡上）"
  [ -n "$lines" ] || { bad "没有发现线路：本机没有按源地址的策略路由，或线路 IP 不在本机网卡上（前置设备转发时本脚本不适用）"; return 1; }
  nlines="$(grep -c . <<<"$lines")"
  [ "$nlines" -le "$MAX_LINES" ] || die "线路超过 $MAX_LINES 条，请用 DUAL_LINE_ONLY 指定要处理的线路"
  rules="$(rules_now)"
  nours="$(our_ip_rules | grep -c . || true)"
  if [ "$nours" -gt "$nlines" ]; then
    bad "本脚本的 fwmark 规则有 $nours 条，线路只有 $nlines 条：旧版本把重复的 from 规则当成多条线路，apply 会清理重建"
    all_ok=0
  fi
  dups="$(sed -nE 's/^[0-9]+:[[:space:]]+(from [0-9.]+ lookup [^ ]+).*/\1/p' <<<"$rules" | sort | uniq -c | awk '$1 > 1' || true)"
  if [ -n "$dups" ]; then
    info "系统里有重复的 from 规则（不是本脚本加的，不影响功能，多半是网卡脚本每次启动都 ip rule add 而没先判断）："
    printf '%s\n' "$dups" | sed 's/^ */      /'
    info "  想清理：保留一份后用 ip rule del priority <优先级> 逐条删除，并修正添加这些规则的网卡脚本"
  fi
  br="$(bridge_of_probe)"
  echo "  探测：容器 $PROBE_SRC（网桥 ${br:-<未找到>}）发往 $PROBE_DST 的回包"
  while read -r lip tbl dev gw; do
    i=$((i + 1)); mark="$(mark_of "$i")"; prio=$((PRIO_BASE + i))
    echo
    echo "== $lip（$dev，表 $tbl，网关 $gw，标记 $mark）"
    if rules_for check "$dev" "$mark" && grep -qE "^$prio:.*fwmark $mark/$MASK lookup $tbl( |$)" <<<"$rules"; then
      ok "规则已添加"
    else
      bad "规则未添加（apply 后生效）"; all_ok=0
    fi
    eff="$(rpf_eff "$dev")"
    case "$eff" in
      1) bad "rp_filter：all=$(rpf_get all) $dev=$(rpf_get "$dev")，生效 1（严格）：从 $dev 进来、DNAT 到容器的连接会被内核丢弃（apply 后改为 2）"; all_ok=0 ;;
      0|2) ok "rp_filter：all=$(rpf_get all) $dev=$(rpf_get "$dev")，生效 $eff（不会丢弃 DNAT 到容器的连接）" ;;
      *) info "rp_filter：读取失败" ;;
    esac
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
  info "内核反向路径过滤累计丢包：$(rpf_drops) 个（复测前后各看一次，还在增长说明仍有连接被 rp_filter 丢弃）"
  if [ "$all_ok" = 1 ]; then
    echo "✔ 所有线路：容器回包走原线路，rp_filter 不会丢弃 DNAT 到容器的连接"
  else
    echo "✘ 有线路未处理：sudo bash $0 apply"
  fi
  if systemctl is-enabled "$UNIT" >/dev/null 2>&1; then info "开机自动生效：已安装 $UNIT"
  else info "开机自动生效：未安装（sudo bash $0 install）"; fi
}

do_apply() {
  local lines i=0 lip tbl dev gw mark prio nlines cnt
  lines="$(discover)"
  [ -n "$lines" ] || die "没有发现线路（见 status）"
  nlines="$(grep -c . <<<"$lines")"
  [ "$nlines" -le "$MAX_LINES" ] || die "线路超过 $MAX_LINES 条，请用 DUAL_LINE_ONLY 指定要处理的线路"
  cnt="$(purge_ours)"
  echo "== 清理本脚本以前加的规则：mangle ${cnt% *} 条，ip rule ${cnt#* } 条"
  echo "== 添加规则（$nlines 条线路）"
  while read -r lip tbl dev gw; do
    i=$((i + 1)); mark="$(mark_of "$i")"; prio=$((PRIO_BASE + i))
    rules_for add "$dev" "$mark"
    ip -4 rule add fwmark "$mark/$MASK" lookup "$tbl" priority "$prio"
    if [ "$(rpf_get "$dev")" != 2 ]; then
      grep -q "^$dev " "$RPF_SAVE" 2>/dev/null || echo "$dev $(rpf_get "$dev")" >>"$RPF_SAVE"
      echo 2 >"/proc/sys/net/ipv4/conf/$dev/rp_filter"
    fi
    ok "$lip（$dev）→ 标记 $mark → 表 $tbl（经 $gw），rp_filter=2"
  done <<<"$lines"
  ip -4 route flush cache 2>/dev/null || true
  echo
  do_status
}

do_remove() {
  local cnt d v
  echo "== 删除规则"
  cnt="$(purge_ours)"
  info "删除 mangle 规则 ${cnt% *} 条，ip rule ${cnt#* } 条"
  if [ -f "$RPF_SAVE" ]; then
    while read -r d v; do
      if [ -n "$d" ] && [ -w "/proc/sys/net/ipv4/conf/$d/rp_filter" ]; then
        echo "$v" >"/proc/sys/net/ipv4/conf/$d/rp_filter"
        info "rp_filter：$d 恢复为 $v"
      fi
    done <"$RPF_SAVE"
    rm -f "$RPF_SAVE"
  fi
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

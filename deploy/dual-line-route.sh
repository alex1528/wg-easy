#!/usr/bin/env bash
# 多线服务器：让 Docker 发布端口（51821/tcp、51820/udp 等）的回包从进来的那条线路出去，并清理重复的策略路由
#
# 背景：本机每条公网线路都有 "from <线路IP> lookup <表>" 策略路由，本机进程（如 sshd）的回包没问题；
#   但 Docker 发布的端口是 DNAT 到容器的，容器回包的源地址是 10.42.42.x，选路时匹配不到
#   "from <线路IP>"，只能走 main 表的默认路由，源地址出网卡时才改回线路 IP。
#   结果：普通外网客户端收不到回包，只有默认网关能路由回去的地址（如公司其他出口）正常。
# 做法：从某条线路网卡进来的新连接打上连接标记（CONNMARK），容器的回包恢复标记后按 fwmark 查这条线路的路由表。
# 另外把线路网卡的 rp_filter 设为 2（宽松）：DNAT 发生在路由之前，内核做反向路径检查时目的地址已经是 10.42.42.x，
#   匹配不到 "from <线路IP>" 规则，反向路由查到默认网关所在网卡，和进来的线路网卡不一致；
#   严格模式（1）下这些连接的 SYN 会被内核直接丢弃。本机 sshd 等不经 DNAT 的服务不受影响，所以平时看不出来
# 重复的 from 规则：网卡脚本每次执行都直接 ip rule add、不先判断是否已存在，同一条规则会越积越多。
#   功能上不影响，但排查困难；apply 时先清理（每组只保留一条，选路结果有变化则全部恢复），dedupe 只查看并定位来源
#
# 用法（root）：
#   bash deploy/dual-line-route.sh status        # 查看线路、规则、rp_filter、容器回包实际走哪张网卡（默认）
#   bash deploy/dual-line-route.sh apply         # 先清理重复的 from 规则，再清掉本脚本以前加的规则、按当前线路重新添加（可重复执行）
#   bash deploy/dual-line-route.sh remove        # 删除本脚本添加的全部规则，恢复 rp_filter
#   bash deploy/dual-line-route.sh install       # 安装 systemd 服务，开机自动 apply（并立即 apply）
#   bash deploy/dual-line-route.sh uninstall     # 卸载 systemd 服务并 remove
#   bash deploy/dual-line-route.sh dedupe        # 只查看重复的 from 规则、计划删除哪些、是谁在重复添加（不做修改）
#
# 线路自动发现：ip rule 里的 "from <IP> lookup <表>"（同一 IP 重复出现只算一条），且 IP 在本机网卡上、该表有默认路由
#   只处理部分线路：DUAL_LINE_ONLY="112.82.241.42 61.160.196.211"
#   探测容器回包用的源地址：DUAL_LINE_PROBE_SRC（默认 10.42.42.43，即 Caddy）
#   apply 时不清理重复的 from 规则：DUAL_LINE_DEDUPE=0（install 时设置会写进 systemd 服务，开机 apply 也不清理）
# 本脚本只改 mangle 表、ip rule 和线路网卡的 rp_filter，不动 Docker 管理的 nat / filter 规则；
#   去重只删重复的 from 规则，不碰 local / main / default 和 fwmark 规则，remove 不会把它们加回来；
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
DEDUPE="${DUAL_LINE_DEDUPE:-1}"
UNIT=wg-easy-dual-line.service
RPF_SAVE=/run/wg-easy-dual-line.rpfilter   # apply 前各网卡原来的 rp_filter，remove 时恢复
SELF="$(readlink -f "$0")"
REPO_DIR="$(dirname "$(dirname "$SELF")")"

die()  { echo "✘ $*" >&2; exit 1; }
ok()   { echo "  ✔ $*"; }
bad()  { echo "  ✘ $*"; }
info() { echo "  · $*"; }

case "$ACTION" in
  status|apply|remove|install|uninstall|dedupe) ;;
  dedupe-apply) die "dedupe-apply 已合并到 apply（apply 会先清理重复的 from 规则）：sudo bash $0 apply" ;;
  -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
  *) die "未知操作: $ACTION（status | apply | remove | install | uninstall | dedupe）" ;;
esac
[ "$(id -u)" = 0 ] || die "需要 root：sudo bash $0 $ACTION"
command -v ip >/dev/null 2>&1 || die "需要 iproute2（ip 命令）"
case "$ACTION" in
  dedupe) ;;
  *) command -v iptables >/dev/null 2>&1 || die "需要 iptables" ;;
esac

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
    if iptables -t mangle "${args[@]}" 2>/dev/null; then n=$((n + 1)); fi
  done < <(iptables -t mangle -S 2>/dev/null | grep -F -- "--comment $TAG" || true)
  while read -r p mk t; do
    [ -n "$p" ] || continue
    if ip -4 rule del priority "$p" fwmark "$mk/$MASK" lookup "$t" 2>/dev/null; then m=$((m + 1)); fi
  done < <(our_ip_rules)
  echo "$n $m"
}

bridge_of_probe() { ip -4 route get "$PROBE_SRC" 2>/dev/null | sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1; }
dev_of() { sed -nE 's/.* dev ([^ ]+).*/\1/p' | head -n 1; }

# ================= 重复的 from 规则 =================

# 候选：“优先级<TAB>规则正文”（正文空白已合并），只要 from <IP或网段> [to <网段>] lookup <表>
from_cands() {
  local rules
  rules="$(rules_now)"
  sed -nE 's/^([0-9]+):[[:space:]]+(.*)$/\1\t\2/p' <<<"$rules" \
  | awk -F '\t' '{ gsub(/[[:space:]]+/, " ", $2); sub(/ $/, "", $2); print $1 "\t" $2 }' \
  | grep -E $'\tfrom [0-9.]+(/[0-9]+)? (to [0-9.]+(/[0-9]+)? )?lookup [^ ]+$' || true
}

# 要删除的重复：每组保留优先级数字最大的一条。参数：from_cands 的输出
dup_dels() {
  awk -F '\t' '
    NF >= 2 { n[$2]++; if (!($2 in keep) || $1 + 0 > keep[$2] + 0) keep[$2] = $1; k[NR] = $2; p[NR] = $1 }
    END { for (i = 1; i <= NR; i++) if ((i in k) && n[k[i]] > 1 && p[i] != keep[k[i]]) print p[i] "\t" k[i] }
  ' <<<"$1"
}

# 重复的组：“条数 规则”。参数：from_cands 的输出
dup_summary() {
  cut -f2 <<<"$1" | sed '/^$/d' | sort | uniq -c | sort -rn | awk '$1 > 1'
}

# 每个 from 源地址的选路结果，清理前后对比用
route_snapshot() {
  local ip
  for ip in $(cut -f2 <<<"$1" | sed -nE 's/^from ([0-9.]+)[ /].*/\1/p' | sort -u); do
    printf '%s => %s\n' "$ip" "$(ip -4 route get 1.1.1.1 from "$ip" 2>&1 | head -n 1 | sed -E 's/ uid [0-9]+//; s/ cache.*//; s/[[:space:]]+$//')"
  done
}

# 查找谁在添加 from 规则，并给出修正方法
dedupe_sources() {
  local paths p exist="" hits="" cron pat others
  paths="/etc/rc.local /etc/rc.d/rc.local /etc/network/interfaces /etc/network/interfaces.d /etc/sysconfig/network-scripts
/etc/NetworkManager/dispatcher.d /etc/networkd-dispatcher /etc/netplan /etc/systemd/network /etc/systemd/system
/etc/crontab /etc/cron.d /etc/cron.hourly /var/spool/cron /usr/local/bin /usr/local/sbin /root"
  for p in $paths; do
    if [ -e "$p" ]; then exist="$exist $p"; fi
  done
  pat='ip +(-4 +)?ru(le)? +(add|a|append)\b|routing-policy|RoutingPolicyRule|^[[:space:]]*from +[0-9.]+(/[0-9]+)? +(table|lookup)'
  if [ -n "$exist" ]; then
    # 排除本仓库自己的脚本（本脚本里也有 ip rule add）
    # shellcheck disable=SC2086
    hits="$(timeout 20 grep -rIsnE --exclude-dir=.git "$pat" $exist 2>/dev/null | grep -vF "$REPO_DIR/" | head -n 60 || true)"
  fi
  cron="$(crontab -l 2>/dev/null | grep -nE 'ip +(-4 +)?ru(le)?|ifup|network|\.sh' || true)"

  echo "== 谁在添加 from 规则"
  if [ -z "$hits" ] && [ -z "$cron" ]; then
    info "常见位置里没找到。可以用：grep -rnE 'ip +rule +add' /etc /opt /home 2>/dev/null"
  else
    if [ -n "$hits" ]; then printf '%s\n' "$hits" | sed 's/^/  · /'; fi
    if [ -n "$cron" ]; then printf '%s\n' "$cron" | sed 's/^/  · root crontab: /'; fi
  fi
  echo
  echo "== 怎么改才不会再重复"
  if [ -z "$hits" ] && [ -z "$cron" ] || grep -q '/etc/sysconfig/network-scripts/rule-' <<<"$hits"; then
    echo "  · rule-<网卡> 文件（CentOS / RHEL 的 ifup-routes 每次 ifup 都执行 ip rule add，不检查是否已存在）："
    echo "    每行加上固定的 priority，例如  from 112.82.212.165 table cuc priority 1001"
    echo "    规则带固定优先级后，较新的内核会拒绝重复添加完全相同的规则（不带优先级时每次都分配新的优先级，所以会重复）"
  fi
  others="$(printf '%s\n%s\n' "$hits" "$cron" | sed '/^$/d' | grep -vE '/etc/sysconfig/network-scripts/rule-|/etc/netplan|/etc/systemd/network' | grep -c . || true)"
  if [ -z "$hits" ] && [ -z "$cron" ] || [ "${others:-0}" -gt 0 ]; then
    echo "  · 脚本 / rc.local / interfaces 的 post-up / crontab 里的 ip rule add：先删干净再加，并固定优先级："
    echo "      while ip rule del from <IP> lookup <表> 2>/dev/null; do :; done"
    echo "      ip rule add from <IP> lookup <表> priority <固定数字>"
    echo "    crontab 里定时执行的，确认是否真的需要定时跑；/etc/network/interfaces 记得配对的 pre-down 删除"
  fi
  if grep -qE '/etc/netplan|/etc/systemd/network' <<<"$hits"; then
    echo "  · netplan / systemd-networkd 本身会去重，重复多半来自上面列出的其他位置"
  fi
}

do_dedupe() {
  local cands dels
  cands="$(from_cands)"; dels="$(dup_dels "$cands")"
  echo "== 策略路由：共 $(grep -c . <<<"$(rules_now)") 条，其中 from 规则 $(grep -c . <<<"$cands" || true) 条"
  if [ -z "$dels" ]; then
    ok "没有重复的 from 规则"
  else
    echo "  重复的规则（条数 规则）："
    dup_summary "$cands" | sed 's/^ */    /'
    info "计划删除 $(grep -c . <<<"$dels") 条，每组保留优先级数字最大的一条"
  fi
  echo
  dedupe_sources
  if [ -n "$dels" ]; then
    echo
    echo "（只查看，未做修改。sudo bash $0 apply 会先清理这些重复规则，再添加线路规则）"
  fi
}

# 返回非 0 表示删除后选路有变化、已全部恢复
do_dedupe_apply() {
  local cands dels before after p rule x j
  local -a deleted=()
  cands="$(from_cands)"; dels="$(dup_dels "$cands")"
  echo "== 清理重复的 from 规则"
  if [ -z "$dels" ]; then
    ok "没有重复的 from 规则"
    return 0
  fi
  before="$(route_snapshot "$cands")"
  while IFS=$'\t' read -r p rule; do
    [ -n "$p" ] || continue
    # shellcheck disable=SC2086
    if ip -4 rule del priority "$p" $rule 2>/dev/null; then deleted+=("$p"$'\t'"$rule"); fi
  done <<<"$dels"
  ip -4 route flush cache 2>/dev/null || true
  after="$(route_snapshot "$cands")"
  if [ "$before" != "$after" ]; then
    bad "删除后选路结果有变化，已把删除的 ${#deleted[@]} 条规则全部加回去："
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed 's/^/    /' || true
    for ((j = 0; j < ${#deleted[@]}; j++)); do
      x="${deleted[$j]}"; p="${x%%$'\t'*}"; rule="${x#*$'\t'}"
      # shellcheck disable=SC2086
      ip -4 rule add priority "$p" $rule 2>/dev/null || true
    done
    return 1
  fi
  ok "删除 ${#deleted[@]} 条重复规则，选路结果不变："
  printf '%s\n' "$after" | sed 's/^/    /'
  info "现在共 $(grep -c . <<<"$(rules_now)") 条策略路由"
  info "来源没修正的话，下次网络重启或定时任务执行后又会重复：sudo bash $0 dedupe 查看来源"
}

# ================= 多线回程 =================

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
  dups="$(dup_summary "$(from_cands)" || true)"
  if [ -n "$dups" ]; then
    info "系统里有重复的 from 规则（不是本脚本加的，不影响功能，多半是网卡脚本每次启动都 ip rule add 而没先判断）："
    printf '%s\n' "$dups" | sed 's/^ */      /'
    info "  查看来源：sudo bash $0 dedupe；清理：sudo bash $0 apply（会先清理重复规则）"
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
  if [ "$DEDUPE" != 0 ]; then
    do_dedupe_apply || bad "重复 from 规则清理后选路有变化，已恢复原规则，继续添加本脚本的规则"
  else
    echo "== 跳过清理重复的 from 规则（DUAL_LINE_DEDUPE=0）"
  fi
  echo
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
  ok "已恢复为原来的选路方式（重复 from 规则的清理不会恢复，它们本来就是多余的）"
}

do_install() {
  command -v systemctl >/dev/null 2>&1 || die "没有 systemd：把 'bash $SELF apply' 加到开机脚本（如 /etc/rc.local）"
  {
    echo "[Unit]"
    echo "Description=wg-easy 多线回程：Docker 发布端口按进线回包"
    echo "After=network-online.target docker.service"
    echo "Wants=network-online.target"
    echo
    echo "[Service]"
    echo "Type=oneshot"
    echo "RemainAfterExit=yes"
    if [ -n "${DUAL_LINE_ONLY:-}" ]; then echo "Environment=\"DUAL_LINE_ONLY=$DUAL_LINE_ONLY\""; fi
    if [ "$DEDUPE" = 0 ]; then echo "Environment=\"DUAL_LINE_DEDUPE=0\""; fi
    echo "ExecStart=/usr/bin/env bash $SELF apply"
    echo "ExecStop=/usr/bin/env bash $SELF remove"
    echo
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } >"/etc/systemd/system/$UNIT"
  systemctl daemon-reload
  systemctl enable "$UNIT" >/dev/null 2>&1
  ok "已安装 /etc/systemd/system/$UNIT（脚本路径 $SELF；仓库目录移动后需重新 install）"
  if [ "$DEDUPE" = 0 ]; then info "开机 apply 时不清理重复的 from 规则（DUAL_LINE_DEDUPE=0）"
  else info "开机 apply 时也会先清理重复的 from 规则"; fi
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
  status)       do_status ;;
  apply)        do_apply ;;
  remove)       do_remove ;;
  install)      do_install ;;
  uninstall)    do_uninstall ;;
  dedupe)       do_dedupe ;;
esac

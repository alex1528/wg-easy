#!/usr/bin/env bash
# 统计 / 分析 Caddy 的 JSON 访问日志，给运维看“谁在扫、扫了什么、拦没拦住”
#
# 背景：公网服务器每天都会收到 WordPress / PHP 漏洞扫描、目录探测等噪声。
#   这套部署里，明文 HTTP(:80) 会先被 Caddy 308 跳到 https://<域名>:51821，
#   非管理员 IP 的管理后台 / 不存在的路径再被 Caddy 拦成 403（带 security_headers，
#   但【没有】X-Wg-Gate: admin-only 头 —— 那是管理员 IP 规则专用头）。
#   所以一次“扫描探测”在日志里是【两条】：308（跳转）+ 403（拦下）。
#   直接按行计数会把探测次数翻倍，本脚本会把两者配对成一次事件。
#
# 与 diagnose-public.sh 的分工：
#   diagnose-public.sh --ip / --watch  看单个 IP 最近 / 实时的请求（排障）
#   log-stats.sh                       看全量日志的分布、趋势、扫描者排行（运营统计）
#
# 用法（在服务器的 wg-easy 目录下，或任意能读到日志的机器上）：
#   bash scripts/log-stats.sh                          # 汇总报告（默认读 caddy/logs/access.log）
#   bash scripts/log-stats.sh --scanners              # 附带“可疑来源汇总”一节
#   bash scripts/log-stats.sh --ip 20.214.165.240     # 只看某个来源 IP
#   bash scripts/log-stats.sh --status 403            # 只看某个状态码
#   bash scripts/log-stats.sh --since 2h             # 最近 2 小时（也支持 30m / 7d / 2026-11-16）
#   bash scripts/log-stats.sh --top 20               # 各榜单显示前 20 条（默认 10）
#   bash scripts/log-stats.sh --json                 # 输出 JSON，便于接监控 / 定时任务
#   bash scripts/log-stats.sh --json --scanners      # 开关可叠加
#   bash scripts/log-stats.sh --log /path/access.log # 指定日志文件
#   bash scripts/log-stats.sh --selftest             # 用内置样本自测，不依赖服务器日志
#
# 状态码含义（见 docs/content/examples/tutorials/caddy-crowdsec.md）：
#   0   连接在处理完前断开（客户端先放弃）   308  明文 HTTP 自动跳 HTTPS
#   200/400/401/404  已到 wg-easy            403  Caddy 拦截（管理员 IP 规则 / CrowdSec 封禁）
#   429 限流          502/504  后端问题
#   区分 403 来源：带 X-Wg-Gate: admin-only = 管理员 IP 规则；没有 = CrowdSec 封禁
set -uo pipefail
cd "$(dirname "$0")/.."

LOG="caddy/logs/access.log"
SINCE=""
IP=""
STATUS=""
TOP=10
JSON=0
SCANNERS=0
SELFTEST=0
NOW_TS="$(date +%s)"

die() { echo "✘ $*" >&2; exit 1; }
usage() { sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; }

# 解析 --since：<数字><m|h|d> 相对当前时间；或能被 date -d 解析的绝对时间
parse_since() {
  local v="$1" n unit
  if [[ "$v" =~ ^([0-9]+)([mhd])$ ]]; then
    n="${BASH_REMATCH[1]}"; unit="${BASH_REMATCH[2]}"
    case "$unit" in
      m) echo $(( NOW_TS - n * 60 )) ;;
      h) echo $(( NOW_TS - n * 3600 )) ;;
      d) echo $(( NOW_TS - n * 86400 )) ;;
    esac
  else
    date -d "$v" +%s 2>/dev/null || die "无法解析 --since $v（示例：30m / 2h / 7d / 2026-11-16）"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --log)      LOG="${2:-}"; shift 2; [ -n "$LOG" ] || die "--log 需要文件路径" ;;
    --since)    SINCE="$(parse_since "${2:-}")"; shift 2 ;;
    --ip)       IP="${2:-}"; shift 2; [ -n "$IP" ] || die "--ip 需要 IP" ;;
    --status)   STATUS="${2:-}"; shift 2; [[ "$STATUS" =~ ^[0-9]+$ ]] || die "--status 需要数字状态码" ;;
    --top)      TOP="${2:-}"; shift 2; [[ "$TOP" =~ ^[0-9]+$ ]] && [ "$TOP" -gt 0 ] || die "--top 需要正整数" ;;
    --json)     JSON=1; shift ;;
    --scanners) SCANNERS=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "未知参数：$1（-h 查看帮助）" ;;
  esac
done

if [ "$SELFTEST" = 1 ]; then
  LOG="scripts/fixtures/caddy-access-sample.jsonl"
  echo "== 自测模式：使用内置样本 $LOG" >&2
fi
[ -f "$LOG" ] || die "找不到日志 $LOG（用 --log 指定，或用 --selftest 自测）"

# ---------------------------------------------------------------------------
# 用 awk 解析 Caddy JSON 访问日志，不依赖 jq：逐字段宽松匹配，不依赖字段顺序。
# ---------------------------------------------------------------------------
awk -v SINCE="$SINCE" -v F_IP="$IP" -v F_STATUS="$STATUS" -v TOP="$TOP" \
    -v WANT_JSON="$JSON" -v WANT_SCANNERS="$SCANNERS" -v TZ_OFFSET="$(date +%z)" '
function jstr(key,   re) {                 # 取 "key":"value" 里的 value
  re = "\"" key "\":\"([^\"]*)\""
  if (match($0, re)) return substr($0, RSTART + length(key) + 4, RLENGTH - length(key) - 5)
  return ""
}
function jnum(key,   re) {                 # 取 "key":数字
  re = "\"" key "\":([0-9.eE+-]+)"
  if (match($0, re)) return substr($0, RSTART + length(key) + 3, RLENGTH - length(key) - 3) + 0
  return ""
}
function has_gate() {                     # 403 是否带管理员 IP 规则专用头
  return index($0, "\"X-Wg-Gate\":[\"admin-only\"]") > 0
}
function is_https() {                     # 请求本身是否已是 HTTPS（带 tls 块）
  return index($0, "\"tls\":{") > 0
}
# JSON 字符串转义：逐字符拼接，避免 gsub 替换串里反斜杠语义随 awk 实现变化的坑
#   （gsub(/\\/, "\\\\", t) 在部分 awk 上会把单个 \ 又还原成单个 \，导致 --json 里出现非法转义）
function esc(s,   t, i, c, bs, q) {
  bs = sprintf("%c", 92)          # 一个反斜杠字符
  q = "\""                        # 一个双引号字符
  t = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == bs) t = t bs bs
    else if (c == q) t = t bs q
    else t = t c
  }
  return t
}
function localsec(ts,   oh, om) {
  oh = substr(TZ_OFFSET, 1, 3) + 0; om = substr(TZ_OFFSET, 4, 2) + 0
  if (substr(TZ_OFFSET, 1, 1) == "-") om = -om
  return ts + oh * 3600 + om * 60
}
# 纯整数算 UTC 日期（Hinnant civil-from-days），不用 gawk 的 strftime：
# 服务器上的 awk 可能是 mawk / busybox，没有 strftime；这套只用到整数运算和 sprintf，全平台通用。
function civil(t,   z, era, doe, yoe, y, doy, mp, d, m, sec, hh, mm, ss) {
  z = int(t / 86400) + 719468
  era = int((z >= 0 ? z : z - 146096) / 146097)
  doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400
  doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153)
  d = doy - int((153 * mp + 2) / 5) + 1
  m = mp + (mp < 10 ? 3 : -9)
  y = y + (m <= 2 ? 1 : 0)
  sec = t - int(t / 86400) * 86400
  hh = int(sec / 3600); mm = int((sec % 3600) / 60); ss = sec % 60
  return sprintf("%04d-%02d-%02d %02d:%02d:%02d", y, m, d, hh, mm, ss)
}
function fmt_ts(t) { return t == 0 ? "-" : civil(localsec(t)) }
function hourkey(ts) { return substr(civil(localsec(ts)), 1, 13) ":00" }
# 扫描 / 探测特征：WordPress、PHP 后门、常见管理入口、配置文件、备份、敏感路径
function sig_of(uri,   u) {
  u = tolower(uri)
  if (u ~ /^\/wp-|\/wp-content\/|\/wp-includes\/|\/wordpress\/|\/xmlrpc\.php|\/wp-login\.php/) return "WordPress"
  if (u ~ /^\/(admin|administrator|phpmyadmin|pma|myadmin|cpanel|webmail)\//) return "管理入口"
  if (u ~ /\/(actuator|solr|jenkins|druid|hudson|boaform)\//) return "组件探测"
  if (u ~ /\.(env|git|svn|aws|htpasswd|htaccess)$|^\/\.|\/\.(env|git)/) return "敏感文件"
  if (u ~ /\.(php|phps|phtml)$/) return "PHP 文件"
  if (u ~ /\/(cgi-bin|shell|cmd|eval|bak|backup|old|sql|zip|tar|gz)/) return "后门/备份"
  return ""
}
# 把 Map 按值降序、键升序填入全局有序数组 ok[]/ov[]，返回条目数。
# 不用 delete 整个数组（POSIX awk 只支持 delete arr[i]，delete arr 是 gawk 扩展）：
# 每次调用都覆盖 1..n，调用方只遍历 1..n，n 之外的旧值不会被读到。
function sortmap(map,   i, j, n, key, ki, kv) {
  n = 0
  for (key in map) { n++; sk[n] = key; sv[n] = map[key] }
  for (i = 2; i <= n; i++) {
    ki = sk[i]; kv = sv[i]; j = i - 1
    while (j >= 1 && (sv[j] < kv || (sv[j] == kv && sk[j] > ki))) { sk[j+1] = sk[j]; sv[j+1] = sv[j]; j-- }
    sk[j+1] = ki; sv[j+1] = kv
  }
  for (i = 1; i <= n; i++) { ok[i] = sk[i]; ov[i] = sv[i] }
  return n
}
function jblock(name, map, top,   n, i, lim) {
  n = sortmap(map); lim = (top > 0 && top < n) ? top : n
  printf "  \"%s\": {", name
  for (i = 1; i <= lim; i++) printf "%s\"%s\": %d", (i == 1 ? "" : ", "), esc(ok[i]), ov[i]
  printf "}"
}
function txtable(map, top, label,   n, i, lim) {
  n = sortmap(map); lim = (top > 0 && top < n) ? top : n
  for (i = 1; i <= lim; i++) printf "%s%-32s %8d\n", label, ok[i], ov[i]
  if (n == 0) printf "%s（无数据）\n", label
}
function line(c,   s, i) { s = ""; for (i = 0; i < 66; i++) s = s c; print s }
function probe_other_total(   k, s) { for (k in probe_other) s += probe_other[k]; return s + 0 }

BEGIN { total = 0; unparsed = 0 }

{
  ts = jnum("ts")
  # 解析不了的行（非 Caddy JSON、被截断）不静默丢弃，单独计数
  if (ts == "" || ts == 0) { unparsed++; next }
  if (SINCE != "" && ts < SINCE) next

  ip = jstr("client_ip"); if (ip == "") ip = jstr("remote_ip")
  method = jstr("method"); host = jstr("host")
  uri = jstr("uri"); sub(/\?.*/, "", uri)
  status = jnum("status")
  gate = has_gate(); https = is_https(); hk = hourkey(ts); sig = sig_of(uri)

  if (F_IP != "" && ip != F_IP) next
  if (F_STATUS != "" && status != (F_STATUS + 0)) next

  total++
  if (min_ts == 0 || ts < min_ts) min_ts = ts
  if (ts > max_ts) max_ts = ts
  if (!seen_hour[hk]++) hour_order[++hn] = hk
  hour_total[hk]++
  ip_total[ip]++; path_total[uri]++; status_total[status]++
  host_total[host]++; method_total[method]++

  if (status == 308) { c308++; if (!https) http_redirects++ }
  if (status == 403) { c403++; if (gate) c403_gate++; else c403_crowdsec++; if (!https) c403_http++ }
  if (status == 429) c429++
  if (status >= 500 && status < 600) c5xx++
  if (status == 0) c0++

  # 扫描 / 探测：一次探测 = 308(跳转前奏) + 后续 403/其它(实际结果) 两条日志。
  # 为避免把次数翻倍，特征分布 / 排行只按“结果行”(非 308)统计一次；308 单独记为跳转。
  if (sig != "") {
    if (status == 308) {
      probe_redirect++                       # 只记跳转，不重复计入事件分布
    } else {
      hour_probe[hk]++
      probe_ip[ip]++; probe_sig[sig]++; probe_path[uri]++
      probe_ip_sig[ip SUBSEP sig]++
      if (status == 403) { probe_blocked++; if (gate) probe_blocked_gate++; else probe_blocked_crowdsec++ }
      else probe_other[status]++
    }
  }
  # --scanners：只汇总“有扫描特征”或“撞到拦截/限流”的来源 IP
  if (sig != "" || status == 403 || status == 429) noisy_ip[ip] = 1
}

END {
  paired = (c308 < c403 ? c308 : c403)   # 308 跳转后确实落到 403 的组数
  est_real = total - c308               # 真正被 Caddy 决策 / 到 wg-easy 的 HTTPS 请求数
  probe_hits = 0; for (k in probe_sig) probe_hits += probe_sig[k]
  probe_events = probe_blocked + probe_other_total()
  noisy_n = 0; for (k in noisy_ip) noisy_n++

  if (WANT_JSON == 1) {
    printf "{\n  \"log\": \"%s\",\n", esc(FILENAME)
    printf "  \"filters\": {\"since\": \"%s\", \"ip\": \"%s\", \"status\": \"%s\"},\n", esc(SINCE), esc(F_IP), esc(F_STATUS)
    printf "  \"window\": {\"from\": %d, \"to\": %d, \"timezone\": \"%s\"},\n", min_ts, max_ts, TZ_OFFSET
    printf "  \"total_lines\": %d, \"parsed\": %d, \"unparsed\": %d,\n", total + unparsed, total, unparsed
    printf "  \"redirect_308\": %d, \"http_redirects\": %d, \"status_403\": %d,\n", c308, http_redirects, c403
    printf "  \"status_403_admin_gate\": %d, \"status_403_crowdsec\": %d, \"status_429\": %d, \"status_5xx\": %d, \"status_0\": %d,\n", c403_gate, c403_crowdsec, c429, c5xx, c0
    printf "  \"paired_308_403\": %d, \"estimated_real_requests\": %d,\n", paired, est_real
    printf "  \"probe_hits\": %d, \"probe_events\": %d, \"probe_blocked_403\": %d, \"probe_redirect_308\": %d,\n", probe_hits, probe_events, probe_blocked, probe_redirect
    printf "  \"probe_blocked_by_admin_gate\": %d, \"probe_blocked_by_crowdsec\": %d,\n", probe_blocked_gate, probe_blocked_crowdsec
    jblock("status_codes", status_total, 0); printf ",\n"
    jblock("top_source_ips", ip_total, TOP); printf ",\n"
    jblock("top_paths", path_total, TOP); printf ",\n"
    jblock("top_hosts", host_total, TOP); printf ",\n"
    jblock("methods", method_total, 0); printf ",\n"
    jblock("probe_signatures", probe_sig, 0); printf ",\n"
    jblock("probe_paths", probe_path, TOP); printf ",\n"
    jblock("probe_source_ips", probe_ip, TOP); printf ",\n"
    jblock("hourly_requests", hour_total, 0)
    printf "\n}\n"
    exit 0
  }

  # ---------------- 文本报告 ----------------
  line("="); print "  Caddy 访问日志统计  ·  " FILENAME; line("=")
  printf "  时间窗口：%s ~ %s  (%s)\n", fmt_ts(min_ts), fmt_ts(max_ts), TZ_OFFSET
  if (SINCE != "") printf "  过滤：--since 之后\n"
  if (F_IP != "") printf "  过滤：来源 IP = %s\n", F_IP
  if (F_STATUS != "") printf "  过滤：状态码 = %s\n", F_STATUS
  printf "  日志行数：%d（已解析 %d，无法解析 %d）\n\n", total + unparsed, total, unparsed

  print "── 1. 状态码分布（按次数）"
  txtable(status_total, 0, "  ")
  print "  说明：308=明文跳HTTPS；403=Caddy 拦截；429=限流；0=连接提前断开；5xx=后端问题"
  printf "  403 细分：管理员 IP 规则 %d 条（带 X-Wg-Gate），CrowdSec 封禁/其他 %d 条\n\n", c403_gate, c403_crowdsec

  print "── 2. 自动跳转与拦截配对（一次扫描=两条日志，别把请求数翻倍）"
  printf "  · 308 跳转：%d 条（其中明文 HTTP→HTTPS %d 条）\n", c308, http_redirects
  printf "  · 403 拦截：%d 条   · 429 限流：%d 条   · 5xx：%d 条   · status=0：%d 条\n", c403, c429, c5xx, c0
  printf "  · 308 与后续 HTTPS 403 配对约 %d 组，真正进入 Caddy 决策的 HTTPS 请求约 %d 次（%d 条日志）\n", paired, est_real, total
  printf "  · 结论：这些请求基本被 Caddy 挡在 wg-easy 之前，属公网背景噪声\n\n"

  print "── 3. 扫描 / 漏洞探测识别"
  printf "  · 命中扫描特征 %d 次探测（308 跳转前奏 %d 条未重复计数，故不是 %d 条日志）\n", probe_hits, probe_redirect, probe_hits + probe_redirect
  printf "  · 其中被 403 拦下 %d 次：管理员 IP 规则 %d，CrowdSec/其他 %d\n", probe_blocked, probe_blocked_gate, probe_blocked_crowdsec
  print "  · 探测特征："; txtable(probe_sig, 0, "  ")
  print "  · 被扫得最多的路径："; txtable(probe_path, TOP, "  ")
  print "  · 扫描来源 IP："; txtable(probe_ip, TOP, "  ")
  printf "\n"

  printf "── 4. 来源 IP / 路径 / Host / 方法（Top %d）\n\n", TOP
  print "  来源 IP："; txtable(ip_total, TOP, "  ")
  print "  请求路径："; txtable(path_total, TOP, "  ")
  print "  Host："; txtable(host_total, TOP, "  ")
  print "  方法："; txtable(method_total, 0, "  ")
  printf "\n"

  print "── 5. 按小时分布（请求 / 扫描命中，本地时区 " TZ_OFFSET "）"
  printf "  %-18s %10s %10s\n", "小时", "请求", "扫描"
  line("-")
  if (hn == 0) print "  （无数据）"
  for (i = 1; i <= hn; i++) { hk = hour_order[i]; printf "  %-18s %10d %10d\n", hk, hour_total[hk], hour_probe[hk] }
  printf "\n"

  if (WANT_SCANNERS == 1) {
    print "── 附：可疑来源汇总（有扫描特征或撞到 403/429 的 IP）"
    printf "  %-18s %10s %10s  %s\n", "IP", "总请求", "扫描命中", "特征"
    line("-")
    n = sortmap(probe_ip); lim = (TOP < n) ? TOP : n
    for (i = 1; i <= lim; i++) { k = ok[i]; printf "  %-18s %10d %10d  %s\n", k, ip_total[k] + 0, probe_ip[k], sigs_for(k) }
    printf "  （共 %d 个可疑 IP，显示前 %d 个；单看某个 IP 用 diagnose-public.sh --ip）\n\n", noisy_n, lim
  }

  print "── 运维提示"
  print "  · 上面 403 没有 X-Wg-Gate 头：多半是 CrowdSec 已封禁该 IP，或访问了不公开的路径"
  print "  · 想看某个 IP 的全部请求：bash scripts/diagnose-public.sh --ip <IP>"
  print "  · 想看实时请求：bash scripts/diagnose-public.sh --watch"
  print "  · 想确认是否被封：docker exec wg-easy-crowdsec cscli decisions list --ip <IP>"
  line("=")
}

function sigs_for(ip,   k, arr, out, sig) {
  out = ""
  for (k in probe_ip_sig) {
    split(k, arr, SUBSEP)
    if (arr[1] == ip) { sig = arr[2]; out = out (out == "" ? "" : ",") sig }
  }
  return out == "" ? "-" : out
}
' "$LOG"

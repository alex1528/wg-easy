#!/usr/bin/env bash
# 根据 CrowdSec 管理员白名单生成 Caddy 的管理员 IP 名单，两边始终是同一份
#
#   来源：crowdsec/parsers/s02-enrich/wg-easy-whitelist.yaml（ip / cidr 下所有 - "x" 行）
#   生成：caddy/admin-ips.caddy（一行 remote_ip ...，Caddyfile 里 import 它判断是否放行管理后台）
#
# 用法（Linux 或 Windows 的 Git Bash）：
#   bash scripts/admin-ips.sh           # 重新生成
#   bash scripts/admin-ips.sh --check   # 只检查是否需要重新生成（commit.sh 用），需要时退出码 1
#
# 修改管理员 IP 的流程：编辑白名单 YAML → 运行本脚本 → 服务器上 docker restart wg-easy-crowdsec wg-easy-caddy
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "✘ $*" >&2; exit 1; }

SRC="crowdsec/parsers/s02-enrich/wg-easy-whitelist.yaml"
OUT="caddy/admin-ips.caddy"
MODE=write
case "${1:-}" in
  "")      ;;
  --check) MODE=check ;;
  -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
  *)       die "未知参数: $1（-h 查看帮助）" ;;
esac

[ -f "$SRC" ] || die "找不到 $SRC"

# 取所有未注释的 - "x" 行，去重并保持原顺序
ips="$(grep -E '^[[:space:]]*-[[:space:]]+"[^"]+"[[:space:]]*(#.*)?$' "$SRC" \
  | sed -E 's/^[[:space:]]*-[[:space:]]+"([^"]+)".*/\1/' \
  | awk '!seen[$0]++')" || true
[ -n "$ips" ] || die "$SRC 里没有任何 IP（格式应为 - \"1.2.3.4\"）"

bad=""; admins=0
while IFS= read -r ip; do
  if [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$ ]] || [[ "$ip" == *:* && "$ip" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]]; then
    case "$ip" in 127.*|::1|::1/*) ;; *) admins=$((admins + 1)) ;; esac
  else
    bad="$bad $ip"
  fi
done <<<"$ips"
[ -z "$bad" ] || die "$SRC 里这些值不是合法的 IP/CIDR：$bad"

content="# 由 scripts/admin-ips.sh 根据 $SRC 自动生成，不要手改
# 改管理员 IP：编辑上面的 YAML，运行 bash scripts/admin-ips.sh，再执行 docker restart wg-easy-crowdsec wg-easy-caddy
remote_ip $(echo $ips)"

if [ "$MODE" = check ]; then
  if [ -f "$OUT" ] && [ "$(cat "$OUT")" = "$content" ]; then
    echo "✔ $OUT 与管理员白名单一致"
    exit 0
  fi
  echo "✘ $OUT 与 $SRC 不一致，请运行：bash scripts/admin-ips.sh" >&2
  exit 1
fi

printf '%s\n' "$content" > "$OUT"
echo "✔ 已生成 $OUT（$(echo "$ips" | wc -l | tr -d ' ') 条，其中管理员地址 $admins 条）"
if [ "$admins" -eq 0 ]; then
  echo "⚠ 名单里只有回环地址：除同步配置等公开接口外，所有人都进不了管理后台" >&2
fi

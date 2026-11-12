#!/usr/bin/env bash
# 把上游 wg-easy-feng（feng905/wg-easy 的 LiveWireGuard 分支）的 wg-easy 改动合并到本库，保留本库的部署层（Caddy / CrowdSec 等）
#
# 用法（在本库根目录的 Git Bash 中运行）：
#   bash scripts/sync-upstream.sh --dry-run   # 只拉取并预览：待合并的提交、上游改了哪些文件、会冲突的文件
#   bash scripts/sync-upstream.sh             # 合并并提交（post-commit 钩子自动打版本 tag），不推送
#   bash scripts/sync-upstream.sh --manual    # 合并，但冲突全部留给你手工解决
#   bash scripts/sync-upstream.sh --yes       # 不询问直接合并（定时任务用）
#
# 配置（环境变量）：
#   FENG_URL     上游地址，默认 ../wg-easy-feng（本机目录）；也可以用 https://github.com/feng905/wg-easy.git
#   FENG_BRANCH  上游分支，默认 LiveWireGuard
#   SYNC_KEEP_OURS  额外的“本库专有”路径（空格分隔，支持 * 通配），冲突时保留本库版本
#
# 冲突处理规则（默认）：
#   本库专有的部署文件（caddy/ crowdsec/ deploy/ 本库脚本、docker-compose-dirty.yml、部署文档等） → 保留本库
#   .gitignore → 两边的行取并集；.env.example → 保留本库，再追加上游新增的变量
#   其余文件（wg-easy 源码、文档、构建文件） → 采用上游 feng 的版本
# 合并前自动建备份分支 backup/pre-sync-<时间>，出问题可以 git reset --hard <备份分支> 回退
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

die()  { echo "✘ $*" >&2; exit 1; }
ok()   { echo "  ✔ $*"; }
info() { echo "  · $*"; }

REMOTE=feng
FENG_URL="${FENG_URL:-../wg-easy-feng}"
FENG_BRANCH="${FENG_BRANCH:-LiveWireGuard}"
MODE=auto; DRY=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --manual)  MODE=manual ;;
    --yes|-y)  YES=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "未知参数: $1（-h 查看帮助）" ;;
  esac
  shift
done

KEEP_OURS="caddy/* crowdsec/* deploy/* scripts/admin-ips.sh scripts/caddy-image.sh scripts/diagnose-public.sh \
scripts/mirror-images.sh scripts/sync-upstream.sh docker-compose-dirty.yml docs/content/examples/tutorials/caddy-crowdsec.md \
.gitattributes .githooks/* commit.sh ${SYNC_KEEP_OURS:-}"
is_ours() {
  local f="$1" p
  set -f
  for p in $KEEP_OURS; do
    # shellcheck disable=SC2053
    if [[ "$f" == $p ]]; then set +f; return 0; fi
  done
  set +f
  return 1
}

# ---------- 1. 前置检查 ----------
git rev-parse --git-dir >/dev/null 2>&1 || die "请在 wg-easy 仓库里运行"
[ ! -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] || die "上一次合并还没结束：先解决并提交，或 git merge --abort"
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = master ] || die "当前分支是 $branch，请先切到 master"
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short --untracked-files=no >&2
  die "工作区有未提交的改动（见上），请先提交或 git stash"
fi
if [ -d "$FENG_URL/.git" ] && [ -n "$(git -C "$FENG_URL" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "⚠ $FENG_URL 里有未提交的改动，这些改动不会被同步（只同步已提交的内容）" >&2
fi

# ---------- 2. 配置上游并拉取 ----------
echo "==> 上游：$FENG_URL（分支 $FENG_BRANCH）"
if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  [ "$(git remote get-url "$REMOTE")" = "$FENG_URL" ] || git remote set-url "$REMOTE" "$FENG_URL"
else
  git remote add "$REMOTE" "$FENG_URL"
  ok "已添加远程 $REMOTE → $FENG_URL"
fi
git fetch --no-tags "$REMOTE" "+refs/heads/$FENG_BRANCH:refs/remotes/$REMOTE/$FENG_BRANCH" \
  || die "拉取 $FENG_URL 失败（本机目录不存在，或网络不通）"
UP="$REMOTE/$FENG_BRANCH"
UP_SHA="$(git rev-parse "$UP")"
ok "上游 $UP = ${UP_SHA:0:7}  $(git log -1 --format=%s "$UP")"

BASE="$(git merge-base HEAD "$UP" 2>/dev/null || true)"
[ -n "$BASE" ] || die "本库和上游没有共同历史，不能直接合并"
if [ "$BASE" = "$UP_SHA" ]; then
  ok "本库已经包含上游 ${UP_SHA:0:7} 的全部提交，无需同步"
  exit 0
fi
N_UP="$(git rev-list --count "$BASE..$UP")"
N_OURS="$(git rev-list --count "$BASE..HEAD")"
info "共同祖先 ${BASE:0:7}；上游新增 $N_UP 个提交，本库新增 $N_OURS 个提交"

# ---------- 3. 预览 ----------
echo
echo "==> 上游待合并的提交（最近 20 个）"
git log --oneline --no-decorate -n 20 "$BASE..$UP" | sed 's/^/  · /'
echo
echo "==> 两边都改过的文件（可能冲突）"
both="$(comm -12 <(git diff --name-only "$BASE" HEAD | sort) <(git diff --name-only "$BASE" "$UP" | sort) || true)"
if [ -n "$both" ]; then
  while IFS= read -r f; do
    if is_ours "$f"; then echo "  · $f  → 保留本库"
    elif [ "$f" = .gitignore ]; then echo "  · $f  → 两边取并集"
    elif [ "$f" = .env.example ]; then echo "  · $f  → 保留本库 + 追加上游新增变量"
    else echo "  · $f  → 冲突时采用上游"; fi
  done <<<"$both"
else
  info "没有"
fi
if git merge-tree --write-tree HEAD HEAD >/dev/null 2>&1; then
  pred="$(git merge-tree --write-tree --name-only HEAD "$UP" 2>/dev/null)" && prc=0 || prc=$?
  if [ "$prc" = 0 ]; then
    info "git 预测：无冲突，可以直接合并"
  else
    echo "  git 预测会产生冲突的文件（按上面的规则自动处理）："
    printf '%s\n' "$pred" | sed -n '2,/^$/p' | sed '/^$/d; s/^/    ✘ /'
  fi
else
  info "git 版本低于 2.38，跳过冲突预测"
fi
echo
echo "==> 本库在 src/ 下的自有改动（上游没有，合并后保留；上游覆盖同一文件时会丢失）"
local_src="$(git diff --name-only "$BASE" HEAD -- src || true)"
[ -n "$local_src" ] && printf '%s\n' "$local_src" | sed 's/^/  · /' || info "没有"

if [ "$DRY" = 1 ]; then
  echo
  echo "（--dry-run：只预览，未做任何修改）"
  exit 0
fi
if [ "$YES" = 0 ]; then
  echo
  ans=""; read -r -p "开始合并？[y/N] " ans || true
  case "$ans" in y|Y) ;; *) die "已取消" ;; esac
fi

# ---------- 4. 合并 ----------
BACKUP="backup/pre-sync-$(date +%Y%m%d-%H%M%S)"
git branch "$BACKUP" HEAD
ok "已创建备份分支 $BACKUP"

abort() {
  echo "✘ 合并过程中出错，已回退（git merge --abort）。备份分支：$BACKUP" >&2
  git merge --abort 2>/dev/null || true
  exit 1
}
trap abort ERR

set +e
git merge --no-ff --no-commit "$UP" >/tmp/sync-merge.$$ 2>&1
rc=$?
set -e
sed 's/^/  │ /' /tmp/sync-merge.$$; rm -f /tmp/sync-merge.$$
if [ ! -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] && [ "$rc" -ne 0 ]; then
  trap - ERR
  die "git merge 失败（见上方输出）"
fi

overwritten=()
resolve_one() {
  local f="$1" has_o has_t
  git cat-file -e "HEAD:$f" 2>/dev/null && has_o=1 || has_o=0
  git cat-file -e "MERGE_HEAD:$f" 2>/dev/null && has_t=1 || has_t=0
  if is_ours "$f"; then
    if [ "$has_o" = 1 ]; then git checkout --ours -- "$f"; git add -- "$f"; else git rm -q -- "$f"; fi
    info "$f → 保留本库"
  elif [ "$f" = .gitignore ]; then
    { git show ":2:$f" 2>/dev/null; git show ":3:$f" 2>/dev/null; } | awk '!seen[$0]++ || $0==""' >"$f"
    git add -- "$f"; info "$f → 两边取并集"
  elif [ "$f" = .env.example ]; then
    git show ":2:$f" >"$f" 2>/dev/null || git show "HEAD:$f" >"$f"
    added="$(git show ":3:$f" 2>/dev/null | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS= read -r l; do
      k="${l%%=*}"; grep -qE "^#? *$k=" "$f" || echo "$l"; done || true)"
    if [ -n "$added" ]; then
      printf '\n# ---------- 以下变量从上游 feng 合入（说明见上游 .env.example）----------\n%s\n' "$added" >>"$f"
    fi
    git add -- "$f"; info "$f → 保留本库，追加上游新增变量 $(printf '%s' "$added" | grep -c . || true) 个"
  else
    if [ "$has_t" = 1 ]; then git checkout --theirs -- "$f"; git add -- "$f"; else git rm -q -- "$f"; fi
    [ "$has_o" = 1 ] && overwritten+=("$f")
    info "$f → 采用上游"
  fi
}

conflicts="$(git diff --name-only --diff-filter=U || true)"
if [ -n "$conflicts" ]; then
  echo
  if [ "$MODE" = manual ]; then
    trap - ERR
    echo "==> 有冲突，--manual 模式不自动处理："
    printf '%s\n' "$conflicts" | sed 's/^/  ✘ /'
    echo "  解决后：git add <文件> && git commit；放弃：git merge --abort"
    exit 1
  fi
  echo "==> 自动解决冲突"
  while IFS= read -r f; do resolve_one "$f"; done <<<"$conflicts"
fi
[ -z "$(git diff --name-only --diff-filter=U)" ] || { trap - ERR; die "仍有未解决的冲突，请手工处理后提交"; }
trap - ERR

# ---------- 5. 合并后检查（失败时不提交，保留合并状态供你检查）----------
echo
echo "==> 合并后检查"
fail=0
for f in scripts/*.sh deploy/*.sh; do
  [ -f "$f" ] || continue
  case "$f" in deploy/*) sh -n "$f" ;; *) bash -n "$f" ;; esac || { echo "  ✘ $f 语法错误"; fail=1; }
done
[ "$fail" = 1 ] || ok "脚本语法"
if [ -x scripts/admin-ips.sh ] || [ -f scripts/admin-ips.sh ]; then
  bash scripts/admin-ips.sh --check >/dev/null 2>&1 && ok "管理员 IP 名单与白名单一致" || { echo "  ✘ caddy/admin-ips.caddy 与白名单不一致：bash scripts/admin-ips.sh"; fail=1; }
fi
crlf="$(git ls-files -z -- caddy crowdsec deploy docker-compose-dirty.yml scripts | xargs -0 grep -Il $'\r' 2>/dev/null || true)"
if [ -n "$crlf" ]; then
  echo "  ✘ 部署文件出现 CRLF："; printf '%s\n' "$crlf" | sed 's/^/    /'; fail=1
else
  ok "部署文件均为 LF"
fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  WG_WEB_HOST=vpn.example.com CROWDSEC_BOUNCER_KEY=validateonly \
    docker compose -f docker-compose-dirty.yml config -q && ok "docker-compose-dirty.yml 校验通过" || { echo "  ✘ docker-compose-dirty.yml 校验失败"; fail=1; }
fi
dup="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env.example 2>/dev/null | sort | uniq -d || true)"
[ -z "$dup" ] || echo "  ⚠ .env.example 有重复变量，请手工去重：$(echo $dup)"

only_ours_src="$(comm -23 <(git ls-tree -r --name-only HEAD -- src | sort) <(git ls-tree -r --name-only MERGE_HEAD -- src | sort) || true)"
if [ -n "$only_ours_src" ]; then
  echo "  ⚠ 这些 src 文件只有本库有（上游没有），已保留；请确认它们引用的函数在上游版本里仍然存在："
  printf '%s\n' "$only_ours_src" | sed 's/^/    · /'
fi
if [ ${#overwritten[@]} -gt 0 ]; then
  echo "  ⚠ 这些文件冲突时采用了上游版本，本库原来在里面的改动已被覆盖（备份分支 $BACKUP 里还有）："
  printf '    · %s\n' "${overwritten[@]}"
fi

if [ "$fail" = 1 ]; then
  echo
  echo "✘ 检查未通过，合并结果未提交。修正后 git commit，或 git merge --abort 放弃"
  exit 1
fi

# ---------- 6. 提交 ----------
git commit -q -m "merge: 同步上游 feng/$FENG_BRANCH ${UP_SHA:0:7}

上游：$FENG_URL（$FENG_BRANCH）
合入上游 $N_UP 个提交；冲突规则：部署层保留本库，wg-easy 源码采用上游
备份分支：$BACKUP"
echo
git log -1 --format='✔ 已提交 %h %s'
echo "  tag：$(git tag --points-at HEAD | tr '\n' ' ')"
echo
echo "下一步："
echo "  1. 构建 wg-easy 镜像验证：docker build -t wg-easy:sync-test ."
echo "  2. 没问题再 git push；有问题回退：git reset --hard $BACKUP"

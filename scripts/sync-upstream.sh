#!/usr/bin/env bash
# 把上游 wg-easy-feng（feng905/wg-easy 的 LiveWireGuard 分支）的 wg-easy 改动合并到本库，保留本库的部署层（Caddy / CrowdSec 等）
#
# 用法（在本库根目录的 Git Bash 中运行）：
#   bash scripts/sync-upstream.sh --dry-run    # 只拉取并预览：待合并的提交、两边都改过的文件、会冲突的文件
#   bash scripts/sync-upstream.sh              # 合并并提交（post-commit 钩子自动打版本 tag），不推送
#   bash scripts/sync-upstream.sh --manual     # 合并，但冲突全部留给你手工解决
#   bash scripts/sync-upstream.sh --continue   # 手工处理完冲突或检查问题后，重新检查并提交
#   bash scripts/sync-upstream.sh --yes        # 不询问直接合并（定时任务用）
#
# 配置（环境变量）：
#   FENG_URL        上游地址，默认 ../wg-easy-feng（本机目录）；也可以用 https://github.com/feng905/wg-easy.git
#   FENG_BRANCH     上游分支，默认 LiveWireGuard
#   SYNC_KEEP_OURS  额外的“本库专有”路径（空格分隔，支持 * 通配），冲突时保留本库版本
#
# 冲突处理规则：部署层（caddy/ crowdsec/ deploy/ 本库脚本、docker-compose-dirty.yml、部署文档等）保留本库；
#   .gitignore 两边取并集；.env.example 保留本库并追加上游新增变量；其余文件（wg-easy 源码等）采用上游。
# 合并前自动建备份分支 backup/pre-sync-<时间>；合并后检查不通过时不提交，结果留在工作区等你处理。
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

die()  { echo "✘ $*" >&2; exit 1; }
ok()   { echo "  ✔ $*"; }
info() { echo "  · $*"; }

REMOTE=feng
FENG_URL="${FENG_URL:-../wg-easy-feng}"
FENG_BRANCH="${FENG_BRANCH:-LiveWireGuard}"
MODE=auto; DRY=0; YES=0; CONT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY=1 ;;
    --manual)   MODE=manual ;;
    --continue) CONT=1 ;;
    --yes|-y)   YES=1 ;;
    -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
    *) die "未知参数: $1（-h 查看帮助）" ;;
  esac
  shift
done

OUR_SCRIPTS="scripts/admin-ips.sh scripts/caddy-image.sh scripts/diagnose-public.sh scripts/mirror-images.sh \
scripts/sync-upstream.sh deploy/wg-easy-hairpin.sh"
KEEP_OURS="caddy/* crowdsec/* deploy/* $OUR_SCRIPTS docker-compose-dirty.yml \
docs/content/examples/tutorials/caddy-crowdsec.md .gitattributes .githooks/* commit.sh ${SYNC_KEEP_OURS:-}"
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

git rev-parse --git-dir >/dev/null 2>&1 || die "请在 wg-easy 仓库里运行"
GIT_DIR_ABS="$(cd "$(git rev-parse --git-dir)" && pwd)"
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = master ] || die "当前分支是 $branch，请先切到 master"

# 合并进行中脚本意外退出（set -e）时自动 git merge --abort；
# 需要把合并结果留给用户处理时（冲突留给手工、检查不通过），先把 AUTO_ABORT 置 0
AUTO_ABORT=0
BACKUP=""
on_exit() {
  local rc=$?
  [ -f "$GIT_DIR_ABS/MERGE_HEAD" ] || return 0
  if [ "$AUTO_ABORT" = 1 ]; then
    echo "✘ 合并过程中出错（退出码 $rc），已执行 git merge --abort 回退${BACKUP:+；备份分支 $BACKUP}" >&2
    git merge --abort 2>/dev/null || true
  elif [ "$rc" -ne 0 ]; then
    echo "  合并结果保留在工作区、尚未提交：处理后运行 bash scripts/sync-upstream.sh --continue；放弃则 git merge --abort" >&2
  fi
}
trap on_exit EXIT

overwritten=()

# ---------- 合并后检查 + 提交（--continue 也走这里）----------
post_merge() {
  local fail=0 f g imp p call repo m svc
  local -a deps_bad=()
  echo
  echo "==> 合并后检查"
  for f in $OUR_SCRIPTS; do
    [ -f "$f" ] || continue
    case "$f" in deploy/*) sh -n "$f" ;; *) bash -n "$f" ;; esac || { echo "  ✘ $f 语法错误"; fail=1; }
  done
  [ "$fail" = 1 ] || ok "本库脚本语法"
  if [ -f scripts/admin-ips.sh ]; then
    if bash scripts/admin-ips.sh --check >/dev/null 2>&1; then ok "管理员 IP 名单与白名单一致"
    else echo "  ✘ caddy/admin-ips.caddy 与白名单不一致：bash scripts/admin-ips.sh"; fail=1; fi
  fi
  # shellcheck disable=SC2086
  crlf="$(git ls-files -z -- caddy crowdsec deploy docker-compose-dirty.yml $OUR_SCRIPTS | xargs -0 grep -Il $'\r' 2>/dev/null || true)"
  if [ -n "$crlf" ]; then
    echo "  ✘ 部署文件出现 CRLF："; printf '%s\n' "$crlf" | sed 's/^/    /'; fail=1
  else
    ok "部署文件均为 LF"
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if WG_WEB_HOST=vpn.example.com CROWDSEC_BOUNCER_KEY=validateonly docker compose -f docker-compose-dirty.yml config -q; then
      ok "docker-compose-dirty.yml 校验通过"
    else
      echo "  ✘ docker-compose-dirty.yml 校验失败"; fail=1
    fi
  fi
  dup="$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env.example 2>/dev/null | sort | uniq -d || true)"
  [ -z "$dup" ] || echo "  ⚠ .env.example 有重复变量，请手工去重：$(echo $dup)"

  # 本库自有的 src 改动，引用的模块 / Database 方法在合并结果里是否还存在
  while IFS= read -r g; do
    [ -n "$g" ] && [ -f "$g" ] || continue
    case "$g" in *.ts|*.vue) ;; *) continue ;; esac
    while IFS= read -r imp; do
      [ -n "$imp" ] || continue
      case "$imp" in
        "#server/"*) p="src/server/${imp#"#server/"}" ;;
        "#db/"*)     p="src/server/database/${imp#"#db/"}" ;;
        *) continue ;;
      esac
      [ -f "$p.ts" ] || [ -f "$p/index.ts" ] || [ -f "$p" ] || deps_bad+=("$g 引用的模块 $imp 不存在")
    done < <(grep -oE "['\"]#(server|db)/[^'\"]+['\"]" "$g" | tr -d "'\"" | sort -u || true)
    while IFS= read -r call; do
      [ -n "$call" ] || continue
      repo="${call#Database.}"; m="${repo#*.}"; m="${m%\(}"; repo="${repo%%.*}"
      svc="src/server/database/repositories/${repo%s}/service.ts"
      [ -f "$svc" ] || continue
      grep -qE "\\b${m}\\s*[(<]" "$svc" || deps_bad+=("$g 调用的 Database.$repo.$m() 在 $svc 里不存在")
    done < <(grep -oE 'Database\.[A-Za-z]+\.[A-Za-z]+\(' "$g" | sort -u || true)
  done < <(git diff --name-only "$BASE" HEAD -- src || true)
  if [ ${#deps_bad[@]} -gt 0 ]; then
    fail=1
    echo "  ✘ 本库自有的 src 改动引用了合并后已不存在的模块或方法："
    printf '    · %s\n' "${deps_bad[@]}"
    echo "    处理（二选一）："
    echo "      ① 上游已有替代实现（如 /api/livewireguard/config）时，删掉本库的旧文件：git rm <文件>"
    echo "      ② 需要保留时，从备份分支取回被覆盖的方法：git show ${BACKUP:-backup/pre-sync-<时间>}:<service.ts 路径>，手工补回后 git add"
    echo "    处理完运行：bash scripts/sync-upstream.sh --continue"
  else
    ok "本库自有的 src 改动引用的模块和方法都还在"
  fi

  only_ours_src="$(comm -23 <(git ls-files -- src | sort) <(git ls-tree -r --name-only MERGE_HEAD -- src | sort) || true)"
  if [ -n "$only_ours_src" ]; then
    echo "  ⚠ 这些 src 文件只有本库有（上游没有），已保留："
    printf '%s\n' "$only_ours_src" | sed 's/^/    · /'
  fi
  if [ ${#overwritten[@]} -gt 0 ]; then
    echo "  ⚠ 这些文件冲突时采用了上游版本，本库原来在里面的改动已被覆盖${BACKUP:+（备份分支 $BACKUP 里还有）}："
    printf '    · %s\n' "${overwritten[@]}"
  fi

  if [ "$fail" = 1 ]; then
    echo
    echo "✘ 检查未通过，合并结果未提交"
    exit 1
  fi

  git commit -q -F - <<EOF
merge: 同步上游 feng/$FENG_BRANCH ${UP_SHA:0:7}

上游：$FENG_URL（$FENG_BRANCH）
合入上游 $N_UP 个提交；冲突规则：部署层保留本库，wg-easy 源码采用上游
备份分支：${BACKUP:-无}
EOF
  echo
  git log -1 --format='✔ 已提交 %h %s'
  echo "  tag：$(git tag --points-at HEAD | tr '\n' ' ')"
  echo
  echo "下一步："
  echo "  1. 构建 wg-easy 镜像验证：docker build -t wg-easy:sync-test ."
  echo "  2. 没问题再 git push${BACKUP:+；有问题回退：git reset --hard $BACKUP}"
}

# ---------- --continue：处理完后重新检查并提交 ----------
if [ "$CONT" = 1 ]; then
  [ -f "$GIT_DIR_ABS/MERGE_HEAD" ] || die "当前没有进行中的合并"
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    git diff --name-only --diff-filter=U | sed 's/^/  ✘ /' >&2
    die "还有未解决的冲突（见上），解决后 git add 再运行 --continue"
  fi
  UP_SHA="$(git rev-parse MERGE_HEAD)"
  BASE="$(git merge-base HEAD MERGE_HEAD)"
  N_UP="$(git rev-list --count "$BASE..MERGE_HEAD")"
  BACKUP="$(git for-each-ref --sort=-refname --format='%(refname:short)' 'refs/heads/backup/pre-sync-*' | head -n 1)"
  post_merge
  exit 0
fi

# ---------- 1. 前置检查 ----------
[ ! -f "$GIT_DIR_ABS/MERGE_HEAD" ] || die "上一次合并还没结束：处理后运行 --continue，或 git merge --abort"
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
  if pred="$(git merge-tree --write-tree --name-only HEAD "$UP" 2>/dev/null)"; then
    info "git 预测：无冲突，可以直接合并"
  else
    echo "  git 预测会产生冲突的文件（按上面的规则自动处理）："
    printf '%s\n' "$pred" | sed -n '2,/^$/p' | sed '/^$/d; s/^/    ✘ /'
  fi
else
  info "git 版本低于 2.38，跳过冲突预测"
fi
echo
echo "==> 本库在 src/ 下的自有改动（上游没有，合并后保留；冲突时采用上游的文件里，本库改动会丢失）"
local_src="$(git diff --name-only "$BASE" HEAD -- src || true)"
if [ -n "$local_src" ]; then printf '%s\n' "$local_src" | sed 's/^/  · /'; else info "没有"; fi

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

AUTO_ABORT=1
MERGE_LOG="$(mktemp)"
# 有冲突时 git merge 返回 1，这是正常情况：放在 if 里，不触发 set -e
if git merge --no-ff --no-commit "$UP" >"$MERGE_LOG" 2>&1; then rc=0; else rc=$?; fi
sed 's/^/  │ /' "$MERGE_LOG"; rm -f "$MERGE_LOG"
if [ ! -f "$GIT_DIR_ABS/MERGE_HEAD" ]; then
  AUTO_ABORT=0
  die "git merge 没有进入合并状态（退出码 $rc，见上方输出），工作区未改动"
fi

resolve_one() {
  local f="$1" has_o has_t added
  if git cat-file -e "HEAD:$f" 2>/dev/null; then has_o=1; else has_o=0; fi
  if git cat-file -e "MERGE_HEAD:$f" 2>/dev/null; then has_t=1; else has_t=0; fi
  if is_ours "$f"; then
    if [ "$has_o" = 1 ]; then git checkout --ours -- "$f"; git add -- "$f"; else git rm -q -- "$f"; fi
    info "$f → 保留本库"
  elif [ "$f" = .gitignore ]; then
    { git show ":2:$f" 2>/dev/null || true; git show ":3:$f" 2>/dev/null || true; } | awk '$0=="" || !seen[$0]++' >"$f"
    git add -- "$f"
    info "$f → 两边取并集"
  elif [ "$f" = .env.example ]; then
    git show ":2:$f" >"$f" 2>/dev/null || git show "HEAD:$f" >"$f"
    added="$(git show ":3:$f" 2>/dev/null | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS= read -r l; do
      k="${l%%=*}"; grep -qE "^#? *$k=" "$f" || echo "$l"; done || true)"
    if [ -n "$added" ]; then
      printf '\n# ---------- 以下变量从上游 feng 合入（说明见上游 .env.example）----------\n%s\n' "$added" >>"$f"
    fi
    git add -- "$f"
    info "$f → 保留本库，追加上游新增变量 $(printf '%s\n' "$added" | grep -c . || true) 个"
  else
    if [ "$has_t" = 1 ]; then git checkout --theirs -- "$f"; git add -- "$f"; else git rm -q -- "$f"; fi
    if [ "$has_o" = 1 ]; then overwritten+=("$f"); fi
    info "$f → 采用上游"
  fi
}

conflicts="$(git diff --name-only --diff-filter=U || true)"
if [ -n "$conflicts" ]; then
  echo
  if [ "$MODE" = manual ]; then
    AUTO_ABORT=0
    echo "==> 有冲突，--manual 模式不自动处理："
    printf '%s\n' "$conflicts" | sed 's/^/  ✘ /'
    echo "  逐个解决后 git add <文件>，再运行 bash scripts/sync-upstream.sh --continue"
    exit 1
  fi
  echo "==> 自动解决冲突"
  while IFS= read -r f; do resolve_one "$f"; done <<<"$conflicts"
fi
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  AUTO_ABORT=0
  die "仍有未解决的冲突，请手工处理后运行 --continue"
fi

# 冲突已解决：之后检查不通过时保留合并结果，交给用户处理
AUTO_ABORT=0
post_merge

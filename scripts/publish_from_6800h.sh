#!/usr/bin/env bash
# Runs only on the maintainer's computer. Never source into an interactive shell.
set -Eeuo pipefail
PACKAGE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TARGET_REPO='yanjing-chen/popup-llm-officeassistent'
REPO_URL="https://github.com/$TARGET_REPO.git"
PUBLISH_PARENT="${1:-$(dirname -- "$PACKAGE_DIR")}"
PUBLISH_WORK=''

on_error() {
    local code=$?
    echo '发布已停止；不会强推、删除远端内容或改动仓库可见性。' >&2
    if [ -n "$PUBLISH_WORK" ]; then echo "本地工作目录保留：$PUBLISH_WORK" >&2; fi
    echo '若遇到分支保护、登录权限或 workflow 权限限制，请先处理限制，不要改成强推。' >&2
    exit "$code"
}
trap on_error ERR

for command_name in git gh python3 gsettings glib-compile-schemas; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "缺少 $command_name；请先安装所需开发工具后重试。" >&2
        exit 1
    fi
done
python3 "$PACKAGE_DIR/scripts/release_tools.py" checksums --check
RELEASE_VERSION=$(python3 "$PACKAGE_DIR/scripts/release_tools.py" version)
RELEASE_TAG="v$RELEASE_VERSION"
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo '请先运行 gh auth login --hostname github.com，登录后重新执行。' >&2
    exit 1
fi
ACTIVE_ACCOUNT=$(gh api user --jq .login)
if [ "${ACTIVE_ACCOUNT,,}" != 'yanjing-chen' ]; then
    echo "当前 GitHub 账号是 $ACTIVE_ACCOUNT，不是 yanjing-chen；请先切换账号。" >&2
    exit 1
fi
REPO_STATE=$(gh repo view "$TARGET_REPO" --json nameWithOwner,viewerPermission,visibility \
    --jq '[.nameWithOwner, .viewerPermission, .visibility] | @tsv')
IFS=$'\t' read -r OBSERVED_REPO OBSERVED_PERMISSION OBSERVED_VISIBILITY <<< "$REPO_STATE"
if [ "$OBSERVED_REPO" != "$TARGET_REPO" ]; then
    echo '仓库身份不匹配，已停止。' >&2
    exit 1
fi
case "$OBSERVED_PERMISSION" in
    ADMIN|MAINTAIN|WRITE) ;;
    *) echo '当前账号没有仓库写入权限，已停止。' >&2; exit 1 ;;
esac
echo "发布仓库：$OBSERVED_REPO；可见性：$OBSERVED_VISIBILITY（保持不变）"

repo_git() {
    # Reuse configured gh credentials without printing/copying a token or
    # changing the user's global Git credential configuration.
    git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' "$@"
}

test -d "$PUBLISH_PARENT"
PUBLISH_WORK=$(mktemp -d "$PUBLISH_PARENT/popup-llm-github-XXXXXX")
repo_git clone -- "$REPO_URL" "$PUBLISH_WORK"
cd -- "$PUBLISH_WORK"
if git show-ref --verify --quiet refs/remotes/origin/main; then
    if git show-ref --verify --quiet refs/heads/main; then
        git switch main
    else
        git switch --create main --track origin/main
    fi
elif git rev-parse --verify HEAD >/dev/null 2>&1; then
    echo '远端没有 main 但存在其他分支；请先确认目标分支，未推送。' >&2
    exit 1
else
    git switch --orphan main
fi
if git show-ref --verify --quiet "refs/tags/$RELEASE_TAG"; then
    echo "远端已有 $RELEASE_TAG；不会移动或覆盖标签，请确认下一个版本号。" >&2
    exit 1
fi

python3 "$PACKAGE_DIR/scripts/release_tools.py" stage-source "$PUBLISH_WORK"
git config --local user.name 'Yanjing Chen'
git config --local user.email 'yanjing_chen@qq.com'
git config --local core.autocrlf false
bash verify.sh
python3 scripts/release_tools.py build --tag "$RELEASE_TAG"
git add --all
if ! git diff --cached --quiet; then
    git commit -m "Release $RELEASE_TAG: full source, precompiled extension and Actions"
fi
git tag -a "$RELEASE_TAG" -m "Popup LLM Office Assistent $RELEASE_TAG"
# A normal atomic push: if main advanced or a rule rejects either ref, neither
# main nor the new tag is changed. Never retry with force or delete a tag.
repo_git push --atomic origin HEAD:refs/heads/main "refs/tags/$RELEASE_TAG"
echo "源码和标签已从本机推送。提交：$(git rev-parse HEAD)"
echo "本地仓库：$PUBLISH_WORK"
echo "Actions：https://github.com/$TARGET_REPO/actions"
echo "构建成功后下载：https://github.com/$TARGET_REPO/releases/tag/$RELEASE_TAG"

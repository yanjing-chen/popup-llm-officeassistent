#!/usr/bin/env bash
# Read-only, metadata-only diagnostics. No source/translation/prompt/key reads.
set -u
POPUP_UUID='popup-llm-officeassistent@yanjing_chen@qq.com'
POPUP_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [ -f "$POPUP_SCRIPT_DIR/metadata.json" ]; then
    POPUP_EXTENSION_DIR="$POPUP_SCRIPT_DIR"
elif [ -f "$POPUP_SCRIPT_DIR/$POPUP_UUID/metadata.json" ]; then
    POPUP_EXTENSION_DIR="$POPUP_SCRIPT_DIR/$POPUP_UUID"
else
    POPUP_EXTENSION_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$POPUP_UUID"
fi
echo '===== 翻译只读诊断：不读取原文、译文、提示词、密钥和接口地址 ====='
gnome-shell --version 2>/dev/null || true
if [ -f "$POPUP_EXTENSION_DIR/metadata.json" ]; then
    sed -n '/"version"\|"version-name"/p' "$POPUP_EXTENSION_DIR/metadata.json"
fi
echo '===== 安全的功能设置 ====='
for POPUP_KEY in enable-stream enable-think result-font-size model-idle-time; do
    POPUP_VALUE=$(gsettings --schemadir "$POPUP_EXTENSION_DIR/schemas" get \
        org.gnome.shell.extensions.popup-llm-officeassistent "$POPUP_KEY" 2>/dev/null) || POPUP_VALUE='尚不可读'
    printf '%s = %s\n' "$POPUP_KEY" "$POPUP_VALUE"
done
echo '===== 本次登录的版本及分段计数日志 ====='
if command -v journalctl >/dev/null 2>&1; then
    journalctl --user -b --no-pager 2>/dev/null | \
        sed -n '/\[PopupLLM\] Loaded build=/p; /\[PopupLLM Translation\] part=[0-9]/p; /\[PopupLLM Translation\] failed part=[0-9]/p' | tail -n 80
fi
echo '运行标志应为 Loaded build=2.3.2-sentence-safe-translation；必须注销重登以加载新 JS。'
echo '分段全部返回不等于语义上绝不漏译；若仍有遗漏，请提供脱敏原文与具体缺译位置。'
echo '===== 结束；未修改任何设置 ====='

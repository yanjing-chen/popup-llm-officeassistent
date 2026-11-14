#!/usr/bin/env bash
# Read-only, optional diagnostics. No API settings, response text or clipboard
# data are read. Run as the ordinary desktop user: bash diagnose-selection.sh
set -u
EXT_UUID='popup-llm-officeassistent@yanjing_chen@qq.com'
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"

echo '当前 GNOME：'
if command -v gnome-shell >/dev/null 2>&1; then
    gnome-shell --version
fi
echo '磁盘上的扩展版本：'
if [ -f "$EXT_DIR/metadata.json" ]; then
    grep -E '"version"|"version-name"' "$EXT_DIR/metadata.json"
else
    echo "未找到：$EXT_DIR/metadata.json"
fi
echo '扩展状态：'
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions info "$EXT_UUID"
fi
echo '实际加载的版本标志与相关错误（本次开机，最多 80 行）：'
if command -v journalctl >/dev/null 2>&1; then
    journalctl --user -b --no-pager -o cat \
        --grep='PopupLLM|resultWindow\.js|textSelection\.js|clutter_event_get_source' 2>/dev/null | tail -n 80
fi
echo '2.1.4 的运行标志应为：Loaded build=2.1.4-toolbar-on-top'
echo '只有磁盘版本、没有运行标志时，尚不能证明当前 Shell 已加载新模块。'
echo '检查结束。未修改设置、文件、驱动或剪贴板。'

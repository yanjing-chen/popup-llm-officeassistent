#!/usr/bin/env bash
# Read-only diagnostic installed with the extension; no screenshot or setting writes.
set -uo pipefail
POPUP_UUID='popup-llm-officeassistent@yanjing_chen@qq.com'
POPUP_EXT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$POPUP_UUID"

echo 'GNOME 版本：'
if command -v gnome-shell >/dev/null 2>&1; then gnome-shell --version; fi
echo '扩展状态：'
if command -v gnome-extensions >/dev/null 2>&1; then gnome-extensions info "$POPUP_UUID" || true; fi
echo '磁盘上的版本与启动代码：'
if [ -f "$POPUP_EXT/metadata.json" ]; then
    grep -nE '"version"|"version-name"' "$POPUP_EXT/metadata.json" || true
fi
if [ -f "$POPUP_EXT/nativeScreenshot.js" ]; then
    grep -nE 'ui.open\(|_phase\(|OPEN_TIMEOUT|after-paint|UIMode' "$POPUP_EXT/nativeScreenshot.js" || true
fi
if [ -f "$POPUP_EXT/ocrUtils.js" ]; then
    echo 'OCR 解码实现标志：'
    grep -nE 'decoder.decode\(|_flushLine\(|DECODE_FAILED' "$POPUP_EXT/ocrUtils.js" || true
fi
if command -v gjs >/dev/null 2>&1; then
    echo 'GJS 版本与独立解码能力检查（不进入 Shell、不读取用户内容）：'
    gjs --version || true
    gjs -c 'try { new TextDecoder().decode(new Uint8Array([65]), {stream: true}); print("TextDecoder stream option: available"); } catch (_) { print("TextDecoder stream option: unavailable (2.2.2 does not require it)"); }' || true
fi
echo 'OCR 开关与已选择模型（不读取接口密钥或提示词）：'
if command -v gsettings >/dev/null 2>&1 && [ -f "$POPUP_EXT/schemas/gschemas.compiled" ]; then
    gsettings --schemadir "$POPUP_EXT/schemas" get org.gnome.shell.extensions.popup-llm-officeassistent enable-ocr || true
    gsettings --schemadir "$POPUP_EXT/schemas" get org.gnome.shell.extensions.popup-llm-officeassistent model-name-ocr || true
fi

# A packaged Shell resource can reveal this machine's actual API without
# executing JavaScript in the compositor. It is optional and never extracted
# to disk; only relevant declarations are printed.
if command -v gresource >/dev/null 2>&1; then
    for POPUP_RESOURCE in /usr/lib/gnome-shell/libgnome-shell.so \
        /usr/lib64/gnome-shell/libgnome-shell.so \
        /usr/lib/x86_64-linux-gnu/gnome-shell/libgnome-shell.so \
        /usr/lib/aarch64-linux-gnu/gnome-shell/libgnome-shell.so; do
        if [ -f "$POPUP_RESOURCE" ]; then
            echo '系统截图资源中的接口声明：'
            gresource extract "$POPUP_RESOURCE" /org/gnome/shell/ui/screenshot.js 2>/dev/null |
                grep -nE 'UIMode|SCREENSHOT_ONLY|async open\(|screenshot-taken|closed' |
                head -n 24 || true
            break
        fi
    done
fi
echo '当前会话最近 30 分钟的插件阶段日志：'
if command -v journalctl >/dev/null 2>&1; then
    journalctl --user -b --since '30 minutes ago' --no-pager -o cat 2>/dev/null |
        grep -E '\[PopupLLM( OCR)?\]' | tail -n 70 || true
    journalctl -b --since '30 minutes ago' --no-pager -o cat _COMM=gnome-shell 2>/dev/null |
        grep -E '\[PopupLLM( OCR)?\]' | tail -n 70 || true
fi
echo '诊断结束；未截图、未修改任何设置。'

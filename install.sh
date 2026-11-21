#!/usr/bin/env bash
# Run with bash install.sh. Do not source this script into an interactive shell.
set -Eeuo pipefail
umask 022

RECOMPILE_SCHEMAS=0
case "${1:-}" in
    '') ;;
    --recompile-schemas) RECOMPILE_SCHEMAS=1 ;;
    *) echo '用法：bash install.sh [--recompile-schemas]' >&2; exit 2 ;;
esac

EXT_UUID='popup-llm-officeassistent@yanjing_chen@qq.com'
PACKAGE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE_DIR="$PACKAGE_DIR/$EXT_UUID"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
EXT_ROOT="$DATA_DIR/gnome-shell/extensions"
TARGET_DIR="$EXT_ROOT/$EXT_UUID"
BACKUP_ROOT="$DATA_DIR/popup-llm-officeassistent/backups"

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    echo '请以当前桌面用户运行，不要使用 sudo。' >&2
    exit 1
fi
for command_name in cp mv mkdir mktemp sha256sum gsettings; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "缺少命令：$command_name，请先安装对应的系统运行工具。" >&2
        exit 1
    fi
done
for source_name in metadata.json prefs.js extension.js resultWindow.js translation.js textClient.js textSelection.js frameLoop.js backendUtils.js modelBackend.js idleModels.js nativeScreenshot.js ocrClient.js ocrPreview.js ocrUtils.js diagnose-ocr.sh stylesheet.css; do
    if [ ! -f "$SOURCE_DIR/$source_name" ]; then
        echo "源码不完整，缺少：$source_name" >&2
        exit 1
    fi
done
if [ ! -f "$PACKAGE_DIR/CHECKSUMS.sha256" ]; then
    echo '缺少安装包完整性清单，请重新解压完整源码 ZIP。' >&2
    exit 1
fi
(cd -- "$PACKAGE_DIR" && sha256sum --check --quiet CHECKSUMS.sha256)

mkdir -p -- "$EXT_ROOT" "$BACKUP_ROOT"
STAGE_DIR=$(mktemp -d "$DATA_DIR/popup-llm-officeassistent/install-stage-XXXXXX")
BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-XXXXXX")
cp -a -- "$SOURCE_DIR" "$STAGE_DIR/$EXT_UUID"
if [ "$RECOMPILE_SCHEMAS" -eq 1 ]; then
    command -v glib-compile-schemas >/dev/null 2>&1
    glib-compile-schemas --strict "$STAGE_DIR/$EXT_UUID/schemas"
else
    if [ ! -s "$STAGE_DIR/$EXT_UUID/schemas/gschemas.compiled" ]; then
        echo '预编译 schema 缺失，请重新下载完整 Release 插件包；安装不会临时编译。' >&2
        exit 1
    fi
fi
GSETTINGS_BACKEND=memory gsettings --schemadir "$STAGE_DIR/$EXT_UUID/schemas" \
    range org.gnome.shell.extensions.popup-llm-officeassistent model-idle-time >/dev/null
GSETTINGS_BACKEND=memory gsettings --schemadir "$STAGE_DIR/$EXT_UUID/schemas" \
    range org.gnome.shell.extensions.popup-llm-officeassistent enable-ocr >/dev/null
GSETTINGS_BACKEND=memory gsettings --schemadir "$STAGE_DIR/$EXT_UUID/schemas" \
    range org.gnome.shell.extensions.popup-llm-officeassistent result-font-size >/dev/null
GSETTINGS_BACKEND=memory gsettings --schemadir "$STAGE_DIR/$EXT_UUID/schemas" \
    range org.gnome.shell.extensions.popup-llm-officeassistent system-prompt-ocr >/dev/null
for key in translation-chunk-limit explain-chunk-limit polish-chunk-limit independent-chunk-limits-initialized; do
    GSETTINGS_BACKEND=memory gsettings --schemadir "$STAGE_DIR/$EXT_UUID/schemas" \
        range org.gnome.shell.extensions.popup-llm-officeassistent "$key" >/dev/null
done

HAD_OLD=0
INSTALLED_NEW=0
WAS_ENABLED=0
if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions list --enabled 2>/dev/null | grep -Fxq "$EXT_UUID"; then
        WAS_ENABLED=1
    fi
fi

rollback() {
    local code=$?
    trap - ERR
    echo '安装未完成，正在保留失败文件并恢复旧扩展。' >&2
    if [ "$INSTALLED_NEW" -eq 1 ] && [ -d "$TARGET_DIR" ]; then
        mv -- "$TARGET_DIR" "$BACKUP_DIR/failed-new-$EXT_UUID" || true
    fi
    if [ "$HAD_OLD" -eq 1 ] && [ -d "$BACKUP_DIR/$EXT_UUID" ] && [ ! -e "$TARGET_DIR" ]; then
        mv -- "$BACKUP_DIR/$EXT_UUID" "$TARGET_DIR" || true
    fi
    if [ "$WAS_ENABLED" -eq 1 ] && command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions enable "$EXT_UUID" >/dev/null 2>&1 || true
    fi
    echo "备份/诊断目录：$BACKUP_DIR" >&2
    exit "$code"
}
trap rollback ERR

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$EXT_UUID" >/dev/null 2>&1 || true
fi
if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
    # Set this before mv, so even a cross-filesystem partial failure is recoverable.
    HAD_OLD=1
    mv -- "$TARGET_DIR" "$BACKUP_DIR/$EXT_UUID"
fi
mv -- "$STAGE_DIR/$EXT_UUID" "$TARGET_DIR"
INSTALLED_NEW=1
chmod -R u+rwX,go+rX "$TARGET_DIR"
test -f "$TARGET_DIR/schemas/gschemas.compiled"
grep -Fq 'Model Idle Timeout' "$TARGET_DIR/prefs.js"
grep -Fq 'translator-drag-handle' "$TARGET_DIR/resultWindow.js"
grep -Fq 'translator-pin-btn' "$TARGET_DIR/resultWindow.js"
grep -Fq '_setPinned(' "$TARGET_DIR/resultWindow.js"
grep -Fq 'actor.set_translation' "$TARGET_DIR/resultWindow.js"
grep -Fq 'Clutter.OffscreenRedirect.ALWAYS' "$TARGET_DIR/resultWindow.js"
grep -Fq '_makeOutputSelectable' "$TARGET_DIR/resultWindow.js"
grep -Fq 'resultFontStyle(' "$TARGET_DIR/resultWindow.js"
grep -Fq 'resultFontStyle(' "$TARGET_DIR/popupGeometry.js"
grep -Fq '_beginOutputSelection' "$TARGET_DIR/resultWindow.js"
grep -Fq 'global.stage.get_event_actor(event)' "$TARGET_DIR/resultWindow.js"
grep -Fq 'Clutter.CursorType.TEXT' "$TARGET_DIR/resultWindow.js"
grep -Fq 'attr_background_new' "$TARGET_DIR/resultWindow.js"
grep -Fq 'makeTextMap' "$TARGET_DIR/textSelection.js"
grep -Fq "connect('new-frame'" "$TARGET_DIR/frameLoop.js"
grep -Fq 'No-shadow popup baseline (2.0.4)' "$TARGET_DIR/stylesheet.css"
grep -Fq 'popupDragDamage' "$TARGET_DIR/backendUtils.js"
grep -Fq '_raisePopupIcon' "$TARGET_DIR/extension.js"
trap - ERR
rmdir -- "$STAGE_DIR" 2>/dev/null || true

echo '已安装 Popup LLM Office Assistent 2.3.6（结果弹窗左上角可固定位置并保护关闭；其他功能保留）。'
echo "安装路径：$TARGET_DIR"
if [ "$RECOMPILE_SCHEMAS" -eq 0 ]; then echo '已使用包内预编译 schema，本次未执行编译。'; fi
if [ "$HAD_OLD" -eq 1 ]; then
    echo "旧版完整备份：$BACKUP_DIR/$EXT_UUID"
else
    rmdir -- "$BACKUP_DIR" 2>/dev/null || true
fi
echo '原有字体大小等配置未重置。新版本会正确生成结果文字的 CSS 字号声明。'
echo '旧 -1 模型时间迁移为 60 秒；成功识别列表后清除不存在的模型选择。'
if command -v gnome-extensions >/dev/null 2>&1; then
    if ! gnome-extensions enable "$EXT_UUID"; then
        echo '当前会话尚未识别新扩展。请注销登录后在“扩展管理器”中启用。'
    fi
fi
echo '请注销并重新登录 GNOME，再打开扩展设置。不要在当前会话强行重新加载 Shell。'

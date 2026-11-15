#!/usr/bin/env bash
set -uo pipefail
POPUP_DIAG_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec bash "$POPUP_DIAG_DIR/popup-llm-officeassistent@yanjing_chen@qq.com/diagnose-ocr.sh"

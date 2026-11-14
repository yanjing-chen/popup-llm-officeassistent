#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
EXT_UUID='popup-llm-officeassistent@yanjing_chen@qq.com'
sha256sum --check --quiet CHECKSUMS.sha256
python3 scripts/release_tools.py checksums --check
glib-compile-schemas --strict --dry-run "$EXT_UUID/schemas"
bash -n install.sh verify.sh diagnose-selection.sh scripts/publish_from_6800h.sh
if command -v node >/dev/null 2>&1; then
    for source_file in "$EXT_UUID"/*.js; do
        node --input-type=module --check < "$source_file"
    done
    node --test tests/*.test.mjs
else
    echo '未安装 Node.js：已完成安装包/schema/脚本校验，跳过开发者逻辑测试。扩展运行不需要 Node.js。'
fi
python3 -m unittest discover -s tests -p 'test_*.py' -v

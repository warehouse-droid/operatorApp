#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
bash server/tools/delivery-request-ui-test.sh node tools/delivery-request-ui-checks.mjs
python3 server/tools/delivery-request-ui-evidence.py "${DELIVERY_UI_SOURCE_ROOT:-$repo_root/server}"

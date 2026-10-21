#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="$repo_root/server/deployments/special-po-warning-20261019"
cd "$repo_root"
SPECIAL_PO_WARNING_ROOT="$release/before" bash server/tools/special-po-warning-test.sh node tools/special-po-warning-checks.mjs baseline
SPECIAL_PO_WARNING_ROOT="$release/candidate" bash server/tools/special-po-warning-test.sh node tools/special-po-warning-checks.mjs final
SPECIAL_PO_WARNING_ROOT="$release/candidate" bash server/tools/special-po-warning-test.sh node tools/special-po-warning-final-checks.mjs

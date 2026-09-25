#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
mkdir -p server/test-artifacts/reconciled-split-inbound/baseline/src
cp server/test/support/reconciled-split-inbound-baseline.js server/test-artifacts/reconciled-split-inbound/baseline/src/smart-scm-split-inbound-sql.js
RECONCILED_SPLIT_INBOUND_BASELINE=1 bash server/tools/reconciled-split-inbound-test.sh node tools/reconciled-split-inbound-checks.mjs baseline
bash server/tools/reconciled-split-inbound-test.sh node tools/reconciled-split-inbound-checks.mjs suite
bash server/tools/reconciled-split-inbound-test.sh node tools/reconciled-split-inbound-checks.mjs static
bash server/tools/reconciled-split-inbound-test.sh node tools/reconciled-split-inbound-checks.mjs mutations

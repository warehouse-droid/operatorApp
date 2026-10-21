#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
release="$server_root/deployments/dispatch-source-decision-20261007"
artifact="$server_root/test-artifacts/dispatch-source-decision-20261007"
rm -f "$release/validation-passed.json" "$artifact/validation.json"
# Each child invocation registers teardown before creating any test resource.
DISPATCH_SOURCE_DECISION_ROOT="$release/before" bash tools/dispatch-source-decision-test.sh \
  node tools/dispatch-source-decision-checks.mjs baseline > "$artifact/baseline-final.log" 2>&1
DISPATCH_SOURCE_DECISION_ROOT="$release/candidate" bash tools/dispatch-source-decision-test.sh \
  node tools/dispatch-source-decision-checks.mjs final > "$artifact/final.log" 2>&1
DISPATCH_SOURCE_DECISION_ROOT="$release/candidate" bash tools/dispatch-source-decision-test.sh \
  node tools/dispatch-source-decision-mutations.mjs > "$artifact/mutations-final.log" 2>&1
python3 tools/dispatch-source-decision-evidence.py

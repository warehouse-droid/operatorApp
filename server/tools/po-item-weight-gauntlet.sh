#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact=test-artifacts/po-item-weight/final
mkdir -p "$artifact"
run=(bash tools/operator-display-test.sh)
"${run[@]}" unit node tools/po-item-weight-checks.mjs source
"${run[@]}" unit node tools/po-item-weight-checks.mjs static > "$artifact/static.log" 2>&1
"${run[@]}" db node tools/po-item-weight-focused.mjs > "$artifact/focused.log" 2>&1
"${run[@]}" unit node tools/po-item-weight-checks.mjs coverage > "$artifact/coverage.log" 2>&1
"${run[@]}" db node tools/po-item-weight-checks.mjs mutation > "$artifact/mutations.log" 2>&1
"${run[@]}" db node tools/po-item-weight-checks.mjs health > "$artifact/health.log" 2>&1
set +e
"${run[@]}" db npm test > "$artifact/full.log" 2>&1
full_status=$?
set -e
if [[ "$full_status" -gt 1 ]]; then exit "$full_status"; fi
"${run[@]}" unit node tools/po-item-weight-checks.mjs compare > "$artifact/full-comparison.log" 2>&1
"${run[@]}" unit node tools/po-item-weight-checks.mjs secrets > "$artifact/secrets.log" 2>&1
git diff --check -- src/purchase-order-weight-refresh.js src/inventory-repository.js src/netsuite-delayed-status-refresh-service.js src/server.js
"${run[@]}" unit node tools/po-item-weight-checks.mjs verify
printf 'PO item weight gauntlet passed: %s\n' "$artifact"

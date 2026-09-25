#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact=test-artifacts/co-completion/final
mkdir -p "$artifact"
run=(bash tools/operator-display-test.sh)
"${run[@]}" unit node tools/co-completion-checks.mjs source
"${run[@]}" unit node tools/co-completion-checks.mjs static > "$artifact/static.log" 2>&1
"${run[@]}" db node tools/co-completion-focused.mjs > "$artifact/focused.log" 2>&1
"${run[@]}" unit node tools/co-completion-checks.mjs coverage > "$artifact/coverage.log" 2>&1
"${run[@]}" db node tools/co-completion-checks.mjs mutation > "$artifact/mutations.log" 2>&1
"${run[@]}" db node tools/co-completion-checks.mjs health > "$artifact/health.log" 2>&1
set +e
"${run[@]}" db npm test > "$artifact/full.log" 2>&1
full_status=$?
set -e
if [[ "$full_status" -gt 1 ]]; then exit "$full_status"; fi
"${run[@]}" unit node tools/co-completion-checks.mjs compare > "$artifact/full-comparison.log" 2>&1
"${run[@]}" unit node tools/co-completion-checks.mjs secrets > "$artifact/secrets.log" 2>&1
git diff --check -- src/driver-repository.js src/server.js src/dispatch-fulfilled-so-repository.js src/dispatch-fulfilled-to-repository.js src/order-dependency-repository.js src/sales-order-auto-fulfillment-repository.js
"${run[@]}" unit node tools/co-completion-checks.mjs verify
printf 'CO completion gauntlet passed: %s\n' "$artifact"

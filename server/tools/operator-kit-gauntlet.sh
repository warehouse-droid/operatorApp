#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact=test-artifacts/operator-kit/final
mkdir -p "$artifact"
run=(bash tools/operator-display-test.sh)
"${run[@]}" unit node tools/operator-kit-checks.mjs source
"${run[@]}" unit node tools/operator-kit-checks.mjs static > "$artifact/static.log" 2>&1
"${run[@]}" db node tools/operator-kit-focused.mjs > "$artifact/focused.log" 2>&1
"${run[@]}" unit node tools/operator-kit-checks.mjs coverage > "$artifact/coverage.log" 2>&1
"${run[@]}" unit node tools/operator-kit-checks.mjs mutation > "$artifact/mutations.log" 2>&1
"${run[@]}" db node tools/operator-kit-checks.mjs health > "$artifact/health.log" 2>&1
set +e
"${run[@]}" db npm test > "$artifact/full.log" 2>&1
full_status=$?
set -e
if [[ "$full_status" -gt 1 ]]; then exit "$full_status"; fi
"${run[@]}" unit node tools/operator-kit-checks.mjs compare > "$artifact/full-comparison.log" 2>&1
"${run[@]}" unit node tools/operator-kit-checks.mjs secrets > "$artifact/secrets.log" 2>&1
git diff --check -- src/netsuite.js src/delivery-repository.js src/operator-netsuite-posting-*.js
"${run[@]}" unit node tools/operator-kit-checks.mjs verify
printf 'Kit fulfillment gauntlet passed: %s\n' "$artifact"

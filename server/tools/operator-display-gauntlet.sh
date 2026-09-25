#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact=test-artifacts/operator-display-fix/final
rm -rf "$artifact"
mkdir -p "$artifact"
if [[ "$EUID" == 0 ]]; then chown "${SUDO_UID:-1000}:${SUDO_GID:-1000}" "$artifact"; fi
run=(bash tools/operator-display-test.sh)
"${run[@]}" unit node tools/operator-display-checks.mjs source
"${run[@]}" unit node tools/operator-display-static.mjs current > "$artifact/static.log" 2>&1
"${run[@]}" db node tools/operator-display-checks.mjs focused > "$artifact/focused.log" 2>&1
DISPLAY_FIX_COVERAGE=1 DISPLAY_FIX_ARTIFACTS="$artifact/browser" "${run[@]}" browser node --test test/mbt/e2e/operator-delivery-refresh.test.js > "$artifact/browser.log" 2>&1
"${run[@]}" unit node tools/operator-display-checks.mjs mutation > "$artifact/mutations.log" 2>&1
"${run[@]}" unit node tools/operator-display-checks.mjs health > "$artifact/health.log" 2>&1
"${run[@]}" unit node tools/operator-display-checks.mjs coverage > "$artifact/coverage.log" 2>&1
set +e
"${run[@]}" db npm test > "$artifact/full.log" 2>&1
full_status=$?
set -e
if [[ "$full_status" -gt 1 ]]; then exit "$full_status"; fi
"${run[@]}" unit node tools/operator-display-checks.mjs compare > "$artifact/full-comparison.log" 2>&1
"${run[@]}" unit node test/support/scan-diff-secrets.mjs public/operator.js public/operator-delivery-refresh.js public/operator.html public/service-worker.js src/operator-linked-quantity-domain.js src/delivery-repository.js > "$artifact/secrets.log" 2>&1
git diff --check -- public/operator.js public/operator.html public/service-worker.js src/operator-linked-quantity-domain.js src/delivery-repository.js
"${run[@]}" unit node tools/operator-display-checks.mjs verify
printf 'Operator display checks passed; evidence: %s\n' "$artifact"

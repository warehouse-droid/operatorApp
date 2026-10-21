#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
release="$server_root/test-artifacts/whole-worktree-deployment-20260925"
sudo -n env WORKTREE_RELEASE_CHECK=dispatch-layers bash tools/worktree-release-test-20260925.sh bash -c '
set -Eeuo pipefail
node tools/executed-order-review-suites.mjs random > test-artifacts/random.log 2>&1
node tools/executed-order-review-mutations.mjs > test-artifacts/mutations.log 2>&1
node node_modules/c8/bin/c8.js --all=false --check-coverage=false \
  "--include=src/dispatch-executed-order-review*.js" \
  --include=src/dispatch-address-guard.js --include=public/dispatch-address-guard.js \
  --temp-directory=/tmp/worktree-review-c8 --report-dir=test-artifacts/executed-order-review/coverage \
  --reporter=text --reporter=json --reporter=json-summary \
  node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-executed-order-review.test.js \
  test/dispatch/unit/dispatch-executed-order-incidents.test.js \
  test/dispatch/property/dispatch-executed-order-review.test.js \
  test/dispatch/integration/dispatch-executed-order-review.test.js \
  test/mbt/unit/driver-live-route-prefix-lock.red.test.js \
  test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js > test-artifacts/coverage.log 2>&1
node tools/executed-order-review-replay.mjs test/dispatch/fixtures/executed-order-incidents.json > test-artifacts/replay.json 2>&1
printf "%s\n" "Dispatch release layers passed."
' > "$release/dispatch-layers.log" 2>&1

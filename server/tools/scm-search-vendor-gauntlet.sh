#!/usr/bin/env bash
set -Eeuo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$task_root"
task_run=(bash tools/scm-search-vendor-test.sh run)
task_artifacts=test-artifacts/scm-search-vendor
mkdir -p "$task_artifacts"
bash tools/scm-search-vendor-test.sh build >"$task_artifacts/build.log" 2>&1
bash tools/scm-search-vendor-test.sh setup >"$task_artifacts/migrate.log" 2>&1
task_tests=(
  test/dispatch/integration/scm-search-vendor-completion.test.js
  test/dispatch/integration/scm-vendor-completion-http.test.js
  test/dispatch/property/scm-vendor-completion.property.test.js
  test/dispatch/frontend/scm-search-vendor.browser.test.mjs
)
"${task_run[@]}" npx c8 --all=false --check-coverage=false \
  --include=src/scm-vendor-completion.js --include=src/dispatch-repository.js --include=src/server.js \
  --temp-directory=/tmp/scm-vendor-c8 --report-dir="$task_artifacts/coverage" \
  --reporter=json --reporter=json-summary \
  node test/support/run-scm-search-vendor-tests.mjs "${task_tests[@]}" >"$task_artifacts/focused.log" 2>&1
"${task_run[@]}" node test/support/check-scm-search-vendor-coverage.mjs >"$task_artifacts/coverage.log" 2>&1
"${task_run[@]}" node test/support/run-scm-search-vendor-tests.mjs \
  test/dispatch/integration/scm-schedule-loading-performance.red.test.js \
  test/dispatch/integration/scm-po-split-schedule-remaining.test.js \
  test/dispatch/frontend/scm-schedule-remarks-ui.red.test.js \
  test/dispatch/frontend/scm-schedule-column-preferences.test.js \
  test/dispatch/frontend/scm-schedule-columns.browser.test.mjs \
  src/scm-schedule-row-refresh-harness.js \
  src/scm-schedule-column-filter-integration-harness.js \
  src/netsuite-closed-order-repository-harness.js \
  src/scm-vrma-harness.js >"$task_artifacts/regression.log" 2>&1
# A deterministic randomized order makes the focused suite-health replay reproducible.
"${task_run[@]}" node --input-type=module -e '
  import { spawnSync } from "node:child_process";
  const files = process.argv.slice(1); let seed = 197;
  for (let i = files.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1); [files[i], files[j]] = [files[j], files[i]];
  }
  console.log("Suite-health seed: 197", files);
  process.exitCode = spawnSync(process.execPath,
    ["test/support/run-scm-search-vendor-tests.mjs", ...files], { stdio: "inherit", env: process.env }).status ?? 1;
' "${task_tests[@]}" >"$task_artifacts/shuffle.log" 2>&1
"${task_run[@]}" env MBT_MUTATION_EPHEMERAL=1 node test/support/run-scm-search-vendor-mutations.mjs >"$task_artifacts/mutations.log" 2>&1
task_js=(src/scm-vendor-completion.js src/dispatch-repository.js src/server.js public/scm-schedule.js
  test/support/run-scm-search-vendor-tests.mjs test/support/run-scm-search-vendor-mutations.mjs
  test/support/check-scm-search-vendor-coverage.mjs "${task_tests[@]}")
"${task_run[@]}" npx eslint --config eslint.mbt.config.js --max-warnings=0 "${task_js[@]}" >"$task_artifacts/lint.log" 2>&1
"${task_run[@]}" npx tsc --noEmit --allowJs --checkJs false --skipLibCheck --target ES2023 \
  --module NodeNext --moduleResolution NodeNext src/scm-vendor-completion.js >"$task_artifacts/types.log" 2>&1
"${task_run[@]}" node test/support/scan-diff-secrets.mjs src/scm-vendor-completion.js \
  migrations/197_scm_vendor_completion.sql test/scm-search-vendor-completion-spec.md \
  test/support/run-scm-search-vendor-tests.mjs test/support/run-scm-search-vendor-mutations.mjs \
  test/support/check-scm-search-vendor-coverage.mjs tools/scm-search-vendor-test.sh \
  tools/scm-search-vendor-gauntlet.sh "${task_tests[@]}" >"$task_artifacts/secrets.log" 2>&1
git diff --check
git rev-parse HEAD >"$task_artifacts/source-state.txt"
sha256sum "${task_js[@]}" migrations/197_scm_vendor_completion.sql >>"$task_artifacts/source-state.txt"
docker image inspect mbbs-scm-search-vendor-test:20260910 --format '{{.Id}}' >>"$task_artifacts/source-state.txt"
if [[ "${1:-}" != --focused ]]; then
  "${task_run[@]}" npm run test:mbt >"$task_artifacts/full.log" 2>&1
fi
echo "SCM feature checks passed. Artifacts: $task_root/$task_artifacts"

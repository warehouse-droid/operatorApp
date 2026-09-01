#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-po-split-live-schedule-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" || "${test_project}" != "mbbs-po-split-live-schedule-test" ]]; then
  echo "Refusing an unexpected PO Split live-schedule test target." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

recreate_database() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile tools run --rm migrate
}

cd "${repo_root}"
cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test mutation
recreate_database

echo "[PO Split live schedule] executable browser, property, and adversarial specification"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/dispatch/frontend/scm-po-split-ui.test.js

echo "[PO Split live schedule] catalog parity and concurrency specifications"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/dispatch/integration/scm-po-split-status-consistency.red.test.js
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/mbt/integration/scm-schedule-status-concurrency.test.js

echo "[PO Split live schedule] isolated surrounding HTTP and lifecycle regressions"
"${compose[@]}" --profile tools run --rm test node --input-type=module -e \
  "import { runNodeTestFilesIsolated } from './test/support/test-database-isolation.mjs'; process.exitCode = await runNodeTestFilesIsolated(['test/mbt/integration/scm-schedule-status-http.test.js','test/dispatch/integration/scm-po-split-editing.test.js','test/dispatch/integration/scm-po-destination-override.test.js','test/dispatch/integration/scm-po-split-schedule-remaining.test.js','test/workload/integration/scm-po-catalog.red.test.js'], { label: 'PO Split live schedule parity gauntlet' });"

echo "[PO Split live schedule] 100% changed-line coverage probes"
"${compose[@]}" --profile tools run --rm test npx c8 \
  --all=false --check-coverage=false --include=public/dispatch-scm.js \
  --temp-directory=/tmp/scm-po-split-live-ui-c8 \
  --report-dir=test-artifacts/scm-po-split-live-schedule/ui \
  --reporter=text --reporter=json \
  node --test --test-concurrency=1 test/dispatch/frontend/scm-po-split-ui.test.js
"${compose[@]}" --profile tools run --rm test npx c8 \
  --all=false --check-coverage=false --include=src/scm-purchase-order-catalog-repository.js \
  --temp-directory=/tmp/scm-po-split-live-catalog-c8 \
  --report-dir=test-artifacts/scm-po-split-live-schedule/catalog \
  --reporter=text --reporter=json \
  node --test --test-concurrency=1 test/dispatch/integration/scm-po-split-status-consistency.red.test.js
"${compose[@]}" --profile tools run --rm test npx c8 \
  --all=false --check-coverage=false --include=src/dispatch-repository.js \
  --temp-directory=/tmp/scm-po-split-live-revision-c8 \
  --report-dir=test-artifacts/scm-po-split-live-schedule/revision \
  --reporter=text --reporter=json \
  node --test --test-concurrency=1 test/mbt/integration/scm-schedule-status-concurrency.test.js
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-scm-po-split-live-schedule-coverage.mjs
"${compose[@]}" --profile tools run --rm test npm run coverage:scm-po-split-status-consistency

echo "[PO Split live schedule] syntax, type, and lint gates"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npx eslint \
  --config eslint.mbt.config.js --max-warnings=0 \
  public/dispatch-scm.js \
  src/dispatch-repository.js \
  src/scm-purchase-order-catalog-repository.js \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  test/dispatch/integration/scm-po-split-status-consistency.red.test.js \
  test/mbt/integration/scm-schedule-status-concurrency.test.js \
  test/support/check-scm-po-split-live-schedule-coverage.mjs \
  test/support/run-scm-po-split-live-schedule-mutations.mjs \
  test/support/run-scm-po-split-status-consistency-mutations.mjs \
  test/support/run-scm-po-split-ui-mutations.mjs

echo "[PO Split live schedule] mutation gates"
"${compose[@]}" --profile tools run --rm test npm run mutate:scm-po-split-ui
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation \
  npm run mutate:scm-po-split-status-consistency
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation \
  npm run mutate:scm-po-split-live-schedule

echo "[PO Split live schedule] full application regressions"
echo "[PO Split live schedule] recreate a clean workload database"
recreate_database
"${compose[@]}" --profile tools run --rm test npm run test:application-workload
echo "[PO Split live schedule] recreate a clean 429-file suite template"
recreate_database
"${compose[@]}" --profile tools run --rm test npm run test:mbt

echo "[PO Split live schedule] dependency and secret boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test node test/support/scan-diff-secrets.mjs \
  package.json \
  public/dispatch-scm.html \
  public/dispatch-scm.js \
  src/dispatch-repository.js \
  src/scm-purchase-order-catalog-repository.js \
  test/scm-po-split-live-schedule-parity-spec.md \
  test/scm-po-split-live-schedule-parity-evidence.md \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  test/dispatch/integration/scm-po-split-status-consistency.red.test.js \
  test/mbt/integration/scm-schedule-status-concurrency.test.js \
  test/support/check-scm-po-split-live-schedule-coverage.mjs \
  test/support/run-scm-po-split-live-schedule-mutations.mjs \
  test/support/run-scm-po-split-status-consistency-mutations.mjs \
  test/support/run-scm-po-split-ui-mutations.mjs \
  tools/scm-po-split-live-schedule-gauntlet.sh \
  tools/scm-po-split-live-schedule-source-state.sh
"${compose[@]}" --profile tools run --rm test \
  bash tools/scm-po-split-live-schedule-source-state.sh

echo "PO Split live-schedule parity gauntlet complete."

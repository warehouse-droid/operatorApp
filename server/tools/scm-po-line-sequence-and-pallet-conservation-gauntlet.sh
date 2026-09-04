#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-po-line-conservation-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" || "${test_project}" != "mbbs-po-line-conservation-test" ]]; then
  echo "Refusing an unexpected PO line sequence/conservation test target." >&2
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

echo "[PO line sequence/conservation] executable specification"
"${compose[@]}" --profile tools run --rm test node --test --test-concurrency=1 \
  test/dispatch/unit/scm-po-netsuite-line-sequence.contract.test.js \
  test/dispatch/frontend/scm-po-line-sequence.red.test.js \
  test/dispatch/integration/scm-po-stale-line-pallet-conservation.red.test.js

echo "[PO line sequence/conservation] adjacent split, catalog, and baseline safeguards"
"${compose[@]}" --profile tools run --rm test npm run test:scm-reconciliation-line-adjustment
"${compose[@]}" --profile tools run --rm test node --input-type=module -e \
  "import { runNodeTestFilesIsolated } from './test/support/test-database-isolation.mjs'; process.exitCode = await runNodeTestFilesIsolated(['test/dispatch/frontend/scm-po-split-ui.test.js','test/dispatch/integration/scm-po-split-editing.test.js','test/dispatch/integration/scm-po-split-corrected-receipt-visibility.test.js','test/workload/integration/scm-po-catalog.red.test.js'], { label: 'PO line sequence/conservation adjacent regressions' });"

echo "[PO line sequence/conservation] focused coverage probes"
"${compose[@]}" --profile tools run --rm test npx c8 \
  --all=false --check-coverage=false \
  --include=public/dispatch-scm.js \
  --temp-directory=/tmp/scm-po-line-sequence-ui-c8 \
  --report-dir=test-artifacts/scm-po-line-sequence/ui \
  --reporter=text --reporter=json \
  node --test --test-concurrency=1 test/dispatch/frontend/scm-po-line-sequence.red.test.js
"${compose[@]}" --profile tools run --rm test npx c8 \
  --all=false --check-coverage=false \
  --include=src/dispatch-repository.js \
  --include=src/scm-reconciliation-repository.js \
  --temp-directory=/tmp/scm-po-line-conservation-c8 \
  --report-dir=test-artifacts/scm-po-line-sequence/backend \
  --reporter=text --reporter=json \
  node --test --test-concurrency=1 test/dispatch/integration/scm-po-stale-line-pallet-conservation.red.test.js

echo "[PO line sequence/conservation] syntax, type, and lint gates"
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npx eslint \
  --config eslint.mbt.config.js --max-warnings=0 \
  public/dispatch-scm.js \
  src/dispatch-repository.js \
  src/netsuite.js \
  src/scm-reconciliation-repository.js \
  src/scm-reconciliation-service.js \
  test/dispatch/frontend/scm-po-line-sequence.red.test.js \
  test/dispatch/integration/scm-po-stale-line-pallet-conservation.red.test.js \
  test/dispatch/unit/scm-po-netsuite-line-sequence.contract.test.js \
  test/support/run-scm-po-line-sequence-and-pallet-conservation-mutations.mjs

echo "[PO line sequence/conservation] manual mutation gate"
"${compose[@]}" --profile tools run --rm -e MBT_MUTATION_EPHEMERAL=1 mutation \
  node test/support/run-scm-po-line-sequence-and-pallet-conservation-mutations.mjs

echo "[PO line sequence/conservation] clean workload and full regressions"
recreate_database
"${compose[@]}" --profile tools run --rm test npm run test:application-workload
recreate_database
"${compose[@]}" --profile tools run --rm test npm run test:mbt

echo "[PO line sequence/conservation] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test node test/support/scan-diff-secrets.mjs \
  public/dispatch-scm.html \
  public/dispatch-scm.js \
  public/dispatch.css \
  src/dispatch-repository.js \
  src/netsuite.js \
  src/scm-reconciliation-repository.js \
  src/scm-reconciliation-service.js \
  test/scm-po-line-sequence-and-pallet-conservation-spec.md \
  test/scm-po-line-sequence-and-pallet-conservation-evidence.md \
  test/dispatch/frontend/scm-po-line-sequence.red.test.js \
  test/dispatch/integration/scm-po-stale-line-pallet-conservation.red.test.js \
  test/dispatch/unit/scm-po-netsuite-line-sequence.contract.test.js \
  test/support/run-scm-po-line-sequence-and-pallet-conservation-mutations.mjs \
  tools/scm-po-line-sequence-and-pallet-conservation-gauntlet.sh \
  tools/scm-po-line-sequence-and-pallet-conservation-source-state.sh
"${compose[@]}" --profile tools run --rm test \
  bash tools/scm-po-line-sequence-and-pallet-conservation-source-state.sh

echo "PO line sequence/conservation gauntlet complete."

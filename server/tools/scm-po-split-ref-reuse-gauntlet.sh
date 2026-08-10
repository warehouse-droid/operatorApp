#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-mbt-p1-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "SCM PO split gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

echo "[scm-po-split] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[scm-po-split] lifecycle, read-model, and concurrency regression"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/mbt/integration/scm-po-split-ref-reuse.test.js

echo "[scm-po-split] upgrade and compatibility regressions"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js
"${compose[@]}" --profile tools run --rm test npm run test:scm-po-split-filters
"${compose[@]}" --profile tools run --rm test npm run test:scm-blanket-po
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-workflow

echo "[scm-po-split] syntax and lint"
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-repository.js
"${compose[@]}" --profile tools run --rm test node --check test/mbt/integration/scm-po-split-ref-reuse.test.js
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/dispatch-repository.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/scm-po-split-ref-reuse.test.js \
    test/support/check-scm-po-split-ref-reuse-coverage.mjs \
    test/support/run-scm-po-split-ref-reuse-mutations.mjs

echo "[scm-po-split] fresh changed-line coverage probes"
"${compose[@]}" --profile tools run --rm test \
  npx c8 --all=false \
    --check-coverage=false \
    --include=src/dispatch-repository.js \
    --temp-directory=/tmp/scm-po-split-ref-reuse-c8 \
    --report-dir=test-artifacts/scm-po-split-ref-reuse-coverage \
    --reporter=text \
    --reporter=json \
    node --test --test-concurrency=1 test/mbt/integration/scm-po-split-ref-reuse.test.js
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-scm-po-split-ref-reuse-coverage.mjs \
    test-artifacts/scm-po-split-ref-reuse-coverage/coverage-final.json

echo "[scm-po-split] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:scm-po-split-ref-reuse

echo "[scm-po-split] dependency and secret boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/145_scm_po_split_active_ref_uniqueness.sql \
    src/dispatch-repository.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/scm-po-split-ref-reuse.test.js \
    test/support/check-scm-po-split-ref-reuse-coverage.mjs \
    test/support/run-scm-po-split-ref-reuse-mutations.mjs \
    tools/scm-po-split-ref-reuse-gauntlet.sh \
    tools/scm-po-split-ref-reuse-source-state.sh

echo "[scm-po-split] source state"
"${server_root}/tools/scm-po-split-ref-reuse-source-state.sh"
echo "[scm-po-split] complete"

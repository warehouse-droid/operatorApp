#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-smart-scm-blanket-merge-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Blanket merge gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[blanket-merge] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[blanket-merge] frozen behavior, property, concurrency, and rollback contracts"
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-merge

echo "[blanket-merge] repeat-order stability"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 \
    test/mbt/integration/smart-scm-blanket-load-merge.test.js \
    test/mbt/property/smart-scm-blanket-merge-selection.property.test.js

echo "[blanket-merge] migration upgrade and neighboring Blanket workflows"
"${compose[@]}" --profile tools run --rm test \
  node --test --test-concurrency=1 test/mbt/integration/migration-upgrade.test.js
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-ui
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-blanket-workflow
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-pallet-overrides
"${compose[@]}" --profile tools run --rm test npm run test:smart-scm-authoritative-inbound-integration

echo "[blanket-merge] syntax and lint"
"${compose[@]}" --profile tools run --rm test node --check src/smart-scm-blanket-repository.js
"${compose[@]}" --profile tools run --rm test node --check public/scm-smart-blanket.js
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/smart-scm-blanket-repository.js \
    src/smart-scm-blanket-ui-harness.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/smart-scm-blanket-load-merge.test.js \
    test/mbt/integration/smart-scm-blanket-merge-migration.test.js \
    test/mbt/property/smart-scm-blanket-merge-selection.property.test.js \
    test/support/check-smart-scm-blanket-merge-coverage.mjs \
    test/support/run-smart-scm-blanket-merge-mutations.mjs

echo "[blanket-merge] changed-line execution probes"
"${compose[@]}" --profile tools run --rm test npm run coverage:smart-scm-blanket-merge
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-smart-scm-blanket-merge-coverage.mjs \
    test-artifacts/smart-scm-blanket-merge-coverage/coverage-final.json

echo "[blanket-merge] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:smart-scm-blanket-merge

echo "[blanket-merge] dependency and secret boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/146_smart_scm_blanket_load_merge.sql \
    public/scm-smart-blanket.js \
    public/scm-smart.html \
    src/server.js \
    src/smart-scm-blanket-repository.js \
    src/smart-scm-blanket-ui-harness.js \
    test/mbt/integration/migration-upgrade.test.js \
    test/mbt/integration/smart-scm-blanket-load-merge.test.js \
    test/mbt/integration/smart-scm-blanket-merge-migration.test.js \
    test/mbt/property/smart-scm-blanket-merge-selection.property.test.js \
    test/support/check-smart-scm-blanket-merge-coverage.mjs \
    test/support/run-smart-scm-blanket-merge-mutations.mjs \
    tools/smart-scm-blanket-merge-gauntlet.sh \
    tools/smart-scm-blanket-merge-source-state.sh

echo "[blanket-merge] source state"
bash "${server_root}/tools/smart-scm-blanket-merge-source-state.sh"
echo "[blanket-merge] complete"

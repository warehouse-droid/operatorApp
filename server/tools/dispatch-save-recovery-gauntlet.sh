#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
compose=(docker compose -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Dispatch save-recovery gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi

cd "${repo_root}"

echo "[dispatch-save-recovery] clean disposable database and fresh images"
"${compose[@]}" down
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d db
"${compose[@]}" --profile tools run --rm migrate

echo "[dispatch-save-recovery] unit, property, adversarial, HTTP integration, and concurrency regressions"
"${compose[@]}" --profile tools run --rm test \
  node test/support/run-dispatch-performance-tests.mjs unit property adversarial integration concurrency

echo "[dispatch-save-recovery] browser coordination and reconciliation-confirm contracts"
"${compose[@]}" --profile tools run --rm test node src/dispatch-save-coordination-harness.js
"${compose[@]}" --profile tools run --rm test node src/scm-reconciliation-server-integration-harness.js
"${compose[@]}" --profile tools run --rm test node src/dispatch-postcommit-warning-harness.js

echo "[dispatch-save-recovery] syntax, type, lint, and baseline manifest checks"
"${compose[@]}" --profile tools run --rm test node --check src/server.js
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-plan-repository.js
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test npm run lint:dispatch:performance
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    test/support/check-dispatch-save-recovery-coverage.mjs \
    test/support/run-dispatch-save-recovery-mutations.mjs
"${compose[@]}" --profile tools run --rm test node --test test/mbt/infrastructure/test-foundation.test.js

echo "[dispatch-save-recovery] fresh focused runtime coverage"
"${compose[@]}" --profile tools run --rm test \
  npx c8 --all=false \
    --check-coverage=false \
    --include=src/server.js \
    --include=src/dispatch-plan-repository.js \
    --include=src/dispatch-planner-v2-repository.js \
    --temp-directory=/tmp/dispatch-save-recovery-c8 \
    --report-dir=test-artifacts/dispatch-save-recovery-coverage \
    --reporter=text \
    --reporter=json \
    --reporter=json-summary \
    node test/support/run-dispatch-performance-tests.mjs integration concurrency
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-dispatch-save-recovery-coverage.mjs \
    test-artifacts/dispatch-save-recovery-coverage/coverage-final.json

echo "[dispatch-save-recovery] persisted critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:dispatch-save-recovery

echo "[dispatch-save-recovery] supply-chain and secret checks"
"${compose[@]}" --profile tools run --rm test npm run licenses:mbt
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-v2-repository.js \
    src/server.js \
    public/dispatch.js \
    src/dispatch-save-coordination-harness.js \
    test/dispatch \
    test/support/check-dispatch-save-recovery-coverage.mjs \
    test/support/run-dispatch-save-recovery-mutations.mjs \
    tools/dispatch-save-recovery-gauntlet.sh \
    tools/dispatch-save-recovery-source-state.sh

echo "[dispatch-save-recovery] source state"
"${server_root}/tools/dispatch-save-recovery-source-state.sh"

echo "[dispatch-save-recovery] complete"

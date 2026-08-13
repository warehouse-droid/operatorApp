#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-v2-summary-marker-gauntlet"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "V2 summary-marker gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[dispatch-v2-marker] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[dispatch-v2-marker] full related Dispatch suite"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch:performance
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-v2-plan-backfill
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-load-assignments-integration

echo "[dispatch-v2-marker] focused contracts repeated for suite health"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-v2-summary-marker
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-v2-summary-marker

echo "[dispatch-v2-marker] syntax, lint, and available static checks"
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-plan-repository.js
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-planner-v2-repository.js
"${compose[@]}" --profile tools run --rm test node --check src/server.js
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-v2-repository.js \
    src/server.js \
    test/dispatch/integration/dispatch-v2-summary-marker.red.test.js \
    test/dispatch/property/dispatch-v2-summary-marker.property.test.js \
    test/dispatch/unit/dispatch-v2-summary-marker-wiring.test.js \
    test/support/check-dispatch-v2-summary-marker-coverage.mjs \
    test/support/run-dispatch-v2-summary-marker-mutations.mjs
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt

echo "[dispatch-v2-marker] changed-line execution probes"
"${compose[@]}" --profile tools run --rm test npm run coverage:dispatch-v2-summary-marker
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-dispatch-v2-summary-marker-coverage.mjs \
    test-artifacts/dispatch-v2-summary-marker-coverage/coverage-final.json

echo "[dispatch-v2-marker] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:dispatch-v2-summary-marker

echo "[dispatch-v2-marker] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    src/dispatch-plan-repository.js \
    src/dispatch-planner-v2-repository.js \
    src/server.js \
    test/dispatch-v2-summary-marker-spec.md \
    test/dispatch/integration/dispatch-v2-summary-marker.red.test.js \
    test/dispatch/property/dispatch-v2-summary-marker.property.test.js \
    test/dispatch/unit/dispatch-v2-summary-marker-wiring.test.js \
    test/support/check-dispatch-v2-summary-marker-coverage.mjs \
    test/support/run-dispatch-v2-summary-marker-mutations.mjs \
    tools/dispatch-v2-summary-marker-gauntlet.sh \
    tools/dispatch-v2-summary-marker-source-state.sh
bash "${server_root}/tools/dispatch-v2-summary-marker-source-state.sh"
echo "[dispatch-v2-marker] complete"

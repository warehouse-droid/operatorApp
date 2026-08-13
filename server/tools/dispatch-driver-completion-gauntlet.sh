#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-driver-completion-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Dispatch completion gauntlet could not find docker-compose.mbt-test.yml." >&2
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

echo "[dispatch-completion] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[dispatch-completion] frozen split, group, inactive-relation, and exact-ref contracts"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-driver-completion

echo "[dispatch-completion] syntax and lint"
"${compose[@]}" --profile tools run --rm test node --check src/dispatch-history-mode.js
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/dispatch-history-mode.js \
    test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
    test/support/check-dispatch-driver-completion-coverage.mjs \
    test/support/run-dispatch-driver-completion-mutations.mjs

echo "[dispatch-completion] changed-line execution probes"
"${compose[@]}" --profile tools run --rm test npm run coverage:dispatch-driver-completion
"${compose[@]}" --profile tools run --rm test \
  node test/support/check-dispatch-driver-completion-coverage.mjs \
    test-artifacts/dispatch-driver-completion-coverage/coverage-final.json

echo "[dispatch-completion] critical mutation set"
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:dispatch-driver-completion

echo "[dispatch-completion] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    src/dispatch-history-mode.js \
    test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js \
    test/support/check-dispatch-driver-completion-coverage.mjs \
    test/support/run-dispatch-driver-completion-mutations.mjs \
    tools/dispatch-driver-completion-gauntlet.sh \
    tools/dispatch-driver-completion-source-state.sh
bash "${server_root}/tools/dispatch-driver-completion-source-state.sh"
echo "[dispatch-completion] complete"

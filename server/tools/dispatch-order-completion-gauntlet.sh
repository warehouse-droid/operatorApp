#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-dispatch-order-completion-test"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Dispatch order-completion gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

echo "[dispatch-order-completion] fresh isolated images and database"
cleanup
"${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[dispatch-order-completion] executable completion contract"
"${compose[@]}" --profile tools run --rm test npm run test:dispatch-order-completion

echo "[dispatch-order-completion] type, lint, and browser syntax"
"${compose[@]}" --profile tools run --rm test npm run typecheck:mbt
"${compose[@]}" --profile tools run --rm test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/dispatch-completion-repository.js \
    src/mbt/mbbs-billing-candidate-service.js \
    test/dispatch/frontend/dispatch-completion-ui.test.js \
    test/mbt/adversarial/dispatch-completion-repository-adversarial.test.js \
    test/mbt/concurrency/dispatch-completion-races.test.js \
    test/mbt/integration/dispatch-completion-http.red.test.js \
    test/mbt/integration/dispatch-completion-migration.test.js \
    test/mbt/integration/dispatch-completion-status.red.test.js \
    test/support/run-dispatch-order-completion-mutations.mjs
"${compose[@]}" --profile tools run --rm test npm run syntax:legacy

echo "[dispatch-order-completion] coverage and critical mutations"
"${compose[@]}" --profile tools run --rm test npm run coverage:dispatch-order-completion
"${compose[@]}" --profile tools run --rm \
  -e MBT_MUTATION_EPHEMERAL=1 \
  mutation npm run mutate:dispatch-order-completion

echo "[dispatch-order-completion] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm test \
  node test/support/scan-diff-secrets.mjs \
    package.json \
    migrations/159_dispatch_order_completion_status.sql \
    public/dispatch.html public/dispatch.js \
    src/dispatch-completion-repository.js \
    src/mbt/mbbs-billing-candidate-service.js \
    src/server.js \
    test/dispatch/frontend/dispatch-completion-ui.test.js \
    test/mbt/adversarial/dispatch-completion-repository-adversarial.test.js \
    test/mbt/concurrency/dispatch-completion-races.test.js \
    test/mbt/integration/dispatch-completion-http.red.test.js \
    test/mbt/integration/dispatch-completion-migration.test.js \
    test/mbt/integration/dispatch-completion-status.red.test.js \
    test/mbt/infrastructure/p3-gauntlet-contract.test.js \
    test/mbt/specs/dispatch-completion-status.md \
    test/support/p3-mutation-manifest.mjs \
    test/support/run-dispatch-order-completion-mutations.mjs \
    tools/dispatch-order-completion-gauntlet.sh \
    tools/dispatch-order-completion-source-state.sh \
    tools/mbt-predeploy-readiness.mjs
bash "${server_root}/tools/dispatch-order-completion-source-state.sh"
echo "[dispatch-order-completion] complete"

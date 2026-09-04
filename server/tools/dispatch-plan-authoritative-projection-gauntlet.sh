#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="${MBT_AUTHORITATIVE_PROJECTION_PROJECT:-mbbs-dispatch-authoritative-projection-test}"
compose=(docker compose -p "${test_project}" -f "${compose_file}")
mutation_dir=""

if [[ ! -f "${compose_file}" ]]; then
  echo "Authoritative-projection gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ ! "${test_project}" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ ]]; then
  echo "Authoritative-projection gauntlet received an invalid isolated Compose project name." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [[ "${mutation_dir}" == /tmp/dispatch-authoritative-projection.* && -d "${mutation_dir}" ]]; then
    rm -rf -- "${mutation_dir}"
  fi
}
trap cleanup EXIT
cd "${repo_root}"

echo "[Authoritative projection] isolated image and database"
cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[Authoritative projection] executable specification"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=1 \
    test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js \
    test/mbt/unit/dispatch-plan-authoritative-projection-wiring.contract.test.js \
    test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
    test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js \
    test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js \
    test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js

echo "[Authoritative projection] related dependency and group regressions"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=1 \
    test/mbt/unit/scm-dependency-plan-reconciler.red.test.js \
    test/mbt/unit/scm-dependency-command-service.red.test.js \
    test/dispatch/unit/dispatch-po-route-residual.red.test.js \
    test/dispatch/integration/dispatch-assignment-readiness-invariant.red.test.js \
    test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js

echo "[Authoritative projection] changed-module coverage"
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx c8 --all=false \
    --include=src/dispatch-plan-order-projection.js \
    --temp-directory=/tmp/dispatch-authoritative-projection-c8 \
    --report-dir=test-artifacts/dispatch-plan-authoritative-projection/coverage \
    --reporter=text --reporter=json-summary \
    --check-coverage --lines 90 --functions 90 --statements 90 --branches 80 \
    node --test --test-concurrency=1 \
      test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js \
      test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
      test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js

echo "[Authoritative projection] syntax, lint, static types, and suite-order health"
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-plan-order-projection.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/dispatch-plan-repository.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  src/repair-dispatch-plan-267-authoritative-projection.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/server.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check \
  test/support/run-dispatch-plan-authoritative-projection-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test bash -n \
  tools/dispatch-plan-authoritative-projection-gauntlet.sh
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    src/dispatch-plan-order-projection.js \
    src/dispatch-plan-repository.js \
    src/repair-dispatch-plan-267-authoritative-projection.js \
    src/server.js \
    test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js \
    test/mbt/unit/dispatch-plan-authoritative-projection-wiring.contract.test.js \
    test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
    test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js \
    test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js \
    test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js \
    test/support/run-dispatch-plan-authoritative-projection-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test \
  npx tsc --noEmit --allowJs --checkJs \
    --module NodeNext --moduleResolution NodeNext --target ES2022 \
    --types node --skipLibCheck \
    test/support/run-dispatch-plan-authoritative-projection-mutations.mjs
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --test --test-concurrency=2 \
    test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js \
    test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
    test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js \
    test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js

echo "[Authoritative projection] manual mutation"
mutation_dir="$(mktemp -d /tmp/dispatch-authoritative-projection.XXXXXX)"
cp "${server_root}/src/dispatch-plan-order-projection.js" \
  "${mutation_dir}/dispatch-plan-order-projection.js"
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 \
  -v "${mutation_dir}/dispatch-plan-order-projection.js:/app/src/dispatch-plan-order-projection.js" \
  test node test/support/run-dispatch-plan-authoritative-projection-mutations.mjs

echo "[Authoritative projection] dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm --no-deps test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm --no-deps test \
  node test/support/scan-diff-secrets.mjs \
    src/dispatch-plan-order-projection.js \
    src/dispatch-plan-repository.js \
    src/repair-dispatch-plan-267-authoritative-projection.js \
    src/server.js \
    test/dispatch-plan-authoritative-projection-spec.md \
    test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js \
    test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js \
    test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js \
    test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
    test/mbt/unit/dispatch-plan-authoritative-projection.red.test.js \
    test/mbt/unit/dispatch-plan-authoritative-projection-wiring.contract.test.js \
    test/support/run-dispatch-plan-authoritative-projection-mutations.mjs \
    tools/dispatch-plan-authoritative-projection-gauntlet.sh \
    tools/dispatch-plan-authoritative-projection-source-state.sh
bash "${server_root}/tools/dispatch-plan-authoritative-projection-source-state.sh"

echo "Authoritative-projection gauntlet complete."

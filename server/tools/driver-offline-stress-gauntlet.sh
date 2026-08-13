#!/usr/bin/env bash
set -Eeuo pipefail

suite="${1:-full}"
case "${suite}" in
  smoke|full|soak) ;;
  *)
    echo "Usage: bash tools/driver-offline-stress-gauntlet.sh {smoke|full|soak}" >&2
    exit 64
    ;;
esac

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
project="mbbs-driver-offline-stress"
compose=(docker compose -p "${project}" -f "${compose_file}")

if [[ "${project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use a production Compose project." >&2
  exit 70
fi
if [[ ! -f "${compose_file}" ]]; then
  echo "Driver offline stress gauntlet could not find the isolated Compose file." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "${server_root}/test-artifacts/driver-offline-stress"
cleanup

echo "[driver-offline-stress] build pinned test, browser, mutation, and runtime images"
"${compose[@]}" --profile tools --profile runtime --profile e2e build test e2e mutation-p3 app
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" --profile runtime up -d --wait app

echo "[driver-offline-stress] matrix, syntax, lint, coverage, and dependency gates"
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:driver-offline-stress:matrix
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run lint:driver-offline-stress
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run coverage:driver-offline-stress
"${compose[@]}" --profile runtime --profile e2e run --rm e2e node --check test/driver-offline-stress/browser.spec.js
"${compose[@]}" --profile runtime --profile e2e run --rm e2e node --check test/driver-offline-stress/node-contract.test.js
"${compose[@]}" --profile runtime --profile e2e run --rm e2e npm ls --omit=dev --all

campaign_status=0
case "${suite}" in
  smoke)
    "${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:driver-offline-stress:smoke || campaign_status=$?
    ;;
  full)
    "${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:driver-offline-stress:full || campaign_status=$?
    ;;
  soak)
    "${compose[@]}" --profile runtime --profile e2e run --rm e2e npm run test:driver-offline-stress:soak || campaign_status=$?
    ;;
esac

if [[ "${suite}" != "smoke" ]]; then
  echo "[driver-offline-stress] persisted eight-mutant safety gate"
  "${compose[@]}" --profile tools run --rm \
    -e MBT_MUTATION_EPHEMERAL=1 \
    mutation-p3 npm run mutate:driver-offline-stress
fi

echo "[driver-offline-stress] scoped secret and source-state checks"
"${compose[@]}" --profile tools run --rm test node test/support/scan-diff-secrets.mjs \
  package.json \
  eslint.driver-offline-stress.config.js \
  test/driver-offline-stress-evidence.md \
  test/driver-offline-stress-remediation.md \
  test/driver-offline-stress-spec.md \
  test/driver-offline-stress.playwright.config.mjs \
  test/driver-offline-stress \
  test/fixtures/driver-offline-stress-history.json \
  test/mbt/property/driver-offline-stress-contract.test.js \
  test/support/driver-offline-stress-artifacts.mjs \
  test/support/driver-offline-stress-matrix.mjs \
  test/support/driver-offline-stress-model.mjs \
  test/support/run-driver-offline-soak.mjs \
  test/support/run-driver-offline-stress-mutations.mjs \
  test/support/run-driver-offline-stress.mjs \
  test/support/validate-driver-offline-stress-matrix.mjs \
  tools/driver-offline-stress-gauntlet.sh \
  tools/driver-offline-stress-source-state.sh
bash "${server_root}/tools/driver-offline-stress-source-state.sh"

if (( campaign_status != 0 )); then
  echo "[driver-offline-stress] ${suite} campaign retained a RED desired-behavior result." >&2
  exit "${campaign_status}"
fi
echo "[driver-offline-stress] ${suite} complete"

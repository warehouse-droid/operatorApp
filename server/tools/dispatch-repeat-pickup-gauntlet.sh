#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="${MBT_REPEAT_PICKUP_PROJECT:-mbbs-dispatch-repeat-pickup-test}"
capture_name="${DISPATCH_REPEAT_PICKUP_CAPTURE_NAME:-seven-day-2026-08-27_2026-09-02-capture.json}"
artifact_dir="${server_root}/test-artifacts/dispatch-planner-replay"
capture_path="${artifact_dir}/${capture_name}"
capture_container="/app/test-artifacts/dispatch-planner-replay/${capture_name}"
report_prefix="${capture_name%-capture.json}"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "Repeat-pickup gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ ! "${test_project}" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ ]]; then
  echo "Repeat-pickup gauntlet received an invalid isolated Compose project name." >&2
  exit 70
fi
if [[ "${test_project}" == "mbbs-operator-app" || "${compose_file}" == "${repo_root}/docker-compose.yml" ]]; then
  echo "Refusing to use the production Compose project." >&2
  exit 70
fi
if [[ ! -f "${capture_path}" || -L "${capture_path}" ]]; then
  echo "Repeat-pickup seven-day capture is missing or unsafe: ${capture_path}" >&2
  exit 66
fi

cleanup() {
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cd "${repo_root}"

echo "[repeat-pickup] fresh isolated images and disposable database"
cleanup
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile tools build test mutation
"${compose[@]}" up -d --wait db
"${compose[@]}" --profile tools run --rm migrate

echo "[repeat-pickup] executable unit, property, adversarial, race, frontend, and Driver contracts"
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:dispatch-repeat-pickup

echo "[repeat-pickup] affected planner and legacy route regressions"
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:dispatch:planner-optimization
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:dispatch-stop-visits
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:dispatch-pickup-override
"${compose[@]}" --profile tools run --rm --no-deps test npm run test:dispatch-driver-order

echo "[repeat-pickup] seven-day plan replay with fake late orders"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node tools/dispatch-planner-history-offline-replay.mjs \
    "${capture_container}" \
    "/app/test-artifacts/dispatch-planner-replay/${report_prefix}-offline-report.json" \
    7 \
    "/app/test-artifacts/dispatch-planner-replay/${report_prefix}-repeat-pickup-report.json" \
    "/app/test-artifacts/dispatch-planner-replay/${report_prefix}-driver-corpus.ndjson"

echo "[repeat-pickup] rollback-only Driver PWA completion replay"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node src/driver-seven-day-replay-harness.js \
    "/app/test-artifacts/dispatch-planner-replay/${report_prefix}-driver-corpus.ndjson"
"${compose[@]}" --profile tools run --rm --no-deps test \
  node --input-type=module -e \
  "import {query,closeDb} from './src/db.js'; const result=await query(\"SELECT COUNT(*)::int AS count FROM driver_job_records WHERE job_id LIKE 'seven-day-replay:%'\"); if(result.rows[0].count!==0) throw new Error('Driver replay rollback leaked records.'); console.log(JSON.stringify(result.rows[0])); await closeDb();"

echo "[repeat-pickup] changed-module coverage and critical mutations"
"${compose[@]}" --profile tools run --rm --no-deps test npm run coverage:dispatch-repeat-pickup
"${compose[@]}" --profile tools run --rm --no-deps \
  -e MBT_MUTATION_EPHEMERAL=1 mutation npm run mutate:dispatch-repeat-pickup

echo "[repeat-pickup] rendered Dispatch route output in desktop and mobile engines"
COMPOSE_PARALLEL_LIMIT=1 "${compose[@]}" --profile runtime --profile e2e build app e2e
"${compose[@]}" --profile runtime up -d --wait app
"${compose[@]}" --profile runtime --profile e2e run --rm --no-deps e2e \
  npx playwright test --config test/playwright.config.mjs \
    test/mbt/e2e/dispatch-repeat-pickup-visits.spec.js \
    --project=chromium-desktop \
    --project=chromium-mobile \
    --project=webkit-mobile \
    --workers=1 \
    --output=/app/test-artifacts/dispatch-repeat-pickup/playwright-output

echo "[repeat-pickup] syntax, lint, dependency, secret, and source-state boundaries"
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/dispatch-pickup-visits.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/dispatch-driver-order-harness.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check src/dispatch-planner-replay.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check public/dispatch.js
"${compose[@]}" --profile tools run --rm --no-deps test node --check test/mbt/e2e/dispatch-repeat-pickup-visits.spec.js
"${compose[@]}" --profile tools run --rm --no-deps test npm run lint:dispatch-repeat-pickup
"${compose[@]}" --profile tools run --rm --no-deps test npm run syntax:legacy
"${compose[@]}" --profile tools run --rm --no-deps test npm ls --omit=dev --all
"${compose[@]}" --profile tools run --rm --no-deps test npm run secrets:dispatch-repeat-pickup
bash "${server_root}/tools/dispatch-repeat-pickup-source-state.sh"

echo "Repeat-pickup gauntlet complete; nothing was deployed."

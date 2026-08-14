#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
test_project="mbbs-scm-schedule-status-test"
test_image="mbbs-scm-schedule-status-test:latest"
test_network="${test_project}_mbt_test_internal"
coverage_volume="mbbs_scm_schedule_status_coverage"
compose=(docker compose -p "${test_project}" -f "${compose_file}")

if [[ ! -f "${compose_file}" ]]; then
  echo "SCM schedule-status gauntlet could not find docker-compose.mbt-test.yml." >&2
  exit 70
fi
if [[ "${test_project}" != "mbbs-scm-schedule-status-test" \
      || "${test_image}" != "mbbs-scm-schedule-status-test:latest" \
      || "${coverage_volume}" != "mbbs_scm_schedule_status_coverage" ]]; then
  echo "Refusing an unexpected SCM schedule-status test target." >&2
  exit 70
fi

cleanup() {
  "${compose[@]}" --profile tools down --remove-orphans --volumes >/dev/null 2>&1 || true
  docker volume rm -f "${coverage_volume}" >/dev/null 2>&1 || true
  docker image rm -f "${test_image}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_environment=(
  -e NODE_ENV=test
  -e MBT_TEST_ISOLATED=1
  -e MBBS_ENV_FILE=.env.mbt-test-does-not-exist
  -e PORT=3000
  -e APP_BASE_URL=http://app:3000
  -e MBBS_REPO_ROOT=/workspace
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test
  -e MBT_ENABLED=true
  -e MBT_CUSTOMER_SYNC_ENABLED=false
  -e MBT_MASTER_DATA_ENABLED=false
  -e MBT_ASSET_MANAGEMENT_ENABLED=false
  -e MBT_FRONTDESK_OPERATIONS_ENABLED=false
  -e MBT_BIN_DISPATCH_ENABLED=false
  -e MBT_DRIVER_EXECUTION_ENABLED=false
  -e MBT_BILLING_OPERATIONS_ENABLED=false
  -e MBT_NETSUITE_WRITES_ENABLED=false
  -e NETSUITE_ACCOUNT_ID=
  -e NETSUITE_CLIENT_ID=
  -e NETSUITE_CLIENT_SECRET=
  -e NETSUITE_DIRECT_ACCESS_ENABLED=false
  -e NETSUITE_MIRROR_ROLE=disabled
  -e NETSUITE_MIRROR_SHARED_SECRET=
  -e SMART_SCM_LIVE_EXECUTION_ENABLED=false
  -e SMART_SCM_PICKING_TICKET_RESTLET_URL=
  -e SAMSARA_API_TOKEN=
  -e SAMSARA_WRITES_ENABLED=false
  -e GOOGLE_MAPS_API_KEY=
  -e PHOTO_UPLOAD_PROVIDER=local_data_url
  -e PHOTO_UPLOAD_TOKEN_SECRET=
  -e PHOTO_UPLOAD_WORKER_URL=
  -e SALES_PUBLIC_ACCESS_ENABLED=false
  -e OLLAMA_BASE_URL=http://127.0.0.1:9
)
docker_mounts=(
  -v "${repo_root}/.github/workflows:/workspace/.github/workflows:ro"
  -v "${compose_file}:/workspace/docker-compose.mbt-test.yml:ro"
)

run_test() {
  docker run --rm --network "${test_network}" \
    "${docker_environment[@]}" \
    "${docker_mounts[@]}" \
    "${test_image}" "$@"
}

cd "${repo_root}"
echo "[scm-schedule-status] fresh isolated image and database"
cleanup
docker build -f server/Dockerfile.test --target test-base -t "${test_image}" server
"${compose[@]}" up -d --wait db
run_test npm run migrate

echo "[scm-schedule-status] browser executable specification"
run_test node --test --test-concurrency=1 \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  test/dispatch/frontend/scm-schedule-status-save.test.js

echo "[scm-schedule-status] isolated repository, HTTP, and existing split lifecycle regressions"
run_test node --input-type=module -e \
  "import { runNodeTestFilesIsolated } from './test/support/test-database-isolation.mjs'; process.exitCode = await runNodeTestFilesIsolated(['test/mbt/integration/scm-schedule-status-concurrency.test.js','test/mbt/integration/scm-schedule-status-http.test.js','test/mbt/integration/scm-po-split-ref-reuse.test.js'], { label: 'SCM schedule-status gauntlet' });"

echo "[scm-schedule-status] related schedule, visibility, and reference contracts"
run_test npm run test:scm-schedule-row-refresh
run_test npm run test:scm-weight-schedule
run_test npm run test:scm-po-split-filters
run_test node src/scm-schedule-preference-harness.js
run_test node src/operator-camera-schedule-harness.js
run_test node src/scm-reconciliation-ui-harness.js
run_test node src/scm-order-visibility-harness.js
run_test node src/scm-dispatch-assignment-harness.js
run_test node src/scm-netsuite-po-history-filter-harness.js
run_test node src/scm-blanket-po-harness.js
run_test node src/scm-order-visibility-integration-harness.js
run_test npm run gauntlet:scm-status-precedence

echo "[scm-schedule-status] full MBT Node suite"
run_test npm run test:mbt

echo "[scm-schedule-status] syntax, types, and lint"
run_test node --check src/dispatch-repository.js
run_test node --check src/server.js
run_test node --check public/dispatch-scm.js
run_test node --check public/scm-schedule.js
run_test node --check test/mbt/integration/scm-schedule-status-concurrency.test.js
run_test node --check test/mbt/integration/scm-schedule-status-http.test.js
run_test node --check test/support/check-scm-schedule-status-coverage.mjs
run_test node --check test/support/run-scm-schedule-status-mutations.mjs
run_test npm run syntax:legacy
run_test npm run typecheck:mbt
run_test npx eslint --config eslint.mbt.config.js --max-warnings=0 \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  test/dispatch/frontend/scm-schedule-status-save.test.js \
  test/mbt/integration/scm-schedule-status-concurrency.test.js \
  test/mbt/integration/scm-schedule-status-http.test.js \
  test/mbt/infrastructure/p3-gauntlet-contract.test.js \
  test/support/check-scm-schedule-status-coverage.mjs \
  test/support/run-scm-schedule-status-mutations.mjs

echo "[scm-schedule-status] PO Split UI changed-line and mutation gauntlet"
run_test bash tools/scm-po-split-ui-gauntlet.sh

echo "[scm-schedule-status] fresh server and repository changed-line coverage"
docker volume create "${coverage_volume}" >/dev/null
docker run --rm --network "${test_network}" \
  --user 0:0 \
  "${docker_environment[@]}" \
  "${docker_mounts[@]}" \
  -v "${coverage_volume}:/coverage" \
  "${test_image}" \
  npx c8 --all=false --check-coverage=false \
    --include=src/dispatch-repository.js \
    --include=src/server.js \
    --temp-directory=/tmp/scm-schedule-status-c8 \
    --report-dir=/coverage \
    --reporter=text \
    --reporter=json \
    node --test --test-concurrency=1 \
      test/mbt/integration/scm-schedule-status-concurrency.test.js \
      test/mbt/integration/scm-schedule-status-http.test.js
docker run --rm --network "${test_network}" \
  "${docker_environment[@]}" \
  "${docker_mounts[@]}" \
  -v "${coverage_volume}:/coverage:ro" \
  "${test_image}" \
  node test/support/check-scm-schedule-status-coverage.mjs /coverage/coverage-final.json

echo "[scm-schedule-status] critical mutation set"
docker run --rm --network "${test_network}" \
  "${docker_environment[@]}" \
  "${docker_mounts[@]}" \
  -e MBT_MUTATION_EPHEMERAL=1 \
  "${test_image}" npm run mutate:scm-schedule-status

echo "[scm-schedule-status] dependency graph and secret boundaries"
run_test npm ls --omit=dev --all
run_test node test/support/scan-diff-secrets.mjs \
  package.json \
  public/dispatch-scm.html \
  public/dispatch-scm.js \
  public/scm-schedule.html \
  public/scm-schedule.js \
  src/dispatch-repository.js \
  src/scm-schedule-row-refresh-harness.js \
  src/scm-status-precedence-mutation-harness.js \
  src/server.js \
  test/dispatch/frontend/scm-po-split-ui.test.js \
  test/dispatch/frontend/scm-schedule-status-save.test.js \
  test/mbt/integration/scm-schedule-status-concurrency.test.js \
  test/mbt/integration/scm-schedule-status-http.test.js \
  test/support/check-scm-schedule-status-coverage.mjs \
  test/support/p3-mutation-manifest.mjs \
  test/support/run-scm-schedule-status-mutations.mjs \
  tools/scm-schedule-status-gauntlet.sh \
  tools/scm-schedule-status-source-state.sh

echo "[scm-schedule-status] source state"
"${server_root}/tools/scm-schedule-status-source-state.sh"
echo "[scm-schedule-status] complete; cleanup removes the test database, network, coverage volume, and image"

#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
artifact_dir="${server_root}/test-artifacts/removed-travel-recovery"
test_image="${TRAVEL_RECOVERY_TEST_IMAGE:-mbbs-mbt-p1-test-test:latest}"
test_network="${TRAVEL_RECOVERY_TEST_NETWORK:-}"
mkdir -p "${artifact_dir}"
cd "${repo_root}"

if [[ -z "${test_network}" ]]; then
  test_project="mbbs-removed-travel-recovery-test"
  compose=(docker compose -p "${test_project}" -f docker-compose.mbt-test.yml)
  trap '"${compose[@]}" --profile tools down --volumes --remove-orphans >/dev/null' EXIT
  "${compose[@]}" --profile tools build test
  "${compose[@]}" up -d --wait db
  "${compose[@]}" --profile tools run --rm migrate
  test_network="${test_project}_mbt_test_internal"
fi
[[ "$(docker network inspect "${test_network}" --format '{{.Internal}}')" == true ]]
runner=(docker run --rm -e MBT_TEST_ISOLATED=1 -e NODE_ENV=test
  -e MBBS_ENV_FILE=.env.missing -e NETSUITE_DIRECT_ACCESS_ENABLED=false
  -e SAMSARA_WRITES_ENABLED=false -e GOOGLE_MAPS_API_KEY=
  -v "${server_root}/src:/app/src:ro" -v "${server_root}/test:/app/test:ro")
docker image inspect "${test_image}" --format '{{.Id}}' > "${artifact_dir}/test-image.txt"

"${runner[@]}" --network none "${test_image}" node --test \
  test/mbt/unit/dispatch-pickup-travel-hotfix.test.js \
  test/mbt/unit/driver-live-route-prefix-lock.red.test.js \
  test/mbt/property/driver-live-route-prefix-lock.property.test.js \
  test/mbt/adversarial/driver-live-route-prefix-lock.adversarial.test.js \
  test/dispatch/unit/dispatch-planner-optimization.red.test.js \
  > "${artifact_dir}/unit-final.log" 2>&1

"${runner[@]}" --network "${test_network}" \
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
  "${test_image}" node --test --test-concurrency=1 \
  test/mbt/integration/dispatch-removed-travel-recovery.test.js \
  test/mbt/integration/dispatch-travel-reopen-hotfix.test.js \
  test/mbt/integration/driver-live-route-prefix-lock.integration.test.js \
  test/mbt/concurrency/driver-live-route-prefix-lock.concurrency.test.js \
  > "${artifact_dir}/integration-final.log" 2>&1

"${runner[@]}" --network "${test_network}" -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test "${test_image}" sh -c '
  node src/driver-pwa-stop-harness.js &&
  node src/driver-offline-repository-harness.js &&
  node --check src/driver-repository.js &&
  node --check src/driver-offline-service.js &&
  node --check src/dispatch-planner-performance.js &&
  node --check src/driver-pwa-repository.js &&
  npx eslint --config eslint.mbt.config.js --max-warnings=0 \
    test/mbt/unit/dispatch-pickup-travel-hotfix.test.js \
    test/mbt/integration/dispatch-travel-reopen-hotfix.test.js \
    test/mbt/integration/dispatch-removed-travel-recovery.test.js
' > "${artifact_dir}/static-final.log" 2>&1
git diff --check
sha256sum server/src/driver-repository.js server/src/driver-offline-service.js \
  > "${artifact_dir}/source.sha256"
tail -9 "${artifact_dir}/unit-final.log"
tail -9 "${artifact_dir}/integration-final.log"
cat "${artifact_dir}/static-final.log"

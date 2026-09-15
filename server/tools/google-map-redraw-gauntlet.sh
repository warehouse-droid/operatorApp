#!/usr/bin/env bash
set -Eeuo pipefail

server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
cd "${repo_root}"
mkdir -p server/test-artifacts/google-map-redraw
artifact_dir="$(mktemp -d "${server_root}/test-artifacts/google-map-redraw/final-XXXXXX")"
artifact_relative="${artifact_dir#"${server_root}/"}"
compose_file="${repo_root}/docker-compose.mbt-test.yml"
unit=(docker compose -p mbbs-map-redraw-unit -f "${compose_file}" --profile tools --profile runtime --profile e2e)
browser=(docker compose -p mbbs-map-driver-20260911 -f "${compose_file}" --profile tools --profile runtime --profile e2e)
test_image=mbbs-mbt-p1-test-test:latest
echo "Fresh evidence: ${artifact_dir}"

git archive HEAD:server >"${artifact_dir}/baseline.tar"
git diff --unified=0 -- server/src/google-maps-gateway.js server/public/dispatch.js >"${artifact_dir}/source.diff"
git rev-parse HEAD >"${artifact_dir}/base-commit.txt"
sha256sum server/src/google-maps-gateway.js server/public/dispatch.js server/public/dispatch.html >"${artifact_dir}/production-source.sha256"
"${unit[@]}" build test app e2e >"${artifact_dir}/build.log" 2>&1
"${unit[@]}" up -d --wait db >"${artifact_dir}/unit-db.log" 2>&1
"${unit[@]}" run --rm migrate >"${artifact_dir}/unit-migrate.log" 2>&1
"${browser[@]}" up -d --wait db >"${artifact_dir}/browser-db.log" 2>&1
"${browser[@]}" run --rm migrate >"${artifact_dir}/browser-migrate.log" 2>&1
if ! docker inspect mbbs-map-driver-replay-app >/dev/null 2>&1; then
  "${browser[@]}" run -d --name mbbs-map-driver-replay-app --use-aliases \
    -v "${server_root}/src:/app/src:ro" -v "${server_root}/public:/app/public:ro" \
    -e PHOTO_UPLOAD_WORKER_URL=http://127.0.0.1:3100/test-driver-photo \
    -e PHOTO_UPLOAD_TOKEN_SECRET=test-isolated-replay-photo-token app >"${artifact_dir}/browser-app.log" 2>&1
fi

run_pure() {
  docker run --rm --network none --read-only --tmpfs /tmp \
    --mount "type=bind,source=${server_root}/test-artifacts,target=/app/test-artifacts" \
    --entrypoint sh "${test_image}" -c "$1"
}
regressions() {
  "${unit[@]}" run --rm test npm run test:google-maps-usage >"${artifact_dir}/maps-usage.log" 2>&1
  "${unit[@]}" run --rm test npm run test:driver-live-route-prefix-lock >"${artifact_dir}/driver-prefix.log" 2>&1
  "${unit[@]}" run --rm test npm run test:mbt >"${artifact_dir}/full-mbt.log" 2>&1
  "${unit[@]}" run --rm -e MBBS_SERVER_ROOT=/app \
    -v "${repo_root}/docker-compose.v2.yml:/workspace/docker-compose.v2.yml:ro" \
    -v "${repo_root}/docker/v2.env.example:/workspace/docker/v2.env.example:ro" \
    test npm run test:baseline:mbt:full >"${artifact_dir}/legacy.log" 2>&1
}
regressions &
regression_pid=$!

replay_args=()
if [[ -n "${DRIVER_REPLAY_PLAN_FILE:-}" ]]; then
  replay_args=(-e "DRIVER_REPLAY_PLAN_FILE=${DRIVER_REPLAY_PLAN_FILE}")
fi
(
  "${browser[@]}" run --rm --no-deps "${replay_args[@]}" e2e npx playwright test \
    --config=test/playwright.config.mjs driver-plan-20260911-replay.spec.js dispatch-google-map-redraw.spec.js \
    >"${artifact_dir}/browser.log" 2>&1
  cp server/test-artifacts/playwright/report.json "${artifact_dir}/browser-report.json"
) &
browser_pid=$!
trap 'wait "${browser_pid}" "${regression_pid}" || true' EXIT

focused_tests="test/mbt/unit/google-maps-gateway.red.test.js test/mbt/unit/google-maps-route-geometry.red.test.js test/dispatch/frontend/dispatch-google-map-redraw.red.test.js test/mbt/property/google-maps-route-geometry.property.test.js"
run_pure "NODE_V8_COVERAGE=${artifact_relative}/v8 node --test ${focused_tests}" >"${artifact_dir}/focused.log" 2>&1
run_pure "node --test test/mbt/property/google-maps-route-geometry.property.test.js test/dispatch/frontend/dispatch-google-map-redraw.red.test.js test/mbt/unit/google-maps-route-geometry.red.test.js" >"${artifact_dir}/reversed-order.log" 2>&1
run_pure 'npm run lint:google-maps-usage && npx eslint --config eslint.mbt.config.js --max-warnings=0 test/dispatch/frontend/dispatch-google-map-redraw.red.test.js test/mbt/unit/google-maps-route-geometry.red.test.js test/mbt/property/google-maps-route-geometry.property.test.js test/mbt/e2e/dispatch-google-map-redraw.spec.js test/mbt/e2e/driver-plan-20260911-replay.spec.js test/support/google-map-redraw-fixture.mjs test/support/dispatch-map-driver-replay-fixture.mjs test/support/run-google-map-redraw-mutations.mjs test/support/google-map-redraw-changed-coverage.mjs tools/export-driver-plan-replay.mjs tools/verify-google-route-geometry.mjs' >"${artifact_dir}/lint.log" 2>&1
run_pure 'node --check public/dispatch.js && node --check src/google-maps-gateway.js' >"${artifact_dir}/syntax.log" 2>&1
run_pure 'npx eslint --config eslint.mbt.config.js --max-warnings=0 test/support/p3-mutation-manifest.mjs test/mbt/infrastructure/p3-gauntlet-contract.test.js' >"${artifact_dir}/registration-lint.log" 2>&1

baseline_type_status=0
current_type_status=0
docker run --rm --network none --user 0 --entrypoint sh --mount "type=bind,source=${artifact_dir}/baseline.tar,target=/baseline.tar,readonly" \
  "${test_image}" -c 'tar --no-same-owner --no-same-permissions -xf /baseline.tar -C /app && npm run typecheck:mbt' >"${artifact_dir}/types-baseline.log" 2>&1 || baseline_type_status=$?
run_pure 'npm run typecheck:mbt' >"${artifact_dir}/types-current.log" 2>&1 || current_type_status=$?
[[ "${baseline_type_status}" == "${current_type_status}" ]]
# The pinned TypeScript 7 CLI returns 1 for diagnostics (older tsc used 2).
# Matching exit codes alone is insufficient: require identical diagnostics too.
[[ "${current_type_status}" == 0 || "${current_type_status}" == 1 || "${current_type_status}" == 2 ]]
rg 'error TS[0-9]+' "${artifact_dir}/types-baseline.log" >"${artifact_dir}/baseline-diagnostics.txt" || true
rg 'error TS[0-9]+' "${artifact_dir}/types-current.log" >"${artifact_dir}/current-diagnostics.txt" || true
cmp "${artifact_dir}/baseline-diagnostics.txt" "${artifact_dir}/current-diagnostics.txt"
if [[ "${current_type_status}" != 0 ]]; then [[ -s "${artifact_dir}/current-diagnostics.txt" ]]; fi

docker run --rm --network none -e MBT_TEST_ISOLATED=1 -e MBT_MUTATION_EPHEMERAL=1 --entrypoint node \
  "${test_image}" test/support/run-google-map-redraw-mutations.mjs >"${artifact_dir}/mutations.log" 2>&1
docker run --rm --network none -e MBT_TEST_ISOLATED=1 -e MBT_MUTATION_EPHEMERAL=1 --entrypoint node \
  "${test_image}" test/support/run-google-maps-usage-mutations.mjs >"${artifact_dir}/usage-mutations.log" 2>&1
run_pure 'node test/support/scan-diff-secrets.mjs src/google-maps-gateway.js public/dispatch.js public/dispatch.html test/dispatch-google-map-redraw-spec.md test/dispatch/frontend/dispatch-google-map-redraw.red.test.js test/mbt/unit/google-maps-route-geometry.red.test.js test/mbt/property/google-maps-route-geometry.property.test.js test/mbt/e2e/driver-plan-20260911-replay.spec.js test/mbt/e2e/dispatch-google-map-redraw.spec.js test/support/google-map-redraw-fixture.mjs test/support/dispatch-map-driver-replay-fixture.mjs test/support/google-map-redraw-changed-coverage.mjs test/support/run-google-map-redraw-mutations.mjs tools/export-driver-plan-replay.mjs tools/verify-google-route-geometry.mjs tools/google-map-redraw-gauntlet.sh' >"${artifact_dir}/secrets.log" 2>&1
git diff --check
run_pure 'node test/support/scan-diff-secrets.mjs test/support/p3-mutation-manifest.mjs test/mbt/infrastructure/p3-gauntlet-contract.test.js' >"${artifact_dir}/registration-secrets.log" 2>&1
wait "${browser_pid}"
run_pure "node test/support/google-map-redraw-changed-coverage.mjs ${artifact_relative}" >"${artifact_dir}/changed-coverage.log" 2>&1
wait "${regression_pid}"
sha256sum --check "${artifact_dir}/production-source.sha256"
echo "Map redraw and dated Driver PWA gauntlet passed: ${artifact_dir}"

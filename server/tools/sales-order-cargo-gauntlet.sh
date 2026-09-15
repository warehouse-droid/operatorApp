#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${server_root}/.." && pwd)"
cd "${repo_root}"
release="${repo_root}/docker/backups/sales-order-cargo-20260911"
artifacts="$(mktemp -d "${server_root}/test-artifacts/sales-order-cargo/final-XXXXXX")"
chmod 777 "${artifacts}"
mkdir -p "${artifacts}/v8"
chmod 777 "${artifacts}/v8"
relative="${artifacts#"${server_root}/"}"
echo "Fresh evidence: ${artifacts}"
printf '%s\n' "${relative}" >server/test-artifacts/sales-order-cargo/latest.txt
image=mbbs-sales-cargo-test:20260911
compose=(docker compose -p mbbs-sales-cargo-20260911 -f docker-compose.mbt-test.yml -f "${release}/compose.test.yml" --profile tools)
docker build -f "${release}/Dockerfile.test" -t "${image}" server >"${artifacts}/build.log" 2>&1
git rev-parse HEAD >"${artifacts}/base-commit.txt"
sha256sum server/src/netsuite.js server/src/dispatch-planner-optimization.js server/src/dispatch-load-assignment.js \
  server/src/dispatch-allocation-item-identity.js server/public/dispatch.js server/public/dispatch.html \
  server/tools/repair-sob119965-cargo.mjs >"${artifacts}/source.sha256"
mkdir -p "${artifacts}/baseline"
docker run --rm --network none --entrypoint tar mbbs-operator-app:map-redraw-20260911-v1 \
  -cf - src/netsuite.js src/dispatch-planner-optimization.js src/dispatch-load-assignment.js public/dispatch.js \
  >"${artifacts}/baseline.tar"
tar -xf "${artifacts}/baseline.tar" -C "${artifacts}/baseline"
python3 - "${server_root}" "${artifacts}" <<'PY'
import difflib,json,sys
from pathlib import Path
root,artifact=map(Path,sys.argv[1:])
files=['src/netsuite.js','src/dispatch-planner-optimization.js','src/dispatch-load-assignment.js','src/dispatch-allocation-item-identity.js','public/dispatch.js','tools/repair-sob119965-cargo.mjs']
changed={}
for file in files:
 old=artifact/'baseline'/file
 before=old.read_text().splitlines() if old.exists() else []
 after=(root/file).read_text().splitlines()
 changed[file]=[line+1 for tag,_,__,start,end in difflib.SequenceMatcher(a=before,b=after,autojunk=False).get_opcodes() if tag!='equal' for line in range(start,end)]
(artifact/'changed-lines.json').write_text(json.dumps(changed))
PY
pure() {
  docker run --rm --network none --user 0 -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
    --mount "type=bind,source=${server_root}/test-artifacts,target=/app/test-artifacts" \
    --entrypoint sh "${image}" -c "$1"
}
focused='test/dispatch/unit/sales-order-cargo-integrity.red.test.js test/dispatch/frontend/sales-order-group-hydration.red.test.js'
pure "NODE_V8_COVERAGE=${relative}/v8 node --test ${focused}" >"${artifacts}/focused.log" 2>&1
pure 'node --test test/dispatch/frontend/sales-order-group-hydration.red.test.js test/dispatch/unit/sales-order-cargo-integrity.red.test.js' >"${artifacts}/reversed.log" 2>&1
"${compose[@]}" run --rm -e "NODE_V8_COVERAGE=${relative}/v8" test node --test test/dispatch/integration/sales-order-cargo-repair.test.js >"${artifacts}/repair-integration.log" 2>&1
"${compose[@]}" run --rm test npm run test:mbt >"${artifacts}/full-mbt.log" 2>&1
"${compose[@]}" run --rm -e MBBS_SERVER_ROOT=/app \
  -v "${repo_root}/docker-compose.v2.yml:/workspace/docker-compose.v2.yml:ro" \
  -v "${repo_root}/docker/v2.env.example:/workspace/docker/v2.env.example:ro" \
  test npm run test:baseline:mbt:full >"${artifacts}/legacy.log" 2>&1
"${compose[@]}" run --rm test npm run test:driver-live-route-prefix-lock >"${artifacts}/driver-prefix.log" 2>&1
"${compose[@]}" run --rm test node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-planner-optimization.red.test.js test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
  test/dispatch/integration/dispatch-order-catalog.red.test.js >"${artifacts}/catalog-regressions.log" 2>&1
pure 'npx eslint --config test/support/sales-order-cargo-eslint.config.mjs --max-warnings=0 src/dispatch-allocation-item-identity.js src/dispatch-planner-optimization.js test/dispatch/unit/sales-order-cargo-integrity.red.test.js test/dispatch/frontend/sales-order-group-hydration.red.test.js test/dispatch/integration/sales-order-cargo-repair.test.js test/support/sales-order-cargo-fixture.mjs test/support/sales-order-cargo-eslint.config.mjs test/mbt/e2e/sales-order-group-hydration.spec.js tools/repair-sob119965-cargo.mjs tools/sales-order-cargo-mutations.mjs tools/sales-order-cargo-coverage.mjs' >"${artifacts}/lint.log" 2>&1
pure 'node --check src/netsuite.js && node --check src/dispatch-load-assignment.js && node --check public/dispatch.js' >"${artifacts}/syntax.log" 2>&1
docker run --rm --network none --user 0 -e MBT_TEST_ISOLATED=1 -e MBT_MUTATION_EPHEMERAL=1 \
  --entrypoint node "${image}" tools/sales-order-cargo-mutations.mjs >"${artifacts}/mutations.log" 2>&1
baseline_status=0
current_status=0
docker run --rm --network none --entrypoint npm mbbs-mbt-p1-test-test:latest run typecheck:mbt >"${artifacts}/types-baseline.log" 2>&1 || baseline_status=$?
pure 'npm run typecheck:mbt' >"${artifacts}/types-current.log" 2>&1 || current_status=$?
[[ "${baseline_status}" == "${current_status}" ]]
rg 'error TS[0-9]+' "${artifacts}/types-baseline.log" >"${artifacts}/baseline-diagnostics.txt" || true
rg 'error TS[0-9]+' "${artifacts}/types-current.log" >"${artifacts}/current-diagnostics.txt" || true
cmp "${artifacts}/baseline-diagnostics.txt" "${artifacts}/current-diagnostics.txt"
docker run --rm --network mbbs-map-driver-20260911_mbt_test_internal \
  -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e MBT_TEST_BASE_URL=http://mbbs-map-driver-replay-app:3000 \
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
  --mount "type=bind,source=${server_root}/test,target=/app/test,readonly" \
  --mount "type=bind,source=${server_root}/src,target=/app/src,readonly" \
  --mount "type=bind,source=${server_root}/test-artifacts,target=/app/test-artifacts" \
  --entrypoint npx mbbs-mbt-p1-test-e2e:latest playwright test --config=test/playwright.config.mjs \
  --project=chromium-desktop sales-order-group-hydration.spec.js >"${artifacts}/browser.log" 2>&1
cp server/test-artifacts/playwright/report.json "${artifacts}/browser-report.json"
if [[ "${RUN_LIVE_REHEARSAL:-0}" == 1 ]]; then
  docker compose --env-file docker/env/.env -f docker-compose.yml -f "${release}/compose.override.yml" run --rm --no-deps \
    -e "NODE_V8_COVERAGE=/app/${relative}/v8" \
    -v "${server_root}/test-artifacts:/app/test-artifacts" \
    --entrypoint node app tools/repair-sob119965-cargo.mjs >"${artifacts}/live-rehearsal.log" 2>&1
fi
pure "node tools/sales-order-cargo-coverage.mjs ${relative}" >"${artifacts}/coverage.log" 2>&1
pure 'node test/support/scan-diff-secrets.mjs src/netsuite.js src/dispatch-load-assignment.js src/dispatch-allocation-item-identity.js src/dispatch-planner-optimization.js public/dispatch.js public/dispatch.html tools/repair-sob119965-cargo.mjs tools/sales-order-cargo-mutations.mjs tools/sales-order-cargo-coverage.mjs tools/sales-order-cargo-gauntlet.sh test/dispatch/unit/sales-order-cargo-integrity.red.test.js test/dispatch/frontend/sales-order-group-hydration.red.test.js test/dispatch/integration/sales-order-cargo-repair.test.js test/mbt/e2e/sales-order-group-hydration.spec.js test/support/sales-order-cargo-fixture.mjs' >"${artifacts}/secrets.log" 2>&1
git diff --check
sha256sum --check "${artifacts}/source.sha256" >"${artifacts}/source-check.log"
echo "Sales Order cargo gauntlet passed: ${artifacts}"

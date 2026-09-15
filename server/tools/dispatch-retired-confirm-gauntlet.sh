#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"
artifact="${repo_root}/server/test-artifacts/retired-confirm/${1:-final}"
mkdir -p "${artifact}"
chmod 777 "${artifact}"
image="mbbs-retired-confirm-test:baseline-20260914"
common=(--rm --network mbbs-retired-confirm_mbt_test_internal -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true
  -e MBBS_ENV_FILE=/nonexistent -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test
  -v "${repo_root}/.github/workflows:/workspace/.github/workflows:ro"
  -v "${repo_root}/docker-compose.yml:/workspace/docker-compose.yml:ro"
  -v "${repo_root}/docker-compose.mbt-test.yml:/workspace/docker-compose.mbt-test.yml:ro"
  -v "${repo_root}/docker-compose.v2.yml:/workspace/docker-compose.v2.yml:ro"
  -v "${repo_root}/docker/v2.env.example:/workspace/docker/v2.env.example:ro"
  -v "${repo_root}/server/test-artifacts:/app/test-artifacts")
run() { docker run "${common[@]}" --entrypoint "$1" "${image}" "${@:2}"; }
reset_test_database() {
  # Fixed task-owned tmpfs database. The production replay database is separate.
  docker exec mbbs-retired-confirm-db-1 psql -U mbt_test -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE mbt_test WITH (FORCE)' -c 'CREATE DATABASE mbt_test' >"${artifact}/reset.log" 2>&1
  run npm run migrate >"${artifact}/migrate.log" 2>&1
}
if [[ "${1:-}" == baseline ]]; then
  reset_test_database
  run npm run test:mbt >"${artifact}/full-mbt.log" 2>&1 || printf '%s\n' "$?" >"${artifact}/full-mbt.exit"
  run npm run test:baseline:mbt:full >"${artifact}/legacy.log" 2>&1 || printf '%s\n' "$?" >"${artifact}/legacy.exit"
  exit 0
fi
if [[ "${1:-}" == regression-baseline ]]; then
  reset_test_database
  run node --test --test-concurrency=1 test/dispatch/integration/dispatch-derived-order-freshness.red.test.js \
    test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
    test/dispatch/integration/dispatch-order-catalog.red.test.js test/dispatch/integration/dispatch-v2-command-flow.red.test.js \
    test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js \
    test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
    test/dispatch/frontend/dispatch-unplan-freshness.red.test.js test/dispatch/frontend/sales-order-group-hydration.red.test.js >"${artifact}/regressions.log" 2>&1 || true
  exit 0
fi
if [[ "${1:-}" == projection-baseline ]]; then
  reset_test_database
  run node --test --test-concurrency=1 test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js \
    test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
    test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js \
    test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js >"${artifact}/projection.log" 2>&1 || true
  exit 0
fi
python3 - "${artifact}" <<'PY'
from pathlib import Path
import shutil,sys,difflib,json
r=Path('server'); a=Path(sys.argv[1]); b=a/'build'
b.mkdir(exist_ok=True)
for name in ['src','public','test','tools','migrations']:
 shutil.copytree(r/name,b/name,dirs_exist_ok=True)
for p in r.iterdir():
 if p.is_file() and (p.suffix=='.json' or p.name.startswith('eslint')): shutil.copy2(p,b/p.name)
(b/'Dockerfile').write_text('FROM mbbs-retired-confirm-test:baseline-20260914\nCOPY --chown=node:node . /app/\n')
changed={}
for file in ['src/server.js','src/dispatch-plan-repository.js','src/dispatch-delivery-group-repository.js','src/dispatch-recorded-po-projection.js','src/dispatch-plan-order-projection.js','src/scm-dependency-plan-reconciler.js','public/dispatch.js','tools/repair-dispatch-retired-confirm.mjs']:
 old=r/'test-artifacts/retired-confirm/baseline'/file
 before=old.read_text().splitlines() if old.exists() else []
 after=(r/file).read_text().splitlines()
 changed[file]=[i+1 for tag,_,__,start,end in difflib.SequenceMatcher(a=before,b=after,autojunk=False).get_opcodes() if tag!='equal' for i in range(start,end)]
(a/'changed-lines.json').write_text(json.dumps(changed))
PY
image="mbbs-retired-confirm-test:20260914"
docker build -t "${image}" "${artifact}/build" >"${artifact}/build.log" 2>&1
sha256sum server/src/server.js server/src/dispatch-plan-repository.js server/src/dispatch-delivery-group-repository.js server/public/dispatch.js server/public/dispatch.html server/tools/repair-dispatch-retired-confirm.mjs >"${artifact}/source.sha256"
sha256sum server/src/dispatch-recorded-po-projection.js server/src/dispatch-plan-order-projection.js server/src/scm-dependency-plan-reconciler.js >>"${artifact}/source.sha256"
docker image inspect "${image}" mbbs-retired-confirm-test:baseline-20260914 mbbs-mbt-p1-test-e2e:latest --format '{{.Id}}' >"${artifact}/images.txt"
run node -p 'JSON.stringify({node:process.version,pg:require("pg/package.json").version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version})' >"${artifact}/versions.json"
reset_test_database
mkdir -p "${artifact}/v8"
chmod 777 "${artifact}/v8"
relative="${artifact#"${repo_root}/server/"}"
docker run "${common[@]}" -e "NODE_V8_COVERAGE=/app/${relative}/v8" --entrypoint node "${image}" --test --test-concurrency=1 \
  test/dispatch/frontend/dispatch-retired-confirm.test.js test/dispatch/integration/dispatch-retired-confirm.test.js \
  test/dispatch/integration/dispatch-retired-confirm-repair.test.js \
  test/dispatch/integration/dispatch-retired-confirm-timing.test.js \
  test/dispatch/integration/dispatch-recorded-po-load.test.js >"${artifact}/focused.log" 2>&1
docker run --rm --network mbbs-retired-confirm_mbt_test_internal -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true \
  -e MBBS_ENV_FILE=/nonexistent -e DATABASE_URL=postgres://mbt_test:mbt_test_password@replay-db:5432/mbt_replay \
  -e "NODE_V8_COVERAGE=/app/${relative}/v8" -v "${repo_root}/server/test-artifacts:/app/test-artifacts" \
  --entrypoint node "${image}" tools/repair-dispatch-retired-confirm.mjs >"${artifact}/repair-cli-rehearsal.log" 2>&1
docker run --rm --network mbbs-retired-confirm_mbt_test_internal -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true \
  -e MBBS_ENV_FILE=/nonexistent -e DATABASE_URL=postgres://mbt_test:mbt_test_password@replay-db:5432/mbt_replay \
  --entrypoint node "${image}" tools/replay-dispatch-retired-confirm.mjs >"${artifact}/replay.log" 2>&1
docker run --rm --network mbbs-retired-confirm_mbt_test_internal -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@replay-db:5432/mbt_replay \
  -v "${repo_root}/server/test-artifacts:/app/test-artifacts:ro" --entrypoint node "${image}" \
  tools/replay-dispatch-recorded-po.mjs test-artifacts/recorded-po-load/current-driver-activity.json >"${artifact}/recorded-po-replay.log" 2>&1
run node --test --test-concurrency=1 test/dispatch/integration/dispatch-derived-order-freshness.red.test.js \
  test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js test/dispatch/integration/dispatch-global-order-group-pool.red.test.js \
  test/dispatch/integration/dispatch-order-catalog.red.test.js test/dispatch/integration/dispatch-v2-command-flow.red.test.js \
  test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js test/dispatch/integration/dispatch-soa07894-event-replay.red.test.js \
  test/dispatch/frontend/dispatch-authoritative-retirement.red.test.js test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
  test/dispatch/frontend/dispatch-unplan-freshness.red.test.js test/dispatch/frontend/sales-order-group-hydration.red.test.js >"${artifact}/regressions.log" 2>&1 || regression_exit=$?
if [[ "${regression_exit:-0}" != 0 ]]; then
  cp server/test-artifacts/retired-confirm/regression-baseline/regressions.log "${artifact}/regressions-baseline.log"
  python3 server/tools/dispatch-retired-confirm-evidence.py compare "${artifact}/regressions-baseline.log" "${artifact}/regressions.log"
fi
run node --test --test-concurrency=1 test/dispatch/integration/dispatch-plan-authoritative-projection.red.test.js \
  test/dispatch/property/dispatch-plan-authoritative-projection.property.test.js \
  test/dispatch/adversarial/dispatch-plan-authoritative-projection.adversarial.test.js \
  test/dispatch/concurrency/dispatch-plan-authoritative-projection-concurrency.red.test.js >"${artifact}/projection.log" 2>&1 || projection_exit=$?
if [[ "${projection_exit:-0}" != 0 ]]; then
  python3 server/tools/dispatch-retired-confirm-evidence.py compare server/test-artifacts/retired-confirm/projection-baseline/projection.log "${artifact}/projection.log"
fi
run node --test --test-concurrency=1 test/dispatch/unit/dispatch-po-route-residual.red.test.js \
  test/dispatch/frontend/dispatch-po-route-residual-ui.red.test.js test/dispatch/property/dispatch-po-route-residual.property.test.js \
  test/dispatch/adversarial/dispatch-po-route-residual-adversarial.test.js >"${artifact}/po-residual.log" 2>&1
docker run "${common[@]}" --user 0 -e MBT_MUTATION_EPHEMERAL=1 --entrypoint node "${image}" tools/dispatch-retired-confirm-mutations.mjs >"${artifact}/mutations.log" 2>&1
run npm run typecheck:mbt >"${artifact}/types.log" 2>&1 || true
python3 server/tools/dispatch-retired-confirm-evidence.py types server/test-artifacts/retired-confirm/types-baseline.log "${artifact}/types.log"
run npx eslint --config test/support/retired-confirm-eslint.config.mjs --max-warnings=0 \
  src/server.js src/dispatch-plan-repository.js src/dispatch-delivery-group-repository.js tools/repair-dispatch-retired-confirm.mjs \
  src/dispatch-recorded-po-projection.js src/dispatch-plan-order-projection.js src/scm-dependency-plan-reconciler.js \
  tools/replay-dispatch-retired-confirm.mjs tools/dispatch-retired-confirm-mutations.mjs \
  test/dispatch/frontend/dispatch-retired-confirm.test.js test/dispatch/integration/dispatch-retired-confirm.test.js \
  test/dispatch/integration/dispatch-retired-confirm-repair.test.js test/dispatch/integration/dispatch-retired-confirm-timing.test.js \
  test/dispatch/integration/dispatch-recorded-po-load.test.js tools/replay-dispatch-recorded-po.mjs \
  test/support/retired-confirm-fixture.mjs >"${artifact}/lint.log" 2>&1 || lint_exit=$?
if [[ "${lint_exit:-0}" != 0 ]]; then
  python3 server/tools/dispatch-retired-confirm-evidence.py lint server/test-artifacts/retired-confirm/lint-baseline-with-projection.log "${artifact}/lint.log"
fi
run node --check public/dispatch.js >"${artifact}/syntax.log" 2>&1
run node test/support/scan-diff-secrets.mjs src/server.js src/dispatch-plan-repository.js src/dispatch-delivery-group-repository.js public/dispatch.js \
  src/dispatch-recorded-po-projection.js src/dispatch-plan-order-projection.js src/scm-dependency-plan-reconciler.js tools/replay-dispatch-recorded-po.mjs \
  tools/repair-dispatch-retired-confirm.mjs tools/replay-dispatch-retired-confirm.mjs >"${artifact}/secrets.log" 2>&1
git diff --check
docker run --rm --network none -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e "PLAYWRIGHT_JSON_OUTPUT_FILE=/app/${relative}/browser-report.json" \
  -v "${repo_root}/server/src:/app/src:ro" -v "${repo_root}/server/public:/app/public:ro" \
  -v "${repo_root}/server/test:/app/test:ro" -v "${repo_root}/server/test-artifacts:/app/test-artifacts" \
  --entrypoint npx mbbs-mbt-p1-test-e2e:latest playwright test --config=test/dispatch-unpacked-split.playwright.config.mjs --reporter=list,json >"${artifact}/browser.log" 2>&1
run node tools/sales-order-cargo-coverage.mjs "${relative}" >"${artifact}/coverage.log" 2>&1
for file in test/dispatch/integration/dispatch-recorded-po-load.test.js test/dispatch/integration/dispatch-retired-confirm-timing.test.js test/dispatch/integration/dispatch-retired-confirm-repair.test.js \
  test/dispatch/integration/dispatch-retired-confirm.test.js test/dispatch/frontend/dispatch-retired-confirm.test.js; do
  run node --test "${file}" >>"${artifact}/reordered.log" 2>&1
done
reset_test_database
run npm run test:mbt >"${artifact}/full-mbt.log" 2>&1 || full_exit=$?
if [[ "${full_exit:-0}" != 0 ]]; then
  python3 server/tools/dispatch-retired-confirm-evidence.py compare server/test-artifacts/retired-confirm/baseline/full-mbt.log "${artifact}/full-mbt.log"
fi
run npm run test:baseline:mbt:full >"${artifact}/legacy.log" 2>&1 || legacy_exit=$?
if [[ "${legacy_exit:-0}" != 0 ]]; then
  python3 server/tools/dispatch-retired-confirm-evidence.py compare server/test-artifacts/retired-confirm/baseline/legacy.log "${artifact}/legacy.log"
fi
sha256sum --check "${artifact}/source.sha256" >"${artifact}/source-check.log"
printf 'Gauntlet completed: %s\n' "${artifact}"

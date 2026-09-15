#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"
artifact="$(mktemp -d "${repo_root}/server/test-artifacts/stale-address/final-XXXXXX")"
chmod 777 "${artifact}"
mkdir -p "${artifact}/build" "${artifact}/v8"
chmod 777 "${artifact}/v8"
relative="${artifact#"${repo_root}/server/"}"
printf '%s\n' "${relative}" >server/test-artifacts/stale-address/latest.txt
printf 'Evidence: %s\n' "${artifact}"
python3 - "${artifact}" <<'PY'
from pathlib import Path
import shutil,sys,difflib,json
r=Path('server'); a=Path(sys.argv[1]); b=a/'build'
for name in ['src','public','test','tools','migrations']:
 shutil.copytree(r/name,b/name)
for p in [*r.glob('*.json'),*r.glob('eslint*.js'),r/'Dockerfile']:
 shutil.copy2(p,b/p.name)
(b/'Dockerfile.stale-test').write_text('FROM mbbs-mbt-p1-test-test:latest\nCOPY --chown=node:node . /app/\n')
files={'src/dispatch-delivery-group-repository.js':'dispatch-delivery-group-repository.js','public/dispatch.js':'dispatch.js','tools/repair-ce94487-stale-address.mjs':None}
changed={}
for file,old in files.items():
 prior=r/'test-artifacts/stale-address/baseline'/str(old)
 before=prior.read_text().splitlines() if old else []
 after=(r/file).read_text().splitlines()
 changed[file]=[i+1 for tag,_,__,start,end in difflib.SequenceMatcher(a=before,b=after,autojunk=False).get_opcodes() if tag!='equal' for i in range(start,end)]
(a/'changed-lines.json').write_text(json.dumps(changed))
PY
sha256sum server/public/dispatch.js server/public/dispatch.html server/src/dispatch-delivery-group-repository.js server/tools/repair-ce94487-stale-address.mjs >"${artifact}/source.sha256"
docker build -f "${artifact}/build/Dockerfile.stale-test" -t mbbs-stale-address-test:20260911 "${artifact}/build" >"${artifact}/build.log" 2>&1
docker image inspect mbbs-stale-address-test:20260911 mbbs-mbt-p1-test-test:latest mbbs-mbt-p1-test-e2e:latest --format '{{.Id}}' >"${artifact}/images.txt"
common=(--rm --network mbbs-stale-address_mbt_test_internal -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent
  -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test
  -v "${repo_root}/.github/workflows:/workspace/.github/workflows:ro"
  -v "${repo_root}/docker-compose.yml:/workspace/docker-compose.yml:ro"
  -v "${repo_root}/docker-compose.mbt-test.yml:/workspace/docker-compose.mbt-test.yml:ro"
  -v "${repo_root}/docker-compose.v2.yml:/workspace/docker-compose.v2.yml:ro"
  -v "${repo_root}/docker/v2.env.example:/workspace/docker/v2.env.example:ro"
  -v "${repo_root}/server/test-artifacts:/app/test-artifacts")
run() { docker run "${common[@]}" --entrypoint "$1" mbbs-stale-address-test:20260911 "${@:2}"; }
reset_test_database() {
  # This named container belongs only to this task and stores its data in tmpfs.
  docker exec mbbs-stale-address-db-1 psql -U mbt_test -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE mbt_test WITH (FORCE)' -c 'CREATE DATABASE mbt_test' >"${artifact}/database-reset.log" 2>&1
  run npm run migrate >"${artifact}/migrate.log" 2>&1
}
reset_test_database
run node --test test/dispatch/unit/dispatch-stale-address.test.js test/dispatch/frontend/dispatch-stale-address.test.js >"${artifact}/focused.log" 2>&1
docker run "${common[@]}" -e "NODE_V8_COVERAGE=/app/${relative}/v8" --entrypoint node mbbs-stale-address-test:20260911 --test --test-concurrency=1 \
  test/dispatch/integration/dispatch-stale-address.test.js test/dispatch/unit/dispatch-stale-address.test.js test/dispatch/frontend/dispatch-stale-address.test.js >"${artifact}/covered.log" 2>&1
run node --test --test-concurrency=1 test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
  test/dispatch/integration/dispatch-global-order-group-pool.red.test.js test/dispatch/integration/dispatch-order-catalog.red.test.js \
  test/dispatch/integration/dispatch-po-delivery-address-override.red.test.js test/dispatch/frontend/dispatch-planner-performance.contract.test.js \
  test/dispatch/frontend/dispatch-po-delivery-address-override.contract.test.js >"${artifact}/regressions.log" 2>&1 || regression_status=$?
if [[ "${regression_status:-0}" != 0 ]]; then
  docker run "${common[@]}" -v "${repo_root}/server/test-artifacts/stale-address/baseline/dispatch-delivery-group-repository.js:/app/src/dispatch-delivery-group-repository.js:ro" \
    --entrypoint node mbbs-stale-address-test:20260911 --test test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js >"${artifact}/regressions-baseline.log" 2>&1 || true
  python3 - "${artifact}" <<'PY'
import re,sys
from pathlib import Path
a=Path(sys.argv[1])
# Compare each failing test name and first error line, excluding stack offsets.
def normalized(name):
 data=(a/name).read_text()
 return [(part.splitlines()[0].split(' - ',1)[1],re.search(r'^  error: (.+)$',part,re.M).group(1))
         for part in re.split(r'(?m)(?=^not ok \d+ - )',data)[1:]]
current=normalized('regressions.log'); baseline=normalized('regressions-baseline.log')
assert baseline and current==baseline,(current,baseline)
print('Existing baseline failures unchanged:',current)
PY
fi
docker run "${common[@]}" --user 0 -e MBT_MUTATION_EPHEMERAL=1 --entrypoint node mbbs-stale-address-test:20260911 tools/dispatch-stale-address-mutations.mjs >"${artifact}/mutations.log" 2>&1
run npx eslint --config test/support/stale-address-eslint.config.mjs --max-warnings=0 src/dispatch-delivery-group-repository.js \
  tools/repair-ce94487-stale-address.mjs tools/dispatch-stale-address-mutations.mjs test/dispatch/unit/dispatch-stale-address.test.js \
  test/dispatch/frontend/dispatch-stale-address.test.js test/dispatch/integration/dispatch-stale-address.test.js \
  test/mbt/e2e/dispatch-stale-address.spec.js test/support/stale-address-eslint.config.mjs >"${artifact}/lint.log" 2>&1
docker run --rm --network none --entrypoint npm mbbs-mbt-p1-test-test:latest run typecheck:mbt >"${artifact}/types-baseline.log" 2>&1 || true
run npm run typecheck:mbt >"${artifact}/types-current.log" 2>&1 || true
rg 'error TS[0-9]+' "${artifact}/types-baseline.log" >"${artifact}/baseline-diagnostics.txt" || true
rg 'error TS[0-9]+' "${artifact}/types-current.log" >"${artifact}/current-diagnostics.txt" || true
cmp "${artifact}/baseline-diagnostics.txt" "${artifact}/current-diagnostics.txt"
docker run --rm --network none -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent -e "STALE_ADDRESS_PLAN_FILE=${STALE_ADDRESS_PLAN_FILE:-}" \
  -v "${repo_root}/server/src:/app/src:ro" -v "${repo_root}/server/public:/app/public:ro" \
  -v "${repo_root}/server/test:/app/test:ro" -v "${repo_root}/server/test-artifacts:/app/test-artifacts" \
  --entrypoint npx mbbs-mbt-p1-test-e2e:latest playwright test --config=test/dispatch-stale-address.playwright.config.mjs >"${artifact}/browser.log" 2>&1
cp server/test-artifacts/stale-address/browser-report.json "${artifact}/browser-report.json"
run node test/support/scan-diff-secrets.mjs src/dispatch-delivery-group-repository.js public/dispatch.js public/dispatch.html tools/repair-ce94487-stale-address.mjs >"${artifact}/secrets.log" 2>&1
git diff --check
sha256sum --check "${artifact}/source.sha256" >"${artifact}/source-check.log"
reset_test_database
run npm run test:mbt >"${artifact}/full-mbt.log" 2>&1
run npm run test:baseline:mbt:full >"${artifact}/legacy.log" 2>&1
printf 'Gauntlet passed: %s\n' "${artifact}"
# Coverage, including the CLI entry point, is finalized after the guarded live
# rehearsal: node tools/sales-order-cargo-coverage.mjs <evidence-directory>.

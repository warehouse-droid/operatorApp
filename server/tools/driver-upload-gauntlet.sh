#!/usr/bin/env bash
set -euo pipefail
driver_upload_repo=$(cd "$(dirname "$0")/../.." && pwd)
driver_upload_artifacts="$driver_upload_repo/server/test-artifacts/driver-upload-reliability"
driver_upload_project="mbbs-driver-upload-$$"
driver_upload_phase=${1:-final}
mkdir -p "$driver_upload_artifacts"
driver_upload_override="$driver_upload_artifacts/$driver_upload_phase-compose.json"
python3 - "$driver_upload_repo" "$driver_upload_override" "$driver_upload_phase" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); source=root/'server'; artifacts=source/'test-artifacts/driver-upload-reliability'
image='mbbs-to-yard-test-browser:20261009'
volumes=[f'{source/part}:/app/{part}:ro' for part in ['src','public','test','tools','migrations','contracts']]
volumes += [f'{source/file}:/app/{file}:ro' for file in ['package.json','package-lock.json','eslint.mbt.config.js','eslint.driver-upload.config.mjs','tsconfig.mbt.json']]
volumes += [f'{artifacts}/toolchain/node_modules:/app/node_modules:ro',f'{artifacts}:/app/test-artifacts']
limits={'image':image,'working_dir':'/app','user':'1000:1000','volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'}}
services={name:dict(limits) for name in ['test','migrate','app','e2e']}
if sys.argv[3] == 'regressions-baseline':
 services['test']['volumes'] = list(volumes) + [f'{artifacts}/baseline/{part}:/app/{part}:ro' for part in ['public/driver.js','public/driver.html','public/driver.css','public/driver-service-worker.js','src/server.js','src/driver-client-version.js','test/mbt/unit/driver-pwa-recovery-assets.test.js']]
services['db']={'mem_limit':'512m','memswap_limit':'512m','labels':{'com.mbbs.lifecycle':'disposable-test'}}
services['app'].update({'mem_limit':'768m','memswap_limit':'768m','environment':{'PHOTO_UPLOAD_PROVIDER':'r2_worker','PHOTO_UPLOAD_WORKER_URL':'http://upload:3999','PHOTO_UPLOAD_TOKEN_SECRET':'mbt_test_photo_secret','SAMSARA_WRITES_ENABLED':'false','CUSTOMER_WEBHOOK_ENABLED':'false'}})
services['e2e'].update({'mem_limit':'1536m','memswap_limit':'1536m','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','MBT_TEST_TRUSTED_PROXY_TARGET':'http://app:3000','MBT_TEST_TRUSTED_PROXY_PORT':'3100','MBT_TEST_BASE_URL':'http://127.0.0.1:3100','DRIVER_UPLOAD_TEST_PHASE':sys.argv[3]}})
services['upload']={**limits,'command':['node','test/support/driver-upload-worker-fixture.mjs'],'cgroup_parent':'mbbs-tests.slice','init':True,'mem_limit':'128m','memswap_limit':'128m','cpus':'0.25','pids_limit':128,'read_only':True,'tmpfs':['/tmp:uid=1000,gid=1000,size=32m'],'networks':['mbt_test_internal'],'restart':'no'}
Path(sys.argv[2]).write_text(json.dumps({'services':services},indent=2)+'\n')
PY
driver_upload_compose=(docker compose -p "$driver_upload_project" -f "$driver_upload_repo/docker-compose.mbt-test.yml" -f "$driver_upload_override" --profile runtime --profile e2e --profile tools)
cleanup_driver_upload_gauntlet() {
  "${driver_upload_compose[@]}" logs --no-color > "$driver_upload_artifacts/$driver_upload_phase-container.log" 2>&1 || true
  "${driver_upload_compose[@]}" down --volumes --remove-orphans > "$driver_upload_artifacts/$driver_upload_phase-teardown.log" 2>&1
  docker ps --format '{{.Names}} {{.Status}}' > "$driver_upload_artifacts/$driver_upload_phase-docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$driver_upload_artifacts/$driver_upload_phase-docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$driver_upload_artifacts/$driver_upload_phase-production-health.txt"
}
trap cleanup_driver_upload_gauntlet EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${driver_upload_compose[@]}" up -d --no-build --wait db upload > "$driver_upload_artifacts/$driver_upload_phase-startup.log" 2>&1
"${driver_upload_compose[@]}" run --rm --no-deps migrate node src/migrate.js > "$driver_upload_artifacts/$driver_upload_phase-migrations.log" 2>&1
echo 'Isolated migrations completed.'
if [[ "$driver_upload_phase" == backend ]]; then
  "${driver_upload_compose[@]}" run --rm --no-deps test sh -c 'node tools/driver-upload-history-corpus.mjs && DRIVER_REPLAY_FROM_DATE=2026-10-07 DRIVER_REPLAY_TO_DATE=2026-10-13 node node_modules/c8/bin/c8.js --include=src/driver-seven-day-replay-harness.js --temp-directory=/tmp/driver-upload-backend-c8 --reports-dir=test-artifacts/coverage-backend --reporter=json --reporter=json-summary node src/driver-seven-day-replay-harness.js test-artifacts/historical-corpus.ndjson' 2>&1 | tee "$driver_upload_artifacts/backend-history.log"
  exit
fi
if [[ "$driver_upload_phase" == regressions || "$driver_upload_phase" == regressions-baseline ]]; then
  "${driver_upload_compose[@]}" run --rm --no-deps test node tools/driver-upload-regressions.mjs 2>&1 | tee "$driver_upload_artifacts/$driver_upload_phase.log"
  exit
fi
if [[ "$driver_upload_phase" == setup ]]; then
  "${driver_upload_compose[@]}" run --rm --no-deps test sh -c 'node --version; ls -d /ms-playwright/*; node -e "console.log(require(\"@playwright/test/package.json\").version)"'
  exit
fi
"${driver_upload_compose[@]}" --profile runtime up -d --no-build --wait app >> "$driver_upload_artifacts/$driver_upload_phase-startup.log" 2>&1
"${driver_upload_compose[@]}" run --rm --no-deps test node node_modules/c8/bin/c8.js --include=src/server.js --include=src/driver-client-version.js --include=src/driver-upload-failure-repository.js --temp-directory=/tmp/driver-upload-http-c8 --reports-dir=test-artifacts/coverage-http --reporter=json --reporter=json-summary node --test --test-concurrency=1 test/mbt/integration/driver-upload-failure-http.test.js > "$driver_upload_artifacts/$driver_upload_phase-http.log" 2>&1
echo 'Failure audit integration checks completed.'
driver_upload_browser_args=()
if [[ "$driver_upload_phase" == smoke ]]; then driver_upload_browser_args=(--project chromium-mobile --grep '2026-10-07 history-cf969a5fc9'); fi
if [[ "$driver_upload_phase" == faults ]]; then driver_upload_browser_args=(faults.spec.js); fi
if [[ "$driver_upload_phase" == direct-pickups ]]; then driver_upload_browser_args=(--grep '2026-10-07 history-(00a9e4255a|6386713deb)'); fi
"${driver_upload_compose[@]}" run --rm --no-deps e2e node node_modules/@playwright/test/cli.js test --config test/driver-upload.playwright.config.mjs "${driver_upload_browser_args[@]}" 2>&1 | tee "$driver_upload_artifacts/$driver_upload_phase-browser.log"

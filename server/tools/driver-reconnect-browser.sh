#!/usr/bin/env bash
set -euo pipefail
recovery_repo=$(cd "$(dirname "$0")/../.." && pwd)
recovery_artifacts="$recovery_repo/server/test-artifacts/driver-reconnect-20261016/browser-${RECOVERY_PHASE:-final}"
recovery_project="mbbs-driver-reconnect-$$"
mkdir -p "$recovery_artifacts/results/server-coverage"
python3 - "$recovery_repo" "$recovery_artifacts" <<'PY'
import json,sys,os
from pathlib import Path
root,art=map(Path,sys.argv[1:]); server=root/'server'
image='mbbs-operator-app:transfer-eta-20261016'
image=os.environ.get('RECOVERY_IMAGE',image)
source=Path(os.environ.get('RECOVERY_SOURCE',str(server)))
browser='mbbs-to-yard-test-browser:20261009'
labels={'com.mbbs.lifecycle':'disposable-test'}
mounts=[f'{server/part}:/app/{part}:ro' for part in ['src','test','tools','contracts','public']]
mounts += [f'{server}/package.json:/app/package.json:ro']
mounts = [item for item in mounts if not any(f':/app/{part}:' in item for part in ['public','src'])]
mounts += [f'{source}/{part}:/app/{part}:ro' for part in ['src','public']]
mounts += [f'{server}/test-artifacts/driver-upload-reliability/toolchain/node_modules:/app/node_modules:ro',f'{art}/results:/app/test-artifacts']
services={
 'db':{'mem_limit':'512m','memswap_limit':'512m','labels':labels},
 'migrate':{'image':image,'labels':labels,'volumes':[f'{server}/migrations:/app/migrations:ro']},
 'app':{'image':image,'volumes':[f'{source}/public:/app/public:ro',f'{source}/src:/app/src:ro',f'{art}/results/server-coverage:/coverage'],
  'command':['node','--input-type=module','-e','import v8 from "node:v8"; const {startServer}=await import("./src/server.js"); await startServer(); setInterval(()=>v8.takeCoverage(),5000).unref();'],
  'mem_limit':'768m','memswap_limit':'768m','labels':labels,'environment':{'NODE_V8_COVERAGE':'/coverage',
  'PHOTO_UPLOAD_PROVIDER':'r2_worker','PHOTO_UPLOAD_WORKER_URL':'http://upload:3999',
  'PHOTO_UPLOAD_TOKEN_SECRET':'mbt_test_photo_secret','CUSTOMER_WEBHOOK_ENABLED':'false'}},
 'e2e':{'image':browser,'working_dir':'/app','user':'1000:1000','volumes':mounts,'labels':labels,
  'mem_limit':'1536m','memswap_limit':'1536m','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright',
  'NODE_V8_COVERAGE':'/app/test-artifacts/server-coverage',
  'MBT_TEST_TRUSTED_PROXY_TARGET':'http://app:3000','MBT_TEST_TRUSTED_PROXY_PORT':'3100'}},
 'upload':{'image':browser,'working_dir':'/app','user':'1000:1000','volumes':mounts,'labels':labels,
  'command':['node','test/support/driver-upload-worker-fixture.mjs'],'cgroup_parent':'mbbs-tests.slice','init':True,
  'mem_limit':'128m','memswap_limit':'128m','cpus':'0.25','pids_limit':128,'read_only':True,
  'tmpfs':['/tmp:uid=1000,gid=1000,size=32m'],'networks':['mbt_test_internal'],'restart':'no'}
}
(art/'compose.json').write_text(json.dumps({'services':services},indent=2)+'\n')
PY
recovery_compose=(docker compose -p "$recovery_project" -f "$recovery_repo/docker-compose.mbt-test.yml" -f "$recovery_artifacts/compose.json" --profile tools --profile runtime --profile e2e)
cleanup_stall() {
  "${recovery_compose[@]}" logs --no-color > "$recovery_artifacts/containers.log" 2>&1 || true
  "${recovery_compose[@]}" down --volumes --remove-orphans > "$recovery_artifacts/teardown.log" 2>&1
  docker ps --format '{{.Names}} {{.Status}}' > "$recovery_artifacts/docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$recovery_artifacts/docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$recovery_artifacts/production-health.txt"
}
trap cleanup_stall EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${recovery_compose[@]}" config --format json > "$recovery_artifacts/resolved-compose.json"
python3 - "$recovery_artifacts/resolved-compose.json" <<'PY'
import json,sys,os
services=json.load(open(sys.argv[1]))['services']
for name in ['db','app','migrate','e2e','upload']:
 service=services[name]
 assert service['cgroup_parent']=='mbbs-tests.slice'
 assert service['init'] is True
 assert 0 < int(service['mem_limit']) <= 2*1024**3
 assert service['memswap_limit']==service['mem_limit']
 assert 0 < int(service['pids_limit']) <= 512
 assert float(service['cpus']) > 0
 assert all('size=' in mount for mount in service.get('tmpfs',[]))
PY
"${recovery_compose[@]}" up -d --no-build --wait db upload > "$recovery_artifacts/startup.log" 2>&1
"${recovery_compose[@]}" run --rm --no-deps migrate node src/migrate.js > "$recovery_artifacts/migrations.log" 2>&1
"${recovery_compose[@]}" up -d --no-build --wait app >> "$recovery_artifacts/startup.log" 2>&1
if test "${RECOVERY_BILLING_ONLY:-0}" = 1; then
  "${recovery_compose[@]}" run --rm --no-deps e2e node --test test/mbt/integration/driver-billing-independent.test.js > "$recovery_artifacts/billing.log" 2>&1
  exit 0
fi
"${recovery_compose[@]}" run --rm --no-deps e2e node --test test/mbt/unit/driver-gps-radius.test.js test/mbt/integration/driver-upload-failure-http.test.js test/mbt/integration/driver-billing-independent.test.js > "$recovery_artifacts/gps-radius.log" 2>&1
if test "${RECOVERY_INTEGRATION_ONLY:-0}" = 1; then exit 0; fi
"${recovery_compose[@]}" run --rm --no-deps e2e node node_modules/@playwright/test/cli.js test --config test/driver-reconnect.playwright.config.mjs "$@" 2>&1 | tee "$recovery_artifacts/browser.log"

#!/usr/bin/env bash
set -euo pipefail
stall_repo=$(cd "$(dirname "$0")/../.." && pwd)
stall_artifacts="$stall_repo/server/test-artifacts/driver-upload-stall-20261015"
stall_project="mbbs-driver-stall-$$"
mkdir -p "$stall_artifacts/results"
python3 - "$stall_repo" "$stall_artifacts" <<'PY'
import json,sys
from pathlib import Path
root,art=map(Path,sys.argv[1:]); server=root/'server'
image='sha256:0c06748b37bafac7d08343331d2d1d9bd23d1bebc6bd79659cbc55645d109b8c'
browser='mbbs-to-yard-test-browser:20261009'
labels={'com.mbbs.lifecycle':'disposable-test'}
mounts=[f'{server/part}:/app/{part}:ro' for part in ['src','test','tools','contracts','public']]
mounts += [f'{server}/package.json:/app/package.json:ro']
mounts += [f'{server}/test-artifacts/driver-upload-reliability/toolchain/node_modules:/app/node_modules:ro',f'{art}/results:/app/test-artifacts']
services={
 'db':{'mem_limit':'512m','memswap_limit':'512m','labels':labels},
 'migrate':{'image':image,'labels':labels},
 'app':{'image':image,'mem_limit':'768m','memswap_limit':'768m','labels':labels,'environment':{
  'PHOTO_UPLOAD_PROVIDER':'r2_worker','PHOTO_UPLOAD_WORKER_URL':'http://upload:3999',
  'PHOTO_UPLOAD_TOKEN_SECRET':'mbt_test_photo_secret','CUSTOMER_WEBHOOK_ENABLED':'false'}},
 'e2e':{'image':browser,'working_dir':'/app','user':'1000:1000','volumes':mounts,'labels':labels,
  'mem_limit':'1536m','memswap_limit':'1536m','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright',
  'MBT_TEST_TRUSTED_PROXY_TARGET':'http://app:3000','MBT_TEST_TRUSTED_PROXY_PORT':'3100'}},
 'upload':{'image':browser,'working_dir':'/app','user':'1000:1000','volumes':mounts,'labels':labels,
  'command':['node','test/support/driver-upload-worker-fixture.mjs'],'cgroup_parent':'mbbs-tests.slice','init':True,
  'mem_limit':'128m','memswap_limit':'128m','cpus':'0.25','pids_limit':128,'read_only':True,
  'tmpfs':['/tmp:uid=1000,gid=1000,size=32m'],'networks':['mbt_test_internal'],'restart':'no'}
}
(art/'compose.json').write_text(json.dumps({'services':services},indent=2)+'\n')
PY
stall_compose=(docker compose -p "$stall_project" -f "$stall_repo/docker-compose.mbt-test.yml" -f "$stall_artifacts/compose.json" --profile tools --profile runtime --profile e2e)
cleanup_stall() {
  "${stall_compose[@]}" logs --no-color > "$stall_artifacts/containers.log" 2>&1 || true
  "${stall_compose[@]}" down --volumes --remove-orphans > "$stall_artifacts/teardown.log" 2>&1
  docker ps --format '{{.Names}} {{.Status}}' > "$stall_artifacts/docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$stall_artifacts/docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$stall_artifacts/production-health.txt"
}
trap cleanup_stall EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${stall_compose[@]}" config --format json > "$stall_artifacts/resolved-compose.json"
python3 - "$stall_artifacts/resolved-compose.json" <<'PY'
import json,sys
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
"${stall_compose[@]}" up -d --no-build --wait db upload > "$stall_artifacts/startup.log" 2>&1
"${stall_compose[@]}" run --rm --no-deps migrate node src/migrate.js > "$stall_artifacts/migrations.log" 2>&1
"${stall_compose[@]}" up -d --no-build --wait app >> "$stall_artifacts/startup.log" 2>&1
"${stall_compose[@]}" run --rm --no-deps e2e node --test test/mbt/unit/driver-gps-radius.test.js > "$stall_artifacts/gps-radius.log" 2>&1
"${stall_compose[@]}" run --rm --no-deps e2e node node_modules/@playwright/test/cli.js test --config test/driver-upload-stall.playwright.config.mjs "$@" 2>&1 | tee "$stall_artifacts/browser.log"

#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="$repo_root/server/deployments/delivery-driver-20261013/candidate-source"
artifact="$repo_root/server/test-artifacts/delivery-driver-release-20261013/driver"
project=mbbs-delivery-driver-check
mkdir -p "$artifact/results"
chmod a+rwx "$artifact/results"
override="$artifact/compose.json"
compose=(docker compose --project-directory "$repo_root" -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$override" --profile runtime --profile e2e --profile tools)
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" logs --no-color > "$artifact/containers.log" 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans > "$artifact/teardown.log" 2>&1 || status=1
  docker ps --format '{{.Names}} {{.Status}}' > "$artifact/docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/docker-ps-a.log"
  for resource in containers networks volumes; do
    case "$resource" in
      containers) remaining="$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ;;
      networks) remaining="$(docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ;;
      volumes) remaining="$(docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}')" ;;
    esac
    if [[ -n "$remaining" ]]; then status=1; fi
  done
  docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$artifact/production-health.log"
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || status=1
  printf 'teardown_exit=%s\n' "$status" >> "$artifact/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$repo_root" "$source_root" "$artifact" <<'PY'
import json,sys
from pathlib import Path
repo,source,artifact=map(Path,sys.argv[1:]); server=repo/'server'
volumes=[f'{source/n}:/app/{n}:ro' for n in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/n}:/app/{n}:ro' for n in ['test','tools','contracts','eslint.mbt.config.js','eslint.driver-upload.config.mjs','tsconfig.mbt.json','.c8rc.json']]
volumes += [f'{server/"test-artifacts/delivery-enhancements-20261013/toolchain/node_modules"}:/app/node_modules:ro',f'{artifact/"results"}:/app/test-artifacts']
common={'image':'mbbs-to-yard-test-browser:20261009','working_dir':'/app','user':'1000:1000','volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'}}
services={name:dict(common) for name in ['test','migrate','app','e2e']}
services['db']={'mem_limit':'512m','memswap_limit':'512m','labels':{'com.mbbs.lifecycle':'disposable-test'}}
services['app'].update({'mem_limit':'768m','memswap_limit':'768m','environment':{'PHOTO_UPLOAD_PROVIDER':'r2_worker','PHOTO_UPLOAD_WORKER_URL':'http://upload:3999','PHOTO_UPLOAD_TOKEN_SECRET':'mbt_test_photo_secret','SAMSARA_WRITES_ENABLED':'false','CUSTOMER_WEBHOOK_ENABLED':'false'}})
services['e2e'].update({'mem_limit':'1536m','memswap_limit':'1536m','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','MBT_TEST_TRUSTED_PROXY_TARGET':'http://app:3000','MBT_TEST_TRUSTED_PROXY_PORT':'3100','MBT_TEST_BASE_URL':'http://127.0.0.1:3100','DRIVER_UPLOAD_TEST_PHASE':'release'}})
services['upload']={**common,'command':['node','test/support/driver-upload-worker-fixture.mjs'],'cgroup_parent':'mbbs-tests.slice','init':True,'mem_limit':'128m','memswap_limit':'128m','cpus':'0.25','pids_limit':128,'read_only':True,'tmpfs':['/tmp:uid=1000,gid=1000,size=32m'],'networks':['mbt_test_internal'],'restart':'no'}
(artifact/'compose.json').write_text(json.dumps({'services':services},indent=2)+'\n')
PY
python3 "$repo_root/docker/verify-memory-limits.py" > "$artifact/memory-limits.log" 2>&1
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$artifact/startup.log" 2>&1
"${compose[@]}" run --rm --no-deps migrate node src/migrate.js > "$artifact/migrate.log" 2>&1
"${compose[@]}" run --rm --no-deps test node tools/delivery-driver-release-checks.mjs > "$artifact/unit-http.log" 2>&1
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 upload app >> "$artifact/startup.log" 2>&1
"${compose[@]}" run --rm --no-deps e2e node node_modules/@playwright/test/cli.js test faults.spec.js --config test/driver-upload.playwright.config.mjs > "$artifact/browser.log" 2>&1
python3 - "$artifact" <<'PY'
import json,sys
from pathlib import Path
artifact=Path(sys.argv[1]); report=json.loads((artifact/'results/browser-report.json').read_text()); results=[]
def visit(suite):
 for spec in suite.get('specs',[]):
  for case in spec['tests']:
   assert len(case['results'])==1 and case['results'][0]['status']=='passed',spec['title']
   results.append(case['projectName'])
 for child in suite.get('suites',[]): visit(child)
for suite in report['suites']: visit(suite)
assert len(results)==8 and results.count('chromium-mobile')==4 and results.count('webkit-mobile')==4
path=artifact/'results/driver-checks.json'; checks=json.loads(path.read_text());checks['layers'].append({'name':'mobile-faults','exitCode':0,'passed':8});path.write_text(json.dumps(checks,indent=2)+'\n')
print(json.dumps({'mobileFaultTests':len(results),'projects':sorted(set(results))}))
PY

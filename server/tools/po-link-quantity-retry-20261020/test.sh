#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
artifact="$repo_root/server/test-artifacts/po-link-quantity-retry-20261020"
project="mbbs-po-quantity-retry-test"
override="$artifact/compose.json"
source_root="${PO_QUANTITY_SOURCE:-$repo_root/server/deployments/po-link-quantity-retry-20261020/candidate}"
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
mkdir -p "$artifact/results"
chown 1000:1000 "$artifact/results"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
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
  local health_ok=0
  # Another authorized release can restart the shared app during teardown.
  # Require readiness before finishing, with a bounded grace period.
  for attempt in {1..20}; do
    if docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(1000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1 \
        && [[ "$(docker inspect --format '{{.State.Health.Status}}' mbbs-operator-app-app-1)" == healthy ]]; then
      health_ok=1
      break
    fi
    sleep 0.5
  done
  if [[ "$health_ok" != 1 ]]; then status=1; fi
  printf 'teardown_exit=%s\n' "$status" >> "$artifact/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$source_root" "$repo_root/server" "$override" <<'PY'
import difflib,json,sys
from pathlib import Path
source,server,target=map(Path,sys.argv[1:])
volumes=[f'{source/n}:/app/{n}:ro' for n in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/n}:/app/{n}:ro' for n in ['test','tools','contracts','eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']]
volumes += [f'{server}:/workspace/server:ro',f'{target.parent / "results"}:/app/test-artifacts']
volumes += [f'{server}/test-artifacts/mbr-contract/toolchain/node_modules:/app/node_modules:ro']
services={'db':{'image':'postgres:18-alpine','pull_policy':'never','labels':{'com.mbbs.lifecycle':'disposable-test'}}}
for key in ['test','migrate']:
 services[key]={'working_dir':'/app','entrypoint':[],'user':'1000:1000','image':'mbbs-operator-app:mbr-signing-defaults-browser-test-20261014','volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'},'environment':{'XDG_CONFIG_HOME':'/tmp/source-decision-config','XDG_CACHE_HOME':'/tmp/source-decision-cache','PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'}}
target.write_text(json.dumps({'services':services},indent=2)+'\n')
filename='src/dispatch-repository.js'
before=(server/'deployments/po-link-quantity-retry-20261020/before'/filename).read_text().splitlines()
after=(source/filename).read_text().splitlines()
lines=[]
for kind,_,_,start,end in difflib.SequenceMatcher(a=before,b=after,autojunk=False).get_opcodes():
 if kind in ('insert','replace'):
  lines.extend(range(start+1,end+1))
(target.parent/'results'/'changed-lines.json').write_text(json.dumps(lines)+'\n')
PY
if [[ "${PO_QUANTITY_SKIP_DB:-0}" != 1 ]]; then
  "${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$artifact/db-start.log" 2>&1
  "${compose[@]}" run --rm --no-deps migrate > "$artifact/migrate.log" 2>&1
fi
"${compose[@]}" run --rm --no-deps test "$@"

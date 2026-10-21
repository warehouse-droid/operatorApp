#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mode="${1:?Specify baseline, red, or final}"
shift
[[ "$mode" =~ ^(baseline|red|final)$ ]]
task_root="$repo_root/server/test-artifacts/pallet-saved-search-20261020"
artifact="$task_root/$mode"
project="mbbs-pallet-saved-search-$mode"
override="$artifact/compose.json"
if [[ "$mode" == final && -d "$artifact" ]]; then
  mv "$artifact" "$task_root/final-attempt-$(date -u +%Y%m%dT%H%M%S)"
fi
source_root="$repo_root/server/deployments/pallet-saved-search-20261020/candidate"
if [[ "$mode" == baseline ]]; then
  source_root="$repo_root/server/deployments/pallet-saved-search-20261020/before"
fi
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
mkdir -p "$artifact" "$task_root/baseline"
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
    printf '%s=%s\n' "$resource" "$remaining" >> "$artifact/teardown.log"
    if [[ -n "$remaining" ]]; then status=1; fi
  done
  docker exec mbbs-operator-app-app-1 node -e \
    "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
    >> "$artifact/teardown.log" 2>&1 || status=1
  printf 'teardown_exit=%s\n' "$status" >> "$artifact/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$source_root" "$repo_root/server" "$override" "$mode" <<'PY'
import difflib,json,sys
from pathlib import Path
source,server,target=map(Path,sys.argv[1:4])
mode=sys.argv[4]
volumes=[f'{source/n}:/app/{n}:ro' for n in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/n}:/app/{n}:ro' for n in ['test','tools','contracts','eslint.mbt.config.js','.c8rc.json']]
volumes += [f'{server}/deployments/pallet-saved-search-20261020/before/src:/baseline/src:ro']
if (server/'deployments/pallet-saved-search-20261020/changed-lines.json').exists():
 volumes += [f'{server}/deployments/pallet-saved-search-20261020/changed-lines.json:/baseline/changed-lines.json:ro']
volumes += [f'{server}/test-artifacts/pallet-saved-search-20261020/baseline:/baseline/checks:ro']
volumes += [f'{target.parent}:/app/test-artifacts/pallet-saved-search-20261020/{mode}']
volumes += [f'{server}/test-artifacts/mbr-contract/toolchain/node_modules:/app/node_modules:ro']
labels={'com.mbbs.lifecycle':'disposable-test','com.mbbs.task':f'mbbs-pallet-saved-search-{mode}'}
services={'db':{'image':'postgres:18-alpine','pull_policy':'never','labels':labels}}
for key in ['test','migrate']:
 services[key]={'working_dir':'/app','entrypoint':[],'user':'1000:1000',
  'image':'mbbs-operator-app:mbr-signing-defaults-browser-test-20261014','pull_policy':'never',
  'volumes':volumes,'labels':labels,'environment':{'PALLET_CHECK_MODE':mode}}
target.write_text(json.dumps({'services':services},indent=2)+'\n')
PY
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 60 db > "$artifact/db-start.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate > "$artifact/migrate.log" 2>&1
"${compose[@]}" run --rm --no-deps -T test "$@" > "$artifact/run.log" 2>&1

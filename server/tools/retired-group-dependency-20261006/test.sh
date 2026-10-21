#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
server_root="$repo_root/server"
artifact="$server_root/test-artifacts/retired-group-dependency-20261006"
project="mbbs-retired-group-dependency-test"
override="$artifact/compose.json"
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
mkdir -p "$artifact/results"
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
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || status=1
  printf 'teardown_exit=%s\n' "$status" >> "$artifact/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$server_root" "$override" "${RETIRED_GROUP_BASELINE:-0}" <<'PY'
import json,sys
from pathlib import Path
server,target=map(Path,sys.argv[1:3])
volumes=[f'{server/n}:/app/{n}:ro' for n in ['src','public','test','tools','migrations','contracts','package.json','package-lock.json','eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']]
volumes += [f'{server}:/workspace/server:ro',f'{target.parent / "results"}:/app/test-artifacts']
if sys.argv[3] == '1':
    volumes += [f'{target.parent / "baseline/src/order-dependency-repository.js"}:/app/src/order-dependency-repository.js:ro']
services={'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}
for name in ['test','migrate']:
    services[name]={'image':'mbbs-delivery-requests:final','volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'}}
target.write_text(json.dumps({'services':services},indent=2)+'\n')
PY
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$artifact/db-start.log" 2>&1
"${compose[@]}" run --rm --no-deps migrate > "$artifact/migrate.log" 2>&1
"${compose[@]}" run --rm --no-deps test "$@"

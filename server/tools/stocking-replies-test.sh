#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/stocking-replies-20261006"
project="mbbs-stocking-replies-test"
override="$artifact/compose.json"
source_root="${STOCKING_REPLIES_SOURCE_ROOT:-$repo_root/server}"
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
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
python3 - "$source_root" "$repo_root/server" "$override" <<'PY'
import json
from pathlib import Path
import sys
source, server, target=map(Path,sys.argv[1:])
volumes=[f'{source/n}:/app/{n}:ro' for n in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/n}:/app/{n}:ro' for n in ['test','tools','contracts','eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']]
volumes.append(f'{target.parent / "workspace-before"}:/app/stock-view-before:ro')
if (target.parent/'baseline-special-regressions.log').exists():
    volumes.append(f'{target.parent / "baseline-special-regressions.log"}:/app/test-artifacts/stocking-replies-20261006-baseline.log:ro')
(target.parent/'results'/'delivery-requests').mkdir(parents=True,exist_ok=True)
(target.parent/'results'/'stocking-replies-20261006').mkdir(parents=True,exist_ok=True)
volumes.append(f'{target.parent / "results"}:/app/test-artifacts')
services={'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}
for key in ['test','migrate']:
    services[key]={'image':'mbbs-delivery-requests:final','volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'},'environment':{'XDG_CONFIG_HOME':'/tmp/stock-view-config','XDG_CACHE_HOME':'/tmp/stock-view-cache'}}
target.write_text(json.dumps({'services':services},indent=2)+'\n')
PY
if [[ "${STOCKING_REPLIES_SKIP_DB:-0}" != 1 ]]; then
  "${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$artifact/db-start.log" 2>&1
  "${compose[@]}" run --rm --no-deps migrate > "$artifact/migrate.log" 2>&1
fi
"${compose[@]}" run --rm --no-deps test "$@"

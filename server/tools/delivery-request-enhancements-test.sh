#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="${DELIVERY_ENHANCEMENTS_ARTIFACT:-$repo_root/server/test-artifacts/delivery-enhancements-20261013/run}"
project="${DELIVERY_ENHANCEMENTS_PROJECT:-mbbs-delivery-enhancements-test}"
override="$artifact/compose.json"
compose=(docker compose --project-directory "$repo_root" -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
mkdir -p "$artifact/results/delivery-requests" "$artifact/results/delivery-requests-ui"
chmod -R a+rwX "$artifact/results"
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
  docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$artifact/production-health.log"
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || status=1
  printf 'teardown_exit=%s\n' "$status" >> "$artifact/teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$repo_root" "$artifact" "${DELIVERY_ENHANCEMENTS_SOURCE:-$repo_root/server}" <<'PY'
import json,sys
from pathlib import Path
repo,artifact,source=map(Path,sys.argv[1:]); server=repo/'server'
volumes=[f'{source/n}:/app/{n}:ro' for n in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/n}:/app/{n}:ro' for n in ['test','tools','contracts','eslint.mbt.config.js','eslint.driver-upload.config.mjs','tsconfig.mbt.json','.c8rc.json']]
volumes.append(f'{artifact/"results"}:/app/test-artifacts')
volumes.append(f'{server/"test-artifacts/delivery-enhancements-20261013/toolchain/node_modules"}:/app/node_modules:ro')
volumes.append(f'{server/"test-artifacts/delivery-enhancements-20261013/baseline"}:/baseline:ro')
services={'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}
for name in ['test','migrate']:
    services[name]={'image':'mbbs-to-yard-test-browser:20261009','working_dir':'/app','user':'1000:1000','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'},'volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'}}
(artifact/'compose.json').write_text(json.dumps({'services':services},indent=2)+'\n')
PY
python3 "$repo_root/docker/verify-memory-limits.py" > "$artifact/memory-limits.log" 2>&1
if [[ "${DELIVERY_ENHANCEMENTS_SKIP_DB:-0}" != 1 ]]; then
  "${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$artifact/db-start.log" 2>&1
  "${compose[@]}" run --rm --no-deps migrate > "$artifact/migrate.log" 2>&1
fi
"${compose[@]}" run --rm --no-deps test "$@"

#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
artifact="$repo_root/server/test-artifacts/return-pallet-accounting-20261020/saved-search"
project=mbbs-pallet-saved-search
mkdir -p "$artifact"
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$artifact/compose.json")
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
python3 - "$repo_root/server" "$artifact/compose.json" <<'PY'
import json,sys
from pathlib import Path
server=Path(sys.argv[1])
service={
 'image':'mbbs-operator-app:mbr-signing-defaults-browser-test-20261014',
 'pull_policy':'never','entrypoint':[],'working_dir':'/app','user':'1000:1000',
 'labels':{'com.mbbs.lifecycle':'disposable-test','com.mbbs.task':'pallet-saved-search'},
 'volumes':[f'{server/n}:/app/{n}:ro' for n in [
   'netsuite-pallet-balance-search-restlet.js',
   'test/mbt/unit/pallet-saved-search-restlet.test.js',
   'test/support/scan-diff-secrets.mjs'
 ]]
}
Path(sys.argv[2]).write_text(json.dumps({'services':{'test':service}},indent=2)+'\n')
PY
"${compose[@]}" run --rm --no-deps -T test node --check netsuite-pallet-balance-search-restlet.js > "$artifact/syntax.log" 2>&1
"${compose[@]}" run --rm --no-deps -T test node --test test/mbt/unit/pallet-saved-search-restlet.test.js > "$artifact/tests.log" 2>&1
"${compose[@]}" run --rm --no-deps -T test node test/support/scan-diff-secrets.mjs netsuite-pallet-balance-search-restlet.js test/mbt/unit/pallet-saved-search-restlet.test.js > "$artifact/secrets.log" 2>&1

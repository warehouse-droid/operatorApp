#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/scm-ultimate-packing-20261005"
source_root="${SCM_PACKING_SOURCE_ROOT:-$artifact/candidate}"
run_key="$(date +%s)-$$"
project="mbbs-scm-ultimate-$run_key"
override="$artifact/compose-$run_key.yml"
mkdir -p "$artifact"
compose=(sudo -n docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
cleanup() {
  result=$?
  trap - EXIT
  "${compose[@]}" down --volumes --remove-orphans > "$artifact/teardown-$run_key.log" 2>&1 || result=1
  sudo -n docker ps --format '{{.Names}}\t{{.Status}}' > "$artifact/docker-ps-$run_key.log"
  sudo -n docker ps -a --format '{{.Names}}\t{{.Status}}' > "$artifact/docker-ps-a-$run_key.log"
  if sudo -n docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | rg -q .; then result=1; fi
  if sudo -n docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | rg -q .; then result=1; fi
  if sudo -n docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' | rg -q .; then result=1; fi
  if [[ "$(sudo -n docker inspect --format '{{.State.Health.Status}}' mbbs-operator-app-app-1)" != healthy ]]; then result=1; fi
  if [[ "$(sudo -n docker inspect --format '{{.State.Health.Status}}' mbbs-operator-app-db-1)" != healthy ]]; then result=1; fi
  printf 'teardown_exit=%s project=%s\n' "$result" "$project" >> "$artifact/teardown-$run_key.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$source_root" "$repo_root" "$override" <<'PY'
import json
from pathlib import Path
import sys
source, root, target = map(Path, sys.argv[1:])
volumes = [f'{source / name}:/app/{name}:ro' for name in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{root / "server" / name}:/app/{name}:ro' for name in ['test','tools','contracts']]
volumes += [f'{root / "server" / "test-artifacts"}:/app/test-artifacts', f'{root}:/workspace:ro']
for name in ['eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']:
    volumes.append(f'{root / "server" / name}:/app/{name}:ro')
for harness in sorted((root / 'server/src').glob('smart-scm-*harness.js')):
    volumes.append(f'{harness}:/app/src/{harness.name}:ro')
services = {'db': {'labels': {'com.mbbs.lifecycle':'disposable-test'}}}
for name in ['test','migrate','app']:
    services[name] = {'image':'mbbs-regular-v2:test','volumes':volumes,
                      'labels':{'com.mbbs.lifecycle':'disposable-test'}}
target.write_text(json.dumps({'services': services}, indent=2)+'\n')
PY
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$artifact/db-start-$run_key.log" 2>&1
"${compose[@]}" run --rm --no-deps migrate > "$artifact/migrate-$run_key.log" 2>&1
"${compose[@]}" run --rm --no-deps test "$@"

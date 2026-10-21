#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="$repo_root/server/deployments/delivery-scm-20261006"
project="mbbs-delivery-scm-release"
override="$release/validation-compose.yml"
compose=(docker compose --project-directory "$repo_root" -p "$project"
  -f "$repo_root/docker-compose.mbt-test.yml" -f "$override")
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" --profile tools down --volumes --remove-orphans > "$release/validation-teardown.log" 2>&1 || status=1
  docker ps --format '{{.Names}} {{.Status}}' > "$release/validation-docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$release/validation-docker-ps-a.log"
  for kind in containers networks volumes; do
    case "$kind" in
      containers) remaining="$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ;;
      networks) remaining="$(docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.ID}}')" ;;
      volumes) remaining="$(docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}')" ;;
    esac
    if [[ -n "$remaining" ]]; then status=1; fi
  done
  docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 \
    > "$release/validation-production-health.log" || status=1
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || status=1
  printf 'teardown_exit=%s project=%s\n' "$status" "$project" >> "$release/validation-teardown.log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$release" "$override" <<'PY'
import json
from pathlib import Path
import sys
release, target = map(Path, sys.argv[1:])
source = release / 'validation'
manifest = json.loads((release / 'manifest.json').read_text())
(source / 'tools/delivery-scm-candidate.json').write_text(json.dumps(manifest))
volumes = [f'{source / n}:/app/{n}:ro' for n in
    ['src','public','migrations','test','tools','contracts','package.json','package-lock.json',
     'eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']]
volumes.append(f'{release / "validation-artifacts"}:/app/test-artifacts')
services = {'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}
for name in ['test','migrate']:
    services[name] = {'image':'mbbs-delivery-requests:final','volumes':volumes,
        'labels':{'com.mbbs.lifecycle':'disposable-test'}}
target.write_text(json.dumps({'services':services}, indent=2) + '\n')
PY
python3 "$repo_root/docker/verify-memory-limits.py" > "$release/validation-memory-limits.log"
"${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$release/validation-db-start.log" 2>&1
"${compose[@]}" run --rm --no-deps migrate > "$release/validation-migrate.log" 2>&1
"${compose[@]}" run --rm --no-deps test node tools/delivery-scm-validation.mjs > "$release/validation-run.log" 2>&1
python3 - "$release" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
release = Path(sys.argv[1])
data = json.loads((release / 'manifest.json').read_text())
for name in data['files']:
    assert hashlib.sha256((release / 'validation' / name).read_bytes()).hexdigest() == data['candidateTree'][name]
result = json.loads((release / 'validation-artifacts/combined-release/result.json').read_text())
assert result['passed'] and result['candidateTreeHash'] == data['candidateTreeHash']
(release / 'validation-passed.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'validationPassed':True,'candidateTreeHash':data['candidateTreeHash']}))
PY

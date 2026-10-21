#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
release="$PWD/server/deployments/unified-stock-status-20261020"
project="mbbs-unified-status-release-$$"
compose=(docker compose -p "$project" -f docker-compose.mbt-test.yml -f docker-compose.unified-stock-status-test.yml -f "$release/compose.validation.json")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans >"$release/validation-cleanup.log" 2>&1 || result=1
  docker ps --format '{{.Names}} {{.Status}}' >"$release/docker-running-validation.log"
  docker ps -a --format '{{.Names}} {{.Status}}' >"$release/docker-all-validation.log"
  if docker ps -aq --filter "label=com.docker.compose.project=$project" | read -r _; then result=1; fi
  docker volume ls -q --filter "label=com.docker.compose.project=$project" >"$release/volumes-validation.log"
  docker network ls -q --filter "label=com.docker.compose.project=$project" >"$release/networks-validation.log"
  if [[ -s "$release/volumes-validation.log" || -s "$release/networks-validation.log" ]]; then result=1; fi
  docker inspect mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-ollama-1 --format '{{.Name}} {{.State.Health.Status}}' >"$release/health-validation.log" || result=1
  if rg -v ' healthy$' "$release/health-validation.log"; then result=1; fi
  docker exec mbbs-operator-app-app-1 node -e 'fetch("http://127.0.0.1:3000/health").then(r=>{console.log(r.status);if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >"$release/http-health-validation.log" || result=1
  python3 - "$release" "$result" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]);p.joinpath('validation-cleanup.json').write_text(json.dumps({'passed':sys.argv[2]=='0','exitCode':int(sys.argv[2])})+'\n')
PY
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 docker/verify-memory-limits.py >"$release/resource-check-validation.log"
python3 - "$release" <<'PY'
import hashlib,json,sys,shutil
from pathlib import Path
p=Path(sys.argv[1]);server=Path('server').resolve()
out=p/'validation-artifacts';before=out/'unified-stock-status/before'
before.mkdir(parents=True,exist_ok=True)
old=server/'test-artifacts/unified-stock-status/before'
shutil.copytree(old,before,dirs_exist_ok=True)
for name in json.loads((server/'tools/unified-stock-status-files.json').read_text()):
 source=p/'before'/name
 if source.exists():
  target=before/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)
manifest=json.loads((before/'manifest.json').read_text())
(before/'manifest.json').write_text(json.dumps({name:hashlib.sha256((before/name).read_bytes()).hexdigest() for name in manifest},indent=2)+'\n')
volumes=[f'{p}/candidate/{name}:/app/{name}:ro' for name in ['src','public','migrations','package.json','package-lock.json']]
config={'services':{'test':{'volumes':volumes+[f'{out}:/app/test-artifacts']},'migrate':{'volumes':volumes}}}
(p/'compose.validation.json').write_text(json.dumps(config,indent=2)+'\n')
PY
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate node src/migrate.js >"$release/migrations-validation.log" 2>&1
set +e
"${compose[@]}" run --rm --no-deps -T test node tools/unified-stock-status-gauntlet.mjs full 2>&1 | tee "$release/validation-full.log"
validation_codes=("${PIPESTATUS[@]}")
set -e
python3 - "$release" "${validation_codes[@]}" <<'PY'
import json,sys
from pathlib import Path
Path(sys.argv[1],'validation-pipeline.json').write_text(json.dumps({'composeExitCode':int(sys.argv[2]),'logExitCode':int(sys.argv[3])})+'\n')
PY
if (( validation_codes[0] != 0 )); then exit "${validation_codes[0]}"; fi
exit "${validation_codes[1]}"

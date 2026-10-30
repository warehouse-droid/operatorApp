#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_root/docker/retention/retention.py" run -- bash "$0" "$@"
fi
phase="${1:-focused}"
artifact="$MBBS_TEST_ARTIFACT_DIR"
project="mbbs-notification-roles-sounds-$$"
evidence="${NOTIFICATION_EVIDENCE_DIR:-$repo_root/server/test-artifacts/app-notification-roles-sounds-20261021/$phase}"
compose=(docker compose --project-directory "$repo_root" -p "$project" -f "$repo_root/docker-compose.mbt-test.yml" -f "$artifact/compose.json")
mkdir -p "$artifact/results" "$evidence"
chmod 0777 "$artifact" "$artifact/results"
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans > "$artifact/teardown.log" 2>&1 || result=1
  docker ps --format '{{.Names}} {{.Status}}' > "$artifact/docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/docker-ps-a.log"
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]]; then result=1; fi
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || result=1
  printf 'teardown_exit=%s\n' "$result" >> "$artifact/teardown.log"
  # Retain the logs/evidence requested for this task; the retention wrapper removes temporary output.
  cp "$artifact/teardown.log" "$artifact/docker-ps.log" "$artifact/docker-ps-a.log" "$evidence/"
  for name in lint.log tests.log test-results.json preferences-roles-sounds-mobile.png; do
    if [[ -f "$artifact/results/$name" ]]; then cp "$artifact/results/$name" "$evidence/"; fi
  done
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$repo_root" "$artifact" "${NOTIFICATION_SOURCE:-$repo_root/server}" "$phase" <<'PY'
import hashlib,json,shutil,subprocess,sys
from pathlib import Path
repo,artifact,source=map(Path,sys.argv[1:4]);server=repo/'server'
volumes=[f'{source/n}:/app/{n}:ro' for n in ['src','public','migrations','package.json','package-lock.json']]
volumes += [f'{server/n}:/app/{n}:ro' for n in ['test','tools','contracts','eslint.mbt.config.js']]
toolchain=server/'test-artifacts/operator-to-yard-flow-tooling/node_modules'
assert (toolchain/'@playwright/test/package.json').is_file() and (toolchain/'.bin/eslint').is_file(), 'Browser test toolchain is unavailable'
shutil.copytree(toolchain,artifact/'node_modules',symlinks=True)
volumes += [f'{artifact}/node_modules:/app/node_modules:ro',f'{artifact}/results:/app/test-artifacts']
if sys.argv[4]=='baseline':
 originals=json.loads((server/'test-artifacts/app-notification-roles-sounds-20261021/before-hashes.json').read_text())
 for name,sha in originals.items():
  data=subprocess.check_output(['git','-c',f'safe.directory={repo}','show','HEAD:server/'+name],cwd=repo)
  assert hashlib.sha256(data).hexdigest()==sha,'Original file changed: '+name
  path=artifact/'original'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
  volumes.append(f'{path}:/app/{name}:ro')
services={'db':{'labels':{'com.mbbs.lifecycle':'disposable-test'}}}
for name in ['test','migrate']:
 services[name]={'image':'mbbs-operator-app:dispatch-editor-control-browser-test-20261015','pull_policy':'never','working_dir':'/app','user':'1000:1000',
  'environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'},'volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'}}
(artifact/'compose.json').write_text(json.dumps({'services':services},indent=2)+'\n')
PY
python3 "$repo_root/docker/verify-memory-limits.py" > "$evidence/memory-limits.log" 2>&1
if [[ "$phase" == regression ]]; then
  "${compose[@]}" up -d --no-build --wait --wait-timeout 60 db > "$evidence/db-start.log" 2>&1
  "${compose[@]}" run --rm --no-deps --pull never -T migrate > "$evidence/migrate.log" 2>&1
fi
"${compose[@]}" run --rm --no-deps --pull never -T test node tools/app-notification-roles-sounds-checks.mjs "$phase"

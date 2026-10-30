#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
project="mbbs-yard-perf-$$"
overlay="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$overlay")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  remaining=$(docker ps -aq --filter "label=com.docker.compose.project=$project")
  if [[ -n "$remaining" ]]; then docker rm -f -v $remaining >/dev/null || result=1; fi
  if [[ -f "$overlay" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  for resource in container volume network; do
    if [[ -n "$(docker "$resource" ls -q --filter "label=com.docker.compose.project=$project")" ]]; then result=1; fi
  done
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
mkdir -p "$MBBS_TEST_ARTIFACT_DIR/toolchain"
cp server/package.json server/package-lock.json "$MBBS_TEST_ARTIFACT_DIR/toolchain/"
docker run --rm --init --cgroup-parent=mbbs-tests.slice --cpus=2 --memory=2g --memory-swap=2g --pids-limit=512 \
  --label com.mbbs.lifecycle=disposable-test --label "com.docker.compose.project=$project" \
  --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:size=512m \
  -v "$MBBS_TEST_ARTIFACT_DIR/toolchain:/toolchain" -w /toolchain \
  "${YARD_PERF_TEST_IMAGE:-mbbs-operator-app:dispatch-editor-control-browser-test-20261015}" \
  sh -c 'npm ci --ignore-scripts --cache=/tmp/npm-cache --no-audit --no-fund && PLAYWRIGHT_BROWSERS_PATH=/toolchain/browsers npx --no-install playwright install chromium'
python3 - "$overlay" "$repo_dir" <<'PY'
import difflib, json, os, re, sys
from pathlib import Path
root = Path(sys.argv[2])
volumes = [{'type':'bind','source':os.environ['MBBS_TEST_ARTIFACT_DIR'],'target':'/app/test-artifacts'}]
baseline = root/'server/deployments/yard-movement-performance-20261022/workspace-before'
volumes.append({'type':'bind','source':str(baseline),'target':'/baseline','read_only':True})
for name, target in [('node_modules','/app/node_modules'),('browsers','/ms-playwright')]:
    volumes.append({'type':'bind','source':str(Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'toolchain'/name),'target':target,'read_only':True})
for name in ('src','public','migrations','test','tools','contracts','package.json','package-lock.json','tsconfig.mbt.json','eslint.mbt.config.js','.env.example'):
    if os.environ.get('YARD_PERF_RUNTIME_IMAGE') and name in ('src','public','migrations','contracts','package.json','package-lock.json'):
        continue
    volumes.append({'type':'bind','source':str(root/'server'/name),'target':'/app/'+name,'read_only':True})
if os.environ.get('YARD_PERF_RELEASE_DIR'):
    volumes.append({'type':'bind','source':os.environ['YARD_PERF_RELEASE_DIR'],'target':'/release'})
runtime_image = os.environ.get('YARD_PERF_RUNTIME_IMAGE') or os.environ.get('YARD_PERF_TEST_IMAGE','mbbs-operator-app:dispatch-editor-control-browser-test-20261015')
services = {name:{'image':runtime_image,'working_dir':'/app','user':f'{os.getuid()}:{os.getgid()}','environment':{'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright'},'volumes':volumes,'labels':{'com.mbbs.lifecycle':'disposable-test'}} for name in ('test','migrate')}
services['db'] = {'labels':{'com.mbbs.lifecycle':'disposable-test'}}
Path(sys.argv[1]).write_text(json.dumps({'services':services}))
changed = {}
for name in ('src/yard-movement-repository.js','public/control.js','public/dispatch-loaded-export.js','public/yard-movement-requests.js'):
    prior = baseline/name
    if prior.exists():
        diff = ''.join(difflib.unified_diff(prior.read_text().splitlines(True),(root/'server'/name).read_text().splitlines(True),n=0))
        lines = []
        for start, count in re.findall(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@',diff,re.M):
            lines.extend(range(int(start),int(start)+int(count or 1)))
    else:
        lines = list(range(1,len((root/'server'/name).read_text().splitlines())+1))
    changed[name] = lines
(Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])/'changed-lines.json').write_text(json.dumps(changed))
PY
"${compose[@]}" up -d --wait db
if ! "${compose[@]}" run --rm --no-deps -T migrate > "$MBBS_TEST_ARTIFACT_DIR/migrations.log" 2>&1; then
  tail -50 "$MBBS_TEST_ARTIFACT_DIR/migrations.log"; exit 1
fi
if (( $# == 0 )); then set -- node tools/yard-movement-performance-checks.mjs; fi
"${compose[@]}" run --rm --no-deps -T test "$@"

#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run --root /tmp/mbt-aggregate-runs -- bash "$0" "$@"
fi
test_project="mbbs-aggregate-$$"
test_override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$test_override")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$test_override" ]]; then
    "${compose[@]}" down --volumes --remove-orphans || result=1
  fi
  if docker image inspect "$test_project:checks" >/dev/null 2>&1; then
    docker image rm "$test_project:checks" >/dev/null || result=1
  fi
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]]; then
    result=1
  fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
python3 - "$test_override" "$test_project" <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path
services = {}
for name in ('test', 'migrate'):
    services[name] = {'image': sys.argv[2] + ':checks', 'build': {'target': 'test-e2e'},
        'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'},
        'volumes': [{'type': 'bind', 'source': os.environ['MBBS_TEST_ARTIFACT_DIR'], 'target': '/app/test-artifacts'}],
        'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
with open(sys.argv[1], 'w') as output:
    json.dump({'services': services}, output)
files = ['src/mbt/aggregate-density.js', 'src/mbt/customer-charge-calculator.js',
    'src/mbt/customer-charge-request-service.js', 'src/mbt/local-master-data-service.js',
    'src/mbt/local-item-settings-repository.js']
changes = {}
for file in files:
    path = 'server/' + file
    tracked = subprocess.run(['git', 'ls-files', '--error-unmatch', path], capture_output=True).returncode == 0
    if not tracked:
        changes[file] = [i for i, line in enumerate(Path(path).read_text().splitlines(), 1) if line.strip() and not line.strip().startswith('//')]
        continue
    diff = subprocess.check_output(['git', 'diff', '--no-ext-diff', '--unified=0', '--', path], text=True)
    added = []
    position = 0
    for line in diff.splitlines():
        hunk = re.match(r'@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@', line)
        if hunk:
            position = int(hunk.group(1))
        elif position and line.startswith('+'):
            if line[1:].strip():
                added.append(position)
            position += 1
        elif position and not line.startswith(('-', '\\')):
            position += 1
    changes[file] = added
Path(os.environ['MBBS_TEST_ARTIFACT_DIR'], 'changed-lines.json').write_text(json.dumps(changes))
PY
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
"${compose[@]}" build test
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate
"${compose[@]}" run --rm --no-deps -T test node tools/mbt-aggregate-checks.mjs

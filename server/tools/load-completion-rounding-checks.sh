#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
test_project="mbbs-load-rounding-$$"
test_image="mbbs-load-rounding-test:$$"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$override")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$override" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  docker image rm "$test_image" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]]; then result=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
mkdir "$MBBS_TEST_ARTIFACT_DIR/build"
cp server/package.json server/package-lock.json server/Dockerfile.test "$MBBS_TEST_ARTIFACT_DIR/build/"
docker build --target test-dependencies -f "$MBBS_TEST_ARTIFACT_DIR/build/Dockerfile.test" -t "$test_image" "$MBBS_TEST_ARTIFACT_DIR/build"
python3 - "$repo_dir" "$override" "$test_image" <<'PY'
import json, os, sys
repo, target, image = sys.argv[1:]
source = os.environ.get('LOAD_COMPLETION_SOURCE_ROOT', repo + '/server')
artifacts = os.environ['MBBS_TEST_ARTIFACT_DIR']
mounts = [{'type': 'bind', 'source': artifacts, 'target': '/app/test-artifacts'}]
for folder in ('src', 'public', 'migrations'):
    mounts.append({'type': 'bind', 'source': source + '/' + folder, 'target': '/app/' + folder, 'read_only': True})
for path in ('test', 'tools', 'netsuite-ifir-posting-restlet.js', 'eslint.mbt.config.js', '.c8rc.json', '.env.example'):
    mounts.append({'type': 'bind', 'source': repo + '/server/' + path, 'target': '/app/' + path, 'read_only': True})
services = {name: {'image': image, 'pull_policy': 'never', 'user': 'node', 'volumes': mounts,
                  'labels': {'com.mbbs.lifecycle': 'disposable-test'}} for name in ('test', 'migrate')}
services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
with open(target, 'w') as output:
    json.dump({'services': services}, output)
PY
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
if [[ -n "${LOAD_COMPLETION_BASELINE_SOURCE:-}" ]]; then
  cp "$LOAD_COMPLETION_BASELINE_SOURCE" "$MBBS_TEST_ARTIFACT_DIR/baseline-delivery-repository.js"
else
  git show HEAD:server/src/delivery-repository.js >"$MBBS_TEST_ARTIFACT_DIR/baseline-delivery-repository.js"
fi
chmod 0644 "$MBBS_TEST_ARTIFACT_DIR/baseline-delivery-repository.js"
"${compose[@]}" up -d --wait db
if ! "${compose[@]}" run --rm --no-deps -T migrate >"$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1; then
  tail -n 60 "$MBBS_TEST_ARTIFACT_DIR/migrate.log"
  exit 1
fi
if (( $# == 0 )); then set -- node tools/load-completion-rounding-gauntlet.mjs; fi
"${compose[@]}" run --rm --no-deps -T test "$@"
if [[ -n "${LOAD_COMPLETION_EVIDENCE_PATH:-}" ]]; then
  install -m 0600 "$MBBS_TEST_ARTIFACT_DIR/load-completion-rounding/evidence.json" "$LOAD_COMPLETION_EVIDENCE_PATH"
fi

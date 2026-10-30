#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
project="mbbs-backorder-review-$$"
test_image="mbbs-backorder-review-test:$$"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$project" -f "$repo_dir/docker-compose.mbt-test.yml" -f "$override")
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$override" ]]; then "${compose[@]}" down --volumes --remove-orphans || result=1; fi
  docker image rm "$test_image" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]]; then result=1; fi
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
if ! docker build --target playwright-dependencies -f "$MBBS_TEST_ARTIFACT_DIR/build/Dockerfile.test" -t "$test_image" "$MBBS_TEST_ARTIFACT_DIR/build" >"$MBBS_TEST_ARTIFACT_DIR/build.log" 2>&1; then
  tail -n 50 "$MBBS_TEST_ARTIFACT_DIR/build.log"; exit 1
fi
python3 - "$repo_dir" "$override" "$test_image" <<'PY'
import json, os, sys
repo, target, image = sys.argv[1:]
runtime = os.environ.get('BACKORDER_REVIEW_RUNTIME', repo + '/server')
mounts = [{'type': 'bind', 'source': os.environ['MBBS_TEST_ARTIFACT_DIR'], 'target': '/app/test-artifacts'}]
mounts.append({'type': 'bind', 'source': repo + '/server/deployments/backorder-review-flow-20261022/before',
    'target': '/app/review-before', 'read_only': True})
for name in ('src', 'public', 'migrations', 'package.json', 'package-lock.json'):
    mounts.append({'type': 'bind', 'source': runtime + '/' + name, 'target': '/app/' + name, 'read_only': True})
for name in ('test', 'tools', 'contracts', 'eslint.mbt.config.js', '.env.example', 'netsuite-ifir-posting-restlet.js'):
    mounts.append({'type': 'bind', 'source': repo + '/server/' + name, 'target': '/app/' + name, 'read_only': True})
services = {name: {'image': image, 'pull_policy': 'never', 'user': 'node', 'volumes': mounts,
    'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'},
    'labels': {'com.mbbs.lifecycle': 'disposable-test'}} for name in ('test', 'migrate')}
services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
with open(target, 'w') as output: json.dump({'services': services}, output)
PY
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
"${compose[@]}" up -d --wait db
if ! "${compose[@]}" run --rm --no-deps -T migrate >"$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1; then
  tail -n 50 "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1
fi
if (( $# == 0 )); then set -- node --test --test-concurrency=1 test/mbt/unit/backorder-review-flow.test.js test/mbt/integration/backorder-review-flow.test.js test/mbt/integration/backorder-review-flow-browser.test.js; fi
result=0
"${compose[@]}" run --rm --no-deps -T test "$@" || result=$?
if [[ -n "${BACKORDER_REVIEW_REPORT:-}" && -f "$MBBS_TEST_ARTIFACT_DIR/backorder-review-report.json" ]]; then
  cp "$MBBS_TEST_ARTIFACT_DIR/backorder-review-report.json" "$repo_dir/server/test/backorder-review-flow-$BACKORDER_REVIEW_REPORT.json"
fi
exit "$result"

#!/usr/bin/env bash
# Same isolated Compose run as run-isolated-tests.sh, but the test code comes from a git ref
# (exported into this run's private artifact directory) so a baseline can be compared.
# Usage: bash docker/run-isolated-tests-at-ref.sh <git-ref> [test command]
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
source_ref="${1:?git ref required}"
shift
test_project="mbbs-disposable-$$"
test_override=""
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml")
finish_isolated_tests() {
  result=$?
  trap - EXIT INT TERM
  if [[ -n "$test_override" ]]; then
    "${compose[@]}" down --volumes --remove-orphans || result=1
    rm -f -- "$test_override"
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
trap finish_isolated_tests EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
python3 docker/verify-memory-limits.py
test_override="$(mktemp /tmp/mbbs-disposable-compose.XXXXXX.json)"
python3 - "$test_override" <<'PY'
import json, os, sys
artifact = os.environ['MBBS_TEST_ARTIFACT_DIR']
services = {}
for name in ('test', 'migrate'):
    services[name] = {'volumes': [{'type': 'bind', 'source': artifact, 'target': '/app/test-artifacts'}],
                      'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
with open(sys.argv[1], 'w') as output:
    json.dump({'services': services}, output)
PY
# Container test users need write access to this newly allocated, private run directory.
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
compose+=(-f "$test_override")
"${compose[@]}" build test migrate
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps -T migrate
mkdir -p "$MBBS_TEST_ARTIFACT_DIR/ref"
git archive "$source_ref" server | tar -x -C "$MBBS_TEST_ARTIFACT_DIR/ref"
chmod -R a+rX "$MBBS_TEST_ARTIFACT_DIR/ref"
mounts=()
for directory in src public test tools contracts migrations; do
  mounts+=(-v "$MBBS_TEST_ARTIFACT_DIR/ref/server/$directory:/app/$directory:ro")
done
if (( $# == 0 )); then set -- npm test; fi
"${compose[@]}" run --rm --no-deps -T "${mounts[@]}" test "$@"

#!/usr/bin/env bash
# Reuse the standard bounded test image with current source mounted read-only.
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run --root /tmp/mbbs-regroup-runs -- bash "$0" "$@"
fi
test_project="mbbs-regroup-$$"
compose=(docker compose -p "$test_project" -f "$repo_dir/docker-compose.mbt-test.yml")
finish_regroup_tests() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || result=1
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ||
        -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ||
        -n "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]]; then result=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap finish_regroup_tests EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_dir"
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
python3 - "$repo_dir" "$MBBS_TEST_ARTIFACT_DIR/compose.json" <<'PY'
import json, os, sys
from pathlib import Path
root = Path(sys.argv[1])
artifact = os.environ['MBBS_TEST_ARTIFACT_DIR']
volumes = [{'type': 'bind', 'source': artifact, 'target': '/app/test-artifacts'}]
volumes += [{'type': 'bind', 'source': str(root / 'server' / name),
             'target': '/app/' + name, 'read_only': True}
            for name in ['src', 'public', 'test', 'migrations']]
services = {name: {'volumes': volumes, 'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
            for name in ['test', 'migrate']}
services['db'] = {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}
Path(sys.argv[2]).write_text(json.dumps({'services': services}))
PY
compose+=(-f "$MBBS_TEST_ARTIFACT_DIR/compose.json")
"${compose[@]}" up -d --wait db
if ! "${compose[@]}" run --rm --no-deps -T migrate >"$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1; then
  cat "$MBBS_TEST_ARTIFACT_DIR/migrate.log"
  exit 1
fi
if (( $# == 0 )); then set -- node test/support/run-dispatch-regroup-checks.mjs; fi
"${compose[@]}" run --rm --no-deps -T test "$@"

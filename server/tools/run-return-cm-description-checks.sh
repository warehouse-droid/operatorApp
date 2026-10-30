#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
candidate_dir="$repo_dir/server/deployments/return-cm-description-20261028/candidate"
test_project="mbbs-return-cm-defaults-$$"
compose=(docker compose -p "$test_project" -f docker-compose.mbt-test.yml --profile '*')
finish() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || result=1
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
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
python3 docker/verify-memory-limits.py
mounts=(-v "$candidate_dir/src:/app/src:ro" -v "$candidate_dir/public:/app/public:ro"
  -v "$candidate_dir/migrations:/app/migrations:ro" -v "$repo_dir/server/test:/app/test:ro"
  -v "$repo_dir/server/tools:/app/tools:ro")
log="$MBBS_TEST_ARTIFACT_DIR/complete-run.log"
"${compose[@]}" up -d --wait db >>"$log" 2>&1
"${compose[@]}" run --rm --no-deps -T --label com.mbbs.lifecycle=disposable-test "${mounts[@]}" e2e node src/migrate.js >>"$log" 2>&1
set +e
"${compose[@]}" run --rm --no-deps -T --label com.mbbs.lifecycle=disposable-test "${mounts[@]}" e2e node tools/return-cm-description-checks.mjs "$@" >>"$log" 2>&1
result=$?
set -e
tail -160 "$log"
if (( result == 0 )); then
  python3 - "$MBBS_TEST_ARTIFACT_DIR/return-cm-description-validation.json" "$candidate_dir/.." <<'PY'
import json, pathlib, sys
report=json.loads(pathlib.Path(sys.argv[1]).read_text())
release=pathlib.Path(sys.argv[2])
prepared=json.loads((release/'prepared.json').read_text())
assert report['passed'] and report['sourceHashes']==prepared['sourceHashes'], 'Candidate differs from tested source'
(release/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
print('Exact candidate validated; concise release evidence saved.')
PY
fi
exit "$result"

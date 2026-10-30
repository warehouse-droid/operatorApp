#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
test_project="mbbs-tob-browser-$$"
override="$MBBS_TEST_ARTIFACT_DIR/compose.json"
compose=(docker compose -p "$test_project" -f docker-compose.mbt-test.yml -f "$override" --profile e2e --profile runtime)
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -f "$override" ]]; then
    "${compose[@]}" down --volumes --remove-orphans > "$MBBS_TEST_ARTIFACT_DIR/cleanup.log" 2>&1 || result=1
  fi
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  [[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  [[ -z "$(docker network ls -q --filter "label=com.docker.compose.project=$test_project")" ]] || result=1
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 docker/verify-memory-limits.py
docker inspect mbbs-operator-app-app-1 --format '{{.Image}}' > "$MBBS_TEST_ARTIFACT_DIR/live-image.txt"
cp server/public/dispatch.js "$MBBS_TEST_ARTIFACT_DIR/dispatch.js"
for dependency in dispatch-edit-activity.js dispatch-address-guard.js dispatch-auth.js; do
  docker cp "mbbs-operator-app-app-1:/app/public/$dependency" "$MBBS_TEST_ARTIFACT_DIR/$dependency"
done
python3 - <<'PY'
import json, os
from pathlib import Path
artifact = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
mounts = [
    {'type':'bind','source':str(artifact),'target':'/app/test-artifacts'},
    {'type':'bind','source':str(Path('server/tools/dispatch-tob-search-browser-checks.mjs').resolve()),
     'target':'/app/tools/dispatch-tob-search-browser-checks.mjs','read_only':True}
]
(artifact/'compose.json').write_text(json.dumps({'services':{'e2e':{
    'labels':{'com.mbbs.lifecycle':'disposable-test'},'volumes':mounts}}}))
for path in artifact.rglob('*'):
    path.chmod(0o777 if path.is_dir() else 0o666)
artifact.chmod(0o777)
PY
"${compose[@]}" run --rm --no-deps -T e2e node tools/dispatch-tob-search-browser-checks.mjs
cp "$MBBS_TEST_ARTIFACT_DIR/browser-checks.json" server/test/dispatch-tob-search-browser-20261028.json

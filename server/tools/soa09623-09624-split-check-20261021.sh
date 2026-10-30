#!/usr/bin/env bash
set -Eeuo pipefail
repo=/home/ubuntu/apps/operatorApp
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo/docker/retention/retention.py" run -- bash "$0"
fi
project="mbbs-disposable-soa9623-$$"
compose=(docker compose -p "$project" -f "$repo/docker-compose.mbt-test.yml" -f "$MBBS_TEST_ARTIFACT_DIR/compose.json")
cleanup() {
  code=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || code=1
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" || -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" || -n "$(docker network ls -q --filter "label=com.docker.compose.project=$project")" ]]; then code=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || code=1
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo"
python3 docker/verify-memory-limits.py
cp /home/ubuntu/mbbs-backups/data-repairs/soa09623-09624-split-20261021/{before,preview}.json "$MBBS_TEST_ARTIFACT_DIR/"
cp server/tools/soa09623-09624-split-{correction,fixture}-20261021.mjs "$MBBS_TEST_ARTIFACT_DIR/"
repair_image=$(docker inspect mbbs-operator-app-app-1 --format '{{.Image}}')
python3 - "$repair_image" <<'PY'
import json,os,sys
p=os.environ['MBBS_TEST_ARTIFACT_DIR']
services={name:{'image':sys.argv[1],'volumes':[{'type':'bind','source':p,'target':'/app/test-artifacts'}], 'labels':{'com.mbbs.lifecycle':'disposable-test'}} for name in ['test','migrate']}
services['db']={'labels':{'com.mbbs.lifecycle':'disposable-test'}}
json.dump({'services':services},open(p+'/compose.json','w'))
PY
chmod -R a+rX "$MBBS_TEST_ARTIFACT_DIR"
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
"${compose[@]}" up -d --wait db > "$MBBS_TEST_ARTIFACT_DIR/db.log" 2>&1
"${compose[@]}" run --rm --no-deps -T migrate > "$MBBS_TEST_ARTIFACT_DIR/migrate.log" 2>&1 || { tail -30 "$MBBS_TEST_ARTIFACT_DIR/migrate.log"; exit 1; }
"${compose[@]}" run --rm --no-deps -T test node /app/test-artifacts/soa09623-09624-split-fixture-20261021.mjs
"${compose[@]}" run --rm --no-deps -T test node /app/test-artifacts/soa09623-09624-split-correction-20261021.mjs > "$MBBS_TEST_ARTIFACT_DIR/test-preview.json"
expected=$(python3 - "$MBBS_TEST_ARTIFACT_DIR/test-preview.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['beforeFingerprint'])
PY
)
"${compose[@]}" run --rm --no-deps -T -e "MBBS_REPAIR_EXPECTED=$expected" test node /app/test-artifacts/soa09623-09624-split-correction-20261021.mjs --apply
"${compose[@]}" run --rm --no-deps -T test node /app/test-artifacts/soa09623-09624-split-correction-20261021.mjs --apply

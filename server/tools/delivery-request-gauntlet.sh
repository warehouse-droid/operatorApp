#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$server_root/.." && pwd)"
export DELIVERY_TEST_PHASE="${1:-final}"
case "$DELIVERY_TEST_PHASE" in baseline|red|focused|static|final) ;; *) exit 64 ;; esac
export DELIVERY_TEST_STAGE
DELIVERY_TEST_STAGE="$(mktemp -d /tmp/mbbs-delivery-request-stage.XXXXXX)"
artifacts="$server_root/test-artifacts/delivery-requests"
mkdir -p "$artifacts"
compose=(docker compose -p mbbs-delivery-requests-test -f "$repo_root/docker-compose.mbt-test.yml" -f "$server_root/tools/delivery-request-test-compose.yml")
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "${compose[@]}" --profile tools --profile runtime --profile e2e down --volumes --remove-orphans > "$artifacts/teardown-$DELIVERY_TEST_PHASE.log" 2>&1 || status=1
  docker ps --format '{{.Names}} {{.Status}}' > "$artifacts/docker-ps-$DELIVERY_TEST_PHASE.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifacts/docker-ps-a-$DELIVERY_TEST_PHASE.log"
  if docker ps -a --filter label=com.docker.compose.project=mbbs-delivery-requests-test --format '{{.Names}}' | rg -q .; then status=1; fi
  docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$artifacts/production-health-$DELIVERY_TEST_PHASE.log"
  docker exec mbbs-operator-app-app-1 node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || status=1
  rm -rf -- "$DELIVERY_TEST_STAGE"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$repo_root"
python3 docker/verify-memory-limits.py > "$artifacts/memory-limits-$DELIVERY_TEST_PHASE.log"
python3 - "$server_root" "$DELIVERY_TEST_STAGE" "$artifacts/source-$DELIVERY_TEST_PHASE.json" <<'PY'
import hashlib,json,shutil,sys
from pathlib import Path
source,stage,report=map(Path,sys.argv[1:])
names=['src','public','migrations','test','tools','contracts']
for name in names: shutil.copytree(source/name,stage/name)
for path in source.iterdir():
    if path.is_file() and (path.suffix in ['.js','.json'] or path.name in ['Dockerfile','Dockerfile.test','Dockerfile.scm-ir-split-reference','.env.example','.c8rc.json','.dockerignore']):
        shutil.copy2(path,stage/path.name)
hashes={str(p.relative_to(stage)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(stage.rglob('*')) if p.is_file()}
report.write_text(json.dumps({'files':hashes,'treeHash':hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()},indent=2)+'\n')
PY
"${compose[@]}" --profile tools build test > "$artifacts/build-$DELIVERY_TEST_PHASE.log" 2>&1
"${compose[@]}" up -d --wait db > "$artifacts/start-$DELIVERY_TEST_PHASE.log" 2>&1
"${compose[@]}" --profile tools run --rm migrate > "$artifacts/migrate-$DELIVERY_TEST_PHASE.log" 2>&1
if [[ "$DELIVERY_TEST_PHASE" == baseline ]]; then
  set +e
  "${compose[@]}" --profile tools run --rm test node tools/delivery-request-regression-runner.mjs > "$artifacts/baseline-regression.log" 2>&1
  echo "$?" > "$artifacts/baseline-regression.exit"
  "${compose[@]}" --profile tools run --rm test npm run typecheck:mbt > "$artifacts/baseline-types.log" 2>&1
  echo "$?" > "$artifacts/baseline-types.exit"
  "${compose[@]}" --profile tools run --rm test npm run lint:mbt > "$artifacts/baseline-lint.log" 2>&1
  echo "$?" > "$artifacts/baseline-lint.exit"
  exit 0
fi
if [[ "$DELIVERY_TEST_PHASE" == red ]]; then
  "${compose[@]}" --profile tools run --rm test node --test test/mbt/unit/delivery-request-domain.test.js > "$artifacts/red.log" 2>&1
  exit "$?"
fi
if [[ "$DELIVERY_TEST_PHASE" == static ]]; then
  "${compose[@]}" --profile tools run --rm test node tools/delivery-request-static.mjs > "$artifacts/static.log" 2>&1
  exit "$?"
fi
"${compose[@]}" --profile tools run --rm test node tools/delivery-request-checks.mjs > "$artifacts/focused-$DELIVERY_TEST_PHASE.log" 2>&1
if [[ "$DELIVERY_TEST_PHASE" == final ]]; then
  "${compose[@]}" --profile tools run --rm test node tools/delivery-request-quality.mjs types > "$artifacts/feature-types.log" 2>&1
  "${compose[@]}" --profile tools run --rm test node tools/delivery-request-static.mjs > "$artifacts/feature-lint.log" 2>&1
  "${compose[@]}" --profile tools run --rm test node tools/delivery-request-quality.mjs versions > "$artifacts/tool-versions.log" 2>&1
  "${compose[@]}" --profile tools run --rm mutation node tools/delivery-request-mutations.mjs > "$artifacts/mutations.log" 2>&1
  set +e
  "${compose[@]}" --profile tools run --rm test node tools/delivery-request-regression-runner.mjs > "$artifacts/final-regression.log" 2>&1
  echo "$?" > "$artifacts/final-regression.exit"
  "${compose[@]}" --profile tools run --rm test npm run typecheck:mbt > "$artifacts/final-types.log" 2>&1
  echo "$?" > "$artifacts/final-types.exit"
  "${compose[@]}" --profile tools run --rm test npm run lint:mbt > "$artifacts/final-lint.log" 2>&1
  echo "$?" > "$artifacts/final-lint.exit"
  set -e
  python3 "$server_root/tools/delivery-request-regression.py" "$artifacts"
fi

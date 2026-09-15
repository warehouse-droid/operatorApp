#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
artifact="$repo_root/server/test-artifacts/activity-allocation-scope"
mkdir -p "$artifact/final" "$artifact/baseline"
# Reconstruct the original comparison without relying on an ignored snapshot.
cp server/src/dispatch-load-assignment.js "$artifact/baseline/dispatch-load-assignment.js"
patch --silent "$artifact/baseline/dispatch-load-assignment.js" < server/test/support/dispatch-activity-allocation-scope-baseline.patch
network=mbbs-activity-allocation-scope
database=mbbs-activity-allocation-scope-db
image=mbbs-retired-confirm-test:20260914
docker network inspect "$network" >/dev/null 2>&1 || docker network create --internal "$network" >/dev/null
if ! docker inspect "$database" >/dev/null 2>&1; then
  docker run -d --name "$database" --network "$network" --network-alias db \
    --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
    -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
fi
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
common=(--rm --network "$network" --user "$(id -u):$(id -g)"
  -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent
  -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app
  -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test
  -v "$repo_root:/workspace:ro"
  -v "$repo_root/server/src:/app/src:ro" -v "$repo_root/server/public:/app/public:ro"
  -v "$repo_root/server/test:/app/test:ro" -v "$repo_root/server/tools:/app/tools:ro"
  -v "$repo_root/server/package.json:/app/package.json:ro"
  -v "$artifact:/app/test-artifacts/activity-allocation-scope")
run() { docker run "${common[@]}" --entrypoint "$1" "$image" "${@:2}"; }
baseline() { docker run "${common[@]}" -v "$artifact/baseline/dispatch-load-assignment.js:/app/src/dispatch-load-assignment.js:ro" --entrypoint "$1" "$image" "${@:2}"; }
reset_db() {
  docker exec "$database" psql -U mbt_test -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE mbt_test WITH (FORCE)' -c 'CREATE DATABASE mbt_test' >"$artifact/final/reset.log"
  run npm run migrate >"$artifact/final/migrate.log" 2>&1
}
if [[ "${1:-}" == integration ]]; then
  reset_db
  baseline node --test test/dispatch/integration/dispatch-activity-allocation-scope.test.js >"$artifact/integration-red.log" 2>&1 || true
  run node --test test/dispatch/integration/dispatch-activity-allocation-scope.test.js
  exit
fi
run node -p 'JSON.stringify({node:process.version,fastCheck:require("fast-check/package.json").version,eslint:require("eslint/package.json").version,typescript:require("typescript/package.json").version,c8:require("c8/package.json").version})' >"$artifact/final/versions.json"
sha256sum server/src/dispatch-load-assignment.js server/test/dispatch/unit/dispatch-activity-allocation-scope.test.js \
  server/test/dispatch/integration/dispatch-activity-allocation-scope.test.js >"$artifact/final/source.sha256"
reset_db
run node node_modules/c8/bin/c8.js --all=false --check-coverage=false --include=src/dispatch-load-assignment.js \
  --temp-directory=/tmp/activity-allocation-c8 --report-dir=test-artifacts/activity-allocation-scope/final/coverage \
  --reporter=json --reporter=json-summary --reporter=text node --test --test-concurrency=1 \
  test/dispatch/unit/dispatch-activity-allocation-scope.test.js \
  test/dispatch/integration/dispatch-activity-allocation-scope.test.js \
  src/dispatch-load-assignment-harness.js \
  test/dispatch/adversarial/dispatch-performance-safety.test.js >"$artifact/final/focused.log" 2>&1
run npm run test:driver-live-route-prefix-lock >"$artifact/final/route-prefix.log" 2>&1
baseline bash tools/dispatch-activity-allocation-scope-policy-tests.sh >"$artifact/final/dispatch-policy-baseline.log" 2>&1 || true
run bash tools/dispatch-activity-allocation-scope-policy-tests.sh >"$artifact/final/dispatch-policy.log" 2>&1 || true
run node tools/mutate-dispatch-activity-allocation-scope.mjs >"$artifact/final/mutation.log" 2>&1
# Node sorts file arguments. Separate processes guarantee the opposite order
# to the focused run (which executes integration before unit tests).
run node --test test/dispatch/unit/dispatch-activity-allocation-scope.test.js >"$artifact/final/reordered.log" 2>&1
run node --test test/dispatch/integration/dispatch-activity-allocation-scope.test.js >>"$artifact/final/reordered.log" 2>&1
baseline npm run typecheck:mbt >"$artifact/final/types-baseline.log" 2>&1 || true
run npm run typecheck:mbt >"$artifact/final/types.log" 2>&1 || true
baseline node node_modules/eslint/bin/eslint.js --config eslint.mbt.config.js --max-warnings=0 \
  src/dispatch-load-assignment.js >"$artifact/final/lint-baseline.log" 2>&1 || true
run node node_modules/eslint/bin/eslint.js --config eslint.mbt.config.js --max-warnings=0 \
  src/dispatch-load-assignment.js test/dispatch/unit/dispatch-activity-allocation-scope.test.js \
  test/dispatch/integration/dispatch-activity-allocation-scope.test.js \
  test/support/dispatch-activity-allocation-scope-fixture.mjs tools/mutate-dispatch-activity-allocation-scope.mjs \
  tools/replay-dispatch-activity-allocation-scope.mjs >"$artifact/final/lint.log" 2>&1 || true
run node --check src/dispatch-load-assignment.js
run node test/support/scan-diff-secrets.mjs src/dispatch-load-assignment.js \
  test/dispatch/unit/dispatch-activity-allocation-scope.test.js test/dispatch/integration/dispatch-activity-allocation-scope.test.js \
  test/support/dispatch-activity-allocation-scope-fixture.mjs tools/mutate-dispatch-activity-allocation-scope.mjs \
  tools/replay-dispatch-activity-allocation-scope.mjs tools/check-dispatch-activity-allocation-scope-live.sh \
  tools/dispatch-activity-allocation-scope-gauntlet.sh >"$artifact/final/secrets.log" 2>&1
reset_db
baseline npm run test:mbt >"$artifact/final/mbt-baseline.log" 2>&1 || true
reset_db
run npm run test:mbt >"$artifact/final/mbt.log" 2>&1 || true
baseline npm run test:baseline:mbt:full >"$artifact/final/legacy-baseline.log" 2>&1 || true
run npm run test:baseline:mbt:full >"$artifact/final/legacy.log" 2>&1 || true
bash server/tools/check-dispatch-activity-allocation-scope-live.sh >"$artifact/final/live.log"
sha256sum --check "$artifact/final/source.sha256"
python3 server/tools/check-dispatch-activity-allocation-scope-evidence.py
git diff --check

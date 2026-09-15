#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/operator-yard-access"
suffix=""
source_root="$repo_root/server"
test_root="$repo_root/server/test"
if [[ "${OPERATOR_YARD_BASELINE:-0}" == 1 ]]; then
  suffix="-baseline"
  source_root="$artifact/baseline"
  if [[ "${OPERATOR_YARD_BASELINE_TESTS:-original}" != current ]]; then test_root="$artifact/baseline/test"; fi
fi
network="mbbs-operator-yard-access-test$suffix${OPERATOR_YARD_RUN_TAG:-}"
database="mbbs-operator-yard-access-test-db$suffix${OPERATOR_YARD_RUN_TAG:-}"
mkdir -p "$artifact"
extra_mounts=()
if [[ "$suffix" == -baseline ]]; then
  extra_mounts+=(-v "$artifact/baseline/tools/mbt-predeploy-readiness.mjs:/app/tools/mbt-predeploy-readiness.mjs:ro")
fi
docker network create --internal "$network" >/dev/null
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
run() {
  docker run --rm --network "$network" --ipc=host --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test -e MBBS_REPO_ROOT=/workspace -e DISPATCH_PLANNER_ORDER_POOL_MODE=off \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    -e NODE_V8_COVERAGE="${OPERATOR_YARD_COVERAGE_DIR:-}" \
    -v "$source_root/src:/app/src:ro" -v "$source_root/public:/app/public:ro" \
    -v "$test_root:/app/test:ro" -v "$source_root/migrations:/app/migrations:ro" \
    -v "$repo_root/server/package.json:/app/package.json:ro" -v "$repo_root/server/tools:/app/tools:ro" \
    -v "$repo_root/server/test-artifacts:/app/test-artifacts" -v "$repo_root:/workspace:ro" \
    "${extra_mounts[@]}" --entrypoint "$1" "${OPERATOR_YARD_IMAGE:-mbbs-retired-confirm-test:20260914}" "${@:2}"
}
run npm run migrate > "$artifact/migrate$suffix.log" 2>&1
if [[ "${1:-}" == "--full" ]]; then
  run npm run test:mbt > "$artifact/full$suffix.log" 2>&1
elif [[ "${1:-}" == "--command" ]]; then
  run "${@:2}"
else
  run node --test --test-concurrency=1 test/mbt/unit/operator-yard-access.test.js test/mbt/unit/operator-yard-assets.test.js test/mbt/integration/operator-yard-access.test.js > "$artifact/focused$suffix.log" 2>&1
fi

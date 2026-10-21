#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="$(cd "${RECEIVING_MULTIYARD_SOURCE_ROOT:-$task_root}" && pwd)"
run_key="$(date +%s)-$$"
network="mbbs-receiving-multiyard-$run_key"
database="$network-db"
tool_image_id="$(docker image inspect mbbs-regular-v2:e2e --format '{{.Id}}')"
database_image_id="$(docker image inspect postgres:18-alpine --format '{{.Id}}')"
mkdir -p "$task_root/test-artifacts/receiving-multi-yard"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test "$database_image_id" >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
run() {
  docker run --rm --network "$network" --ipc=private --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e DISPATCH_PLANNER_ORDER_POOL_MODE=off \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e RECEIVING_MULTIYARD_TOOL_IMAGE_ID="$tool_image_id" \
    -e RECEIVING_MULTIYARD_DATABASE_IMAGE_ID="$database_image_id" \
    -e NODE_OPTIONS="--import=/app/tools/receiving-multi-yard-test-deadline.mjs" \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    -v "$source_root/src:/app/src:ro" -v "$source_root/public:/app/public:ro" \
    -v "$task_root/test:/app/test:ro" -v "$source_root/migrations:/app/migrations:ro" \
    -v "$task_root/tools:/app/tools:ro" -v "$task_root/package.json:/app/package.json:ro" \
    -v "$task_root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
    -v "$task_root/tsconfig.mbt.json:/app/tsconfig.mbt.json:ro" \
    -v "$task_root/test-artifacts:/app/test-artifacts" \
    --entrypoint "$1" "$tool_image_id" "${@:2}"
}
run node src/migrate.js > "$task_root/test-artifacts/receiving-multi-yard/migrate-$run_key.log" 2>&1
run "$@"

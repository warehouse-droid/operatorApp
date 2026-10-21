#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_key="scm-line-order-$(date +%s)-$$"
test_image="${SCM_LINE_ORDER_TEST_IMAGE:-mbbs-regular-v2:test}"
docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker); fi
mkdir -p "$server_root/test-artifacts/scm-line-order"
cleanup() {
  "${docker_cmd[@]}" rm -f "$run_key-db" >/dev/null 2>&1 || true
  "${docker_cmd[@]}" network rm "$run_key" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${docker_cmd[@]}" network create --internal "$run_key" >/dev/null
"${docker_cmd[@]}" run -d --name "$run_key-db" --network "$run_key" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if "${docker_cmd[@]}" exec "$run_key-db" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
run() {
  "${docker_cmd[@]}" run --rm --network "$run_key" --ipc=host --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=.env.scm-line-order-test -e NODE_ENV=test \
    -e DISPATCH_PLANNER_ORDER_POOL_MODE=off -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    -v "$server_root/src:/app/src:ro" -v "$server_root/public:/app/public:ro" \
    -v "$server_root/test:/app/test:ro" -v "$server_root/migrations:/app/migrations:ro" \
    -v "$server_root/tools:/app/tools:ro" -v "$server_root/test-artifacts:/app/test-artifacts" \
    --entrypoint node "$test_image" "$@"
}
run src/migrate.js > "$server_root/test-artifacts/scm-line-order/migrations.log" 2>&1
run "${@:-tools/scm-line-order-check.mjs}"

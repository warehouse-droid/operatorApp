#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${AGGREGATE_SOURCE_ROOT:-${server_root}}"
test_image="${AGGREGATE_TEST_IMAGE:-field-sales-check-2941306:latest}"
test_name="${AGGREGATE_TEST_NAME:-mbbs-aggregate-requests}"
case "$test_name" in mbbs-aggregate-requests|mbbs-aggregate-baseline|mbbs-aggregate-regression) ;; *) exit 70 ;; esac
network="$test_name-test"
database="$test_name-db"
runner="$test_name-runner"

case "${1:-}" in
  start)
    docker network inspect "$network" >/dev/null 2>&1 || docker network create --internal "$network"
    docker run -d --name "$database" --network "$network" --network-alias db \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password -e POSTGRES_DB=mbt_test \
      --tmpfs /var/lib/postgresql postgres:18-alpine
    for attempt in {1..30}; do
      if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
      sleep 1
    done
    ;;
  stop)
    docker rm -f "$runner" "$database" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    ;;
  runner)
    docker run -d --name "$runner" --network "$network" --read-only \
      --tmpfs /tmp:mode=1777 --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.aggregate-test-does-not-exist \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
      -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
      -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
      -e SALES_PUBLIC_ACCESS_ENABLED=false -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -v "$source_root/src:/app/src:ro" -v "$source_root/public:/app/public:ro" \
      -v "$source_root/test:/app/test:ro" -v "$source_root/tools:/app/tools:ro" \
      -v "$source_root/migrations:/app/migrations:ro" -v "$source_root/package.json:/app/package.json:ro" \
      -v "$server_root/../:/workspace:ro" \
      --entrypoint sleep "$test_image" infinity
    ;;
  exec)
    shift
    docker exec -w /app "$runner" "$@"
    ;;
  *) echo 'Usage: aggregate-test-env.sh start|runner|exec COMMAND...|stop' >&2; exit 2 ;;
esac

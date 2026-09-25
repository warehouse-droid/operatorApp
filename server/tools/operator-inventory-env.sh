#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${INVENTORY_SOURCE_ROOT:-$server_root}"
test_name="${INVENTORY_TEST_NAME:-mbbs-operator-inventory-test}"
case "$test_name" in mbbs-operator-inventory-test|mbbs-operator-inventory-baseline) ;; *) exit 70 ;; esac
network="$test_name-net"
database="$test_name-db"
runner="$test_name-runner"
case "${1:-}" in
  start)
    docker network inspect "$network" >/dev/null 2>&1 || docker network create --internal "$network" >/dev/null
    docker run -d --name "$database" --network "$network" --network-alias db \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password -e POSTGRES_DB=mbt_test \
      --tmpfs /var/lib/postgresql postgres:18-alpine >/dev/null
    for attempt in {1..30}; do
      if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
      sleep 1
    done
    mounts=()
    for directory in src public test tools migrations contracts; do mounts+=(-v "$source_root/$directory:/app/$directory:ro"); done
    for file in "$source_root"/*.json "$source_root"/*.js "$source_root"/Dockerfile; do mounts+=(-v "$file:/app/$(basename "$file"):ro"); done
    docker run -d --name "$runner" --network "$network" --read-only --shm-size=512m \
      --tmpfs /tmp:mode=1777 --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.inventory-test-unconfigured \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false \
      -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e SALES_PUBLIC_ACCESS_ENABLED=false \
      -e MBBS_REPO_ROOT=/workspace -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      "${mounts[@]}" -v "$source_root/..:/workspace:ro" \
      --entrypoint sleep field-sales-check-2941306:latest infinity >/dev/null
    ;;
  exec) shift; docker exec -w /app "$runner" "$@" ;;
  stop) docker rm -f "$runner" "$database" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true ;;
  *) echo 'Usage: operator-inventory-env.sh start|exec COMMAND...|stop' >&2; exit 2 ;;
esac

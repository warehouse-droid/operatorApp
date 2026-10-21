#!/usr/bin/env bash
set -Eeuo pipefail
count_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
count_source="${COUNT_REFRESH_SOURCE:-$count_root}"
count_name="${COUNT_REFRESH_NAME:-mbbs-count-refresh-test}"
case "$count_name" in mbbs-count-refresh-test|mbbs-count-refresh-baseline|mbbs-count-refresh-live-before|mbbs-count-refresh-live-after) ;; *) exit 70 ;; esac
count_network="$count_name-net"
count_db="$count_name-db"
count_runner="$count_name-runner"
case "${1:-}" in
 start)
  count_subnet=10.247.103.0/24
  if [[ "$count_name" == mbbs-count-refresh-baseline ]]; then count_subnet=10.247.104.0/24; fi
  if [[ "$count_name" == mbbs-count-refresh-live-before ]]; then count_subnet=10.247.105.0/24; fi
  if [[ "$count_name" == mbbs-count-refresh-live-after ]]; then count_subnet=10.247.106.0/24; fi
  docker network create --internal --subnet "$count_subnet" "$count_network" >/dev/null
  docker run -d --name "$count_db" --network "$count_network" --network-alias db \
   -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password -e POSTGRES_DB=mbt_test \
   --tmpfs /var/lib/postgresql postgres:18-alpine >/dev/null
  for count_attempt in {1..30}; do
   if docker exec "$count_db" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
   sleep 1
  done
  count_mounts=()
  for count_dir in src public test tools migrations contracts; do count_mounts+=(-v "$count_source/$count_dir:/app/$count_dir:ro"); done
  for count_file in "$count_source"/*.json "$count_source"/*.js "$count_source"/Dockerfile; do count_mounts+=(-v "$count_file:/app/$(basename "$count_file"):ro"); done
  docker run -d --name "$count_runner" --network "$count_network" --read-only --shm-size=512m \
   --tmpfs /tmp:mode=1777 --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
   -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
   -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
   -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false \
   -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e SALES_PUBLIC_ACCESS_ENABLED=false \
   -e MBBS_REPO_ROOT=/workspace -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
   "${count_mounts[@]}" -v "$count_root/..:/workspace:ro" \
   --entrypoint sleep mbbs-regular-v2:e2e infinity >/dev/null
  ;;
 exec) shift; docker exec -w /app "$count_runner" "$@" ;;
 stop) docker rm -f "$count_runner" "$count_db" >/dev/null 2>&1 || true; docker network rm "$count_network" >/dev/null 2>&1 || true ;;
 *) exit 2 ;;
esac

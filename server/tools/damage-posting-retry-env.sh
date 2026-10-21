#!/usr/bin/env bash
set -Eeuo pipefail
damage_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
damage_source="${DAMAGE_RETRY_SOURCE_ROOT:-$damage_root}"
damage_name="${DAMAGE_RETRY_TEST_NAME:-mbbs-damage-posting-retry-test}"
case "$damage_name" in mbbs-damage-posting-retry-test|mbbs-damage-posting-retry-baseline|mbbs-damage-posting-retry-comparison-baseline|mbbs-damage-posting-retry-comparison-final) ;; *) exit 70 ;; esac
damage_network="$damage_name-net"
damage_db="$damage_name-db"
damage_runner="$damage_name-runner"
case "${1:-}" in
  start)
    damage_subnet_args=()
    if [[ -n "${DAMAGE_RETRY_SUBNET:-}" ]]; then damage_subnet_args+=(--subnet "$DAMAGE_RETRY_SUBNET"); fi
    docker network create --internal "${damage_subnet_args[@]}" "$damage_network" >/dev/null
    docker run -d --name "$damage_db" --network "$damage_network" --network-alias db \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password -e POSTGRES_DB=mbt_test \
      --tmpfs /var/lib/postgresql postgres:18-alpine >/dev/null
    for damage_attempt in {1..30}; do
      if docker exec "$damage_db" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
      sleep 1
    done
    ;&
  runner)
    damage_mounts=()
    for damage_directory in src public test tools migrations contracts; do
      damage_mounts+=(-v "$damage_source/$damage_directory:/app/$damage_directory:ro")
    done
    for damage_file in "$damage_source"/*.json "$damage_source"/*.js "$damage_source"/Dockerfile; do
      damage_mounts+=(-v "$damage_file:/app/$(basename "$damage_file"):ro")
    done
    docker run -d --name "$damage_runner" --network "$damage_network" --read-only --shm-size=512m \
      --tmpfs /tmp:mode=1777 --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false \
      -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e SALES_PUBLIC_ACCESS_ENABLED=false \
      -e MBBS_REPO_ROOT=/workspace -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      "${damage_mounts[@]}" -v "$damage_root/..:/workspace:ro" \
      --entrypoint sleep mbbs-regular-v2:e2e infinity >/dev/null
    ;;
  exec) shift; docker exec -w /app "$damage_runner" "$@" ;;
  stop)
    docker rm -f "$damage_runner" "$damage_db" >/dev/null 2>&1 || true
    docker network rm "$damage_network" >/dev/null 2>&1 || true
    ;;
  *) echo 'Usage: damage-posting-retry-env.sh start|exec COMMAND...|stop' >&2; exit 2 ;;
esac

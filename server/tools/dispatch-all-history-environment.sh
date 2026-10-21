#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$server_root/test-artifacts/dispatch-all-history-20261002"
network=mbbs-order-history-20261002
database="$network-db"
runner="$network-runner"
image="${DISPATCH_ALL_HISTORY_IMAGE:-mbbs-regular-v2:test}"
source_root="${DISPATCH_ALL_HISTORY_SOURCE_ROOT:-$server_root}"
baseline_root="${DISPATCH_ALL_HISTORY_BASELINE_ROOT:-$artifact/baseline}"
runtime_database="${DISPATCH_ALL_HISTORY_DATABASE:-mbt_test}"
docker() { sudo -n docker "$@"; }
mkdir -p "$artifact"
chmod 700 "$artifact"
case "${1:-}" in
  setup)
    test ! -e "$artifact/source.dump"
    umask 077
    docker exec mbbs-operator-app-db-1 sh -c 'exec pg_dump -Fc --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$artifact/source.dump.partial"
    mv "$artifact/source.dump.partial" "$artifact/source.dump"
    sha256sum "$artifact/source.dump" > "$artifact/source.dump.sha256"
    for attempt in {1..20}; do
      if docker network create --internal --subnet "10.249.$((RANDOM % 256)).0/28" "$network" > "$artifact/network-id.txt" 2>/dev/null; then break; fi
      test "$attempt" != 20
    done
    docker run -d --name "$database" --network "$network" --network-alias db \
      --memory=2g --cpus=2 --label purpose=isolated-order-history-replay \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=history_local_only -e POSTGRES_DB=mbt_test_history \
      postgres:18-alpine > "$artifact/database-id.txt"
    for attempt in {1..60}; do
      if docker exec "$database" pg_isready -U mbt_test -d mbt_test_history >/dev/null 2>&1; then break; fi
      sleep 1
    done
    docker exec -i "$database" pg_restore --exit-on-error --no-owner --no-acl -U mbt_test -d mbt_test_history < "$artifact/source.dump" > "$artifact/restore.log" 2>&1
    docker exec "$database" psql -U mbt_test -d mbt_test_history -c 'ANALYZE' > "$artifact/analyze.log"
    mounts=()
    for directory in src public test migrations tools contracts; do
      mounts+=(-v "$server_root/$directory:/app/$directory:ro")
    done
    mounts+=(-v "$server_root/package.json:/app/package.json:ro" -v "$artifact:/app/test-artifacts/dispatch-all-history-20261002")
    docker run -d --name "$runner" --network "$network" --memory=2g --cpus=2 \
      --user "$(id -u):$(id -g)" --label purpose=isolated-order-history-replay \
      -e MBT_TEST_ISOLATED=1 -e NODE_ENV=test -e MBBS_ENV_FILE=.env.history-disabled \
      -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_test_history \
      -e GOOGLE_MAPS_MODE=disabled -e MBT_NETSUITE_WRITES_ENABLED=false \
      -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e DISPATCH_PLANNER_ORDER_POOL_MODE=on \
      -e DISPATCH_DRIVER_ORIENTED_PLANNING=true "${mounts[@]}" --entrypoint sleep "$image" infinity > "$artifact/runner-id.txt"
    docker network inspect "$network" --format '{{.Internal}}' > "$artifact/network-internal.txt"
    test "$(cat "$artifact/network-internal.txt")" = true
    docker exec "$runner" node --version
    printf 'Isolated historical replay environment ready: %s\n' "$runner"
    ;;
  exec)
    shift
    docker exec "$runner" "$@"
    ;;
  test-setup)
    docker exec "$database" createdb -U mbt_test mbt_test
    docker exec -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_test "$runner" npm run migrate
    ;;
  test-exec)
    shift
    docker exec -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_test "$runner" "$@"
    ;;
  focus-setup)
    docker exec "$database" createdb -U mbt_test mbt_history_focus
    docker exec -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_history_focus "$runner" npm run migrate
    ;;
  focus-exec)
    shift
    docker exec -e DATABASE_URL=postgres://mbt_test:history_local_only@db:5432/mbt_history_focus "$runner" "$@"
    ;;
  baseline-exec)
    shift
    mounts=()
    for directory in src public; do mounts+=(-v "$baseline_root/$directory:/app/$directory:ro"); done
    for directory in test migrations tools contracts; do mounts+=(-v "$source_root/$directory:/app/$directory:ro"); done
    for file in "$source_root"/*.json "$source_root"/eslint*.js; do mounts+=(-v "$file:/app/$(basename "$file"):ro"); done
    for entry in .github/workflows docker-compose.yml docker-compose.mbt-test.yml docker-compose.v2.yml docs; do
      mounts+=(-v "$server_root/../$entry:/workspace/$entry:ro")
    done
    docker run --rm --network "$network" --memory=2g --cpus=2 --user "$(id -u):$(id -g)" \
      -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e NODE_ENV=test -e MBBS_ENV_FILE=.env.history-disabled \
      -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
      -e DATABASE_URL="postgres://mbt_test:history_local_only@db:5432/$runtime_database" \
      "${mounts[@]}" -v "$artifact:/app/test-artifacts/dispatch-all-history-20261002" \
      --entrypoint "$1" "$image" "${@:2}"
    ;;
  candidate-exec|history-exec)
    runtime_mbt=true
    runtime_flags=()
    if [[ "$1" = history-exec ]]; then
      runtime_database=mbt_test_history; runtime_mbt=false
      runtime_flags=(-e GOOGLE_MAPS_MODE=disabled -e MBT_NETSUITE_WRITES_ENABLED=false
        -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e DISPATCH_PLANNER_ORDER_POOL_MODE=on
        -e DISPATCH_DRIVER_ORIENTED_PLANNING=true)
    fi
    shift
    mounts=()
    for directory in src public test migrations tools contracts; do mounts+=(-v "$source_root/$directory:/app/$directory:ro"); done
    for file in "$source_root"/*.json "$source_root"/eslint*.js; do mounts+=(-v "$file:/app/$(basename "$file"):ro"); done
    for entry in .github/workflows docker-compose.yml docker-compose.mbt-test.yml docker-compose.v2.yml docs; do
      mounts+=(-v "$server_root/../$entry:/workspace/$entry:ro")
    done
    docker run --rm --network "$network" --memory=2g --cpus=2 --user "$(id -u):$(id -g)" \
      -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED="$runtime_mbt" -e NODE_ENV=test -e MBBS_ENV_FILE=.env.history-disabled \
      -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
      "${runtime_flags[@]}" \
      -e DATABASE_URL="postgres://mbt_test:history_local_only@db:5432/$runtime_database" \
      "${mounts[@]}" -v "$artifact:/app/test-artifacts/dispatch-all-history-20261002" \
      --entrypoint "$1" "$image" "${@:2}"
    ;;
  freeze)
    frozen_root="$artifact/final-source"
    test ! -e "$frozen_root"
    mkdir "$frozen_root"
    for directory in src public test migrations tools contracts; do cp -a "$server_root/$directory" "$frozen_root/$directory"; done
    for file in "$server_root"/*.json "$server_root"/eslint*.js; do cp -a "$file" "$frozen_root/$(basename "$file")"; done
    ;;
  reset)
    docker exec "$database" dropdb -U mbt_test --force mbt_test_history
    docker exec "$database" createdb -U mbt_test mbt_test_history
    docker exec -i "$database" pg_restore --exit-on-error --no-owner --no-acl -U mbt_test -d mbt_test_history < "$artifact/source.dump" > "$artifact/restore.log" 2>&1
    docker exec "$database" psql -U mbt_test -d mbt_test_history -c 'ANALYZE' > "$artifact/analyze.log"
    ;;
  *) printf 'Usage: %s {setup|exec COMMAND...|reset|freeze|history-exec COMMAND...|test-setup|test-exec COMMAND...|focus-setup|focus-exec COMMAND...|baseline-exec COMMAND...|candidate-exec COMMAND...}\n' "$0" >&2; exit 2 ;;
esac

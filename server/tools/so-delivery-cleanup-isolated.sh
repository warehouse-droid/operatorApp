#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
network=mbbs-so-cleanup-20260915-isolated
database=$network-db
release="$repo/docker/backups/so-delivery-cleanup-20260915/release"
artifact="$repo/server/test-artifacts/so-delivery-cleanup-apply-20260915"
case "${1:-}" in
  start)
    docker network create --internal "$network" >/dev/null
    docker volume create "$database" >/dev/null
    docker run -d --name "$database" --network "$network" --network-alias db \
      -v "$database:/var/lib/postgresql" \
      -v "$repo/docker/backups/so-delivery-cleanup-20260915:/backup:ro" \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
      -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
    for attempt in {1..30}; do
      if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
      sleep 1
    done
    docker exec "$database" pg_restore -U mbt_test -d mbt_test --no-owner --no-acl \
      --exit-on-error --jobs=4 /backup/pre-cleanup.dump > "$artifact/restore.log" 2>&1
    ;;
  run)
    shift
    docker run --rm --network "$network" --ipc=host --user "$(id -u):$(id -g)" \
      -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
      -e MBBS_REPO_ROOT=/workspace -e DISPATCH_PLANNER_ORDER_POOL_MODE=off \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
      -e NODE_V8_COVERAGE="${CLEANUP_COVERAGE_DIR:-}" \
      -v "$release/src:/app/src:ro" -v "$release/public:/app/public:ro" \
      -v "$release/package.json:/app/package.json:ro" -v "$release/migrations:/app/migrations:ro" \
      -v "$repo/server/test:/app/test:ro" -v "$repo/server/tools:/app/tools:ro" \
      -v "$repo/server/test-artifacts:/app/test-artifacts" -v "$repo:/workspace:ro" \
      --entrypoint "$1" "${CLEANUP_TEST_IMAGE:-mbbs-retired-confirm-test:20260914}" "${@:2}"
    ;;
  stop)
    docker rm -f "$database" >/dev/null
    docker volume rm "$database" >/dev/null
    docker network rm "$network" >/dev/null
    ;;
  *) printf 'Usage: %s start|run COMMAND...|stop\n' "$0" >&2; exit 2 ;;
esac

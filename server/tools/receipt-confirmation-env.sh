#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$server_root/test-artifacts/receipt-confirmation"
name="mbbs-receipt-confirmation-${RECEIPT_CONFIRMATION_BASELINE:-0}"
source_root="${RECEIPT_CONFIRMATION_SOURCE:-$server_root}"
case "${1:-}" in
  start)
    mkdir -p "$artifact"
    docker network create --internal "$name" >/dev/null
    docker run -d --name "$name-db" --network "$name" --network-alias db \
      --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
      -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
    for attempt in {1..30}; do
      if docker exec "$name-db" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
      sleep 1
    done
    mounts=()
    for directory in src public test tools migrations contracts; do
      mounts+=(-v "$source_root/$directory:/app/$directory:ro")
    done
    for file in "$source_root"/*.json "$source_root"/eslint*.js; do
      mounts+=(-v "$file:/app/$(basename "$file"):ro")
    done
    docker run -d --name "$name-runner" --network "$name" --read-only \
      --tmpfs /tmp:mode=1777 --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.receipt-confirmation-test-does-not-exist \
      -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
      -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
      -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
      "${mounts[@]}" -v "$server_root/..:/workspace:ro" \
      -v "$artifact:/app/test-artifacts/receipt-confirmation:rw" \
      -v "$server_root/test-artifacts/sn1401278-reproduction:/app/test-artifacts/sn1401278-reproduction:ro" \
      --entrypoint sleep field-sales-check-2941306:latest infinity >/dev/null
    docker exec -w /app "$name-runner" node src/migrate.js > "$artifact/migrate-${RECEIPT_CONFIRMATION_BASELINE:-0}.log" 2>&1
    ;;
  exec) shift; docker exec -w /app "$name-runner" "$@" ;;
  stop)
    docker rm -f "$name-runner" "$name-db" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    ;;
  *) exit 2 ;;
esac

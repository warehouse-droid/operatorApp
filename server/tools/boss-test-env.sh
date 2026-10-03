#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  start)
    docker network inspect mbbs-boss-test >/dev/null 2>&1 || docker network create --internal mbbs-boss-test
    docker run -d --name mbbs-boss-test-db --network mbbs-boss-test --network-alias db \
      -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=boss_test_only -e POSTGRES_DB=mbt_test \
      --tmpfs /var/lib/postgresql postgres:18-alpine
    for attempt in {1..30}; do docker exec mbbs-boss-test-db pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1 && break; sleep 1; done
    docker run -d --name mbbs-boss-test-runner --network mbbs-boss-test --read-only \
      --tmpfs /tmp:mode=1777 --tmpfs /app/data:mode=1777 --tmpfs /app/test-artifacts:mode=1777 \
      -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.boss-test-does-not-exist \
      -e DATABASE_URL=postgres://mbt_test:boss_test_only@db:5432/mbt_test \
      -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
      -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
      -e SALES_PUBLIC_ACCESS_ENABLED=false -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -v "$root:/workspace:ro" -v "$root/src:/app/src:ro" -v "$root/public:/app/public:ro" \
      -v "$root/test:/app/test:ro" -v "$root/tools:/app/tools:ro" -v "$root/migrations:/app/migrations:ro" \
      -v "$root/package.json:/app/package.json:ro" --entrypoint sleep mbbs-regular-v2:e2e infinity
    ;;
  exec) shift; docker exec -w /app mbbs-boss-test-runner "$@" ;;
  stop)
    docker rm -f mbbs-boss-test-runner mbbs-boss-test-db >/dev/null 2>&1 || true
    docker network rm mbbs-boss-test >/dev/null 2>&1 || true
    ;;
  *) echo 'Usage: boss-test-env.sh start|exec COMMAND...|stop' >&2; exit 2 ;;
esac

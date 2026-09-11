#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:-all}"
network_name="operatorapp-dispatch-review-test-20260910"
db_name="operatorapp-dispatch-review-db-20260910"
test_image="mbbs-schedule-columns-test:20260910"
db_image="postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15"
cleanup() {
  docker rm -f "$db_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network_name" >/dev/null
docker run -d --name "$db_name" --network "$network_name" --network-alias db \
  --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=review_test -e POSTGRES_PASSWORD=isolated_review_test -e POSTGRES_DB=review_test \
  "$db_image" >/dev/null
for attempt in {1..30}; do
  if docker exec "$db_name" pg_isready -U review_test -d review_test >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$db_name" pg_isready -U review_test -d review_test
run_test() {
  docker run --rm --network "$network_name" --tmpfs /app/data:uid=1000,gid=1000,mode=0700 \
    -e NODE_ENV=test -e MBBS_ENV_FILE=.env.dispatch-review-test-missing \
    -e DATABASE_URL=postgres://review_test:isolated_review_test@db:5432/review_test \
    -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
    -e MBT_NETSUITE_WRITES_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
    --mount "type=bind,src=$repo_root/server/src,dst=/app/src,readonly" \
    --mount "type=bind,src=$repo_root/server/test,dst=/app/test,readonly" \
    --mount "type=bind,src=$repo_root/server/migrations,dst=/app/migrations,readonly" \
    --mount "type=bind,src=$repo_root/server/tools,dst=/app/tools,readonly" \
    --mount "type=bind,src=$repo_root/server/public,dst=/app/public,readonly" \
    "$test_image" "$@"
}
run_test node src/migrate.js >/dev/null
if [[ "$mode" == red ]]; then
  run_test node --test --test-concurrency=1 test/dispatch/integration/dispatch-review-pool-repair.test.js
else
  run_test node --test --test-concurrency=1 \
    test/mbt/unit/scm-receipt-source-reference.test.js \
    test/dispatch/integration/dispatch-review-pool-repair.test.js \
    test/mbt/unit/scm-ir-split-reference.red.test.js \
    test/mbt/property/scm-ir-split-reference.property.test.js \
    test/mbt/unit/scm-split-receipt-allocation.red.test.js \
    test/mbt/property/scm-split-receipt-allocation.property.test.js \
    test/mbt/integration/scm-split-receipt-allocation.red.test.js \
    test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js
  run_test node src/scm-reconciliation-repository-harness.js
  run_test node src/scm-reconciliation-linked-fetch-harness.js
fi

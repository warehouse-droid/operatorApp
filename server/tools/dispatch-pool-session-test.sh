#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/dispatch-pool-session"
suffix=""
source_mounts=()
if [[ "${POOL_SESSION_BASELINE:-0}" == 1 ]]; then
  suffix="-baseline"
  source_mounts=(-v "$artifact/baseline/src/dispatch-repository.js:/app/src/dispatch-repository.js:ro")
fi
network=mbbs-dispatch-pool-session-test
database=mbbs-dispatch-pool-session-test-db
mkdir -p "$artifact"
docker network create --internal "$network" >/dev/null
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
run() {
  docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    -v "$repo_root/server/src:/app/src:ro" -v "$repo_root/server/public:/app/public:ro" \
    -v "$repo_root/server/test:/app/test:ro" -v "$repo_root/server/migrations:/app/migrations:ro" \
    -v "$repo_root/server/package.json:/app/package.json:ro" \
    "${source_mounts[@]}" \
    --entrypoint "$1" mbbs-retired-confirm-test:20260914 "${@:2}"
}
run npm run migrate > "$artifact/migrate$suffix.log" 2>&1
run node --test --test-concurrency=1 \
  test/dispatch/integration/dispatch-co-pool-recency.test.js \
  test/dispatch/integration/dispatch-order-db-recency.test.js \
  test/workload/integration/dispatch-recent-pool.red.test.js \
  test/dispatch/integration/dispatch-order-catalog.red.test.js \
  test/dispatch/integration/dispatch-global-derived-order-pool.red.test.js \
  > "$artifact/database$suffix.log" 2>&1

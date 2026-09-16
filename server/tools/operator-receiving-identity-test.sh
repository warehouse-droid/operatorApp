#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${RECEIVING_IDENTITY_SOURCE_ROOT:-$repo_root/server}"
artifact="$repo_root/server/test-artifacts/operator-receiving-identity"
run_key="$(date +%s)-$$"
network="mbbs-receiving-identity-$run_key"
database="$network-db"
mkdir -p "$artifact"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
run() {
  docker run --rm --network "$network" --ipc=host --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e MBBS_REPO_ROOT=/workspace -e DISPATCH_PLANNER_ORDER_POOL_MODE=off \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    -v "$source_root/src:/app/src:ro" -v "$source_root/public:/app/public:ro" \
    -v "$source_root/test:/app/test:ro" -v "$source_root/migrations:/app/migrations:ro" \
    -v "$source_root/tools:/app/tools:ro" -v "$source_root/package.json:/app/package.json:ro" \
    -v "$source_root/tsconfig.mbt.json:/app/tsconfig.mbt.json:ro" \
    -v "$source_root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
    -v "$repo_root/server/test-artifacts:/app/test-artifacts" -v "$repo_root:/workspace:ro" \
    --entrypoint "$1" mbbs-retired-confirm-test:20260914 "${@:2}"
}
run npm run migrate > "$artifact/migrate-$run_key.log" 2>&1
run "${@:-node}"

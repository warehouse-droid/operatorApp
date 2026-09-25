#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${STOCK_RETURN_SOURCE_ROOT:-$root/server}"
test_image="${STOCK_RETURN_TEST_IMAGE:-mbbs-retired-confirm-test:20260914}"
artifact="$root/server/test-artifacts/stock-return-insert"
run_key="$(date +%s)-$$"
network="mbbs-stock-return-test-$run_key"
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
mounts=()
if [[ "${STOCK_RETURN_IMAGE_ONLY:-0}" != 1 ]]; then
  for directory in src public migrations; do
    test -d "$source_root/$directory"
    mounts+=(-v "$source_root/$directory:/app/$directory:ro")
  done
fi
for directory in tools test contracts; do
  mounts+=(-v "$root/server/$directory:/app/$directory:ro")
done
if [[ "${STOCK_RETURN_IMAGE_ONLY:-0}" != 1 ]]; then
  for file in "$root"/server/*.json "$root"/server/*.js "$root"/server/Dockerfile*; do
    mounts+=(-v "$file:/app/$(basename "$file"):ro")
  done
fi
run() {
  docker run --rm --network "$network" --cpus 2 --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e DISPATCH_PLANNER_ORDER_POOL_MODE=off -e MBBS_REPO_ROOT=/workspace \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" -v "$root/server/test-artifacts:/app/test-artifacts" -v "$root:/workspace:ro" \
    --entrypoint "$1" "$test_image" "${@:2}"
}
run npm run migrate > "$artifact/migrate-$run_key.log" 2>&1
run "$@"

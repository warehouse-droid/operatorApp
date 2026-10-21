#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_root="${RETURN_STORED_SOURCE_ROOT:-$root/server}"
test_image="${RETURN_STORED_TEST_IMAGE:-mbbs-bin-planning-test:20260927}"
run_key="$(date +%s)-$$"
network="mbbs-return-stored-test-$run_key"
database="$network-db"
artifact="$root/server/test-artifacts/return-stored-orderline"
mkdir -p "$artifact"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal --subnet "${RETURN_STORED_TEST_SUBNET:-10.254.66.0/24}" "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
mounts=()
for directory in src public migrations test tools contracts; do
  mounts+=(-v "$source_root/$directory:/app/$directory:ro")
done
for file in package.json package-lock.json tsconfig.mbt.json eslint.mbt.config.js; do
  mounts+=(-v "$source_root/$file:/app/$file:ro")
done
browser_options=()
if [[ -d /tmp/return-batch-playwright ]]; then
  browser_options=(-e PLAYWRIGHT_BROWSERS_PATH=/browsers -v /tmp/return-batch-playwright:/browsers:ro)
fi
run() {
  docker run --rm --network "$network" --cpus 2 --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e NODE_OPTIONS=--import=/return-stored-test-timeouts.mjs \
    -v "$root/server/tools/return-stored-orderline-timeouts.mjs:/return-stored-test-timeouts.mjs:ro" \
    -e DISPATCH_PLANNER_ORDER_POOL_MODE=off -e MBBS_REPO_ROOT=/workspace \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" "${browser_options[@]}" -v "$artifact:/app/test-artifacts/return-stored-orderline" \
    -v "$root:/workspace:ro" --entrypoint "$1" "$test_image" "${@:2}"
}
run npm run migrate > "$artifact/migrate-$run_key.log" 2>&1
run "$@"

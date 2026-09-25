#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
network="mbbs-local-load-perf-$(date +%s)-$$"
database="$network-db"
artifact="$task_root/server/test-artifacts/local-load-performance"
mkdir -p "$artifact"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal --subnet "${LOCAL_LOAD_PERF_SUBNET:-10.253.171.0/28}" "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
mounts=()
for directory in src public test migrations tools contracts; do
  mounts+=(-v "$task_root/server/$directory:/app/$directory:ro")
done
for file in "$task_root/server"/*.json "$task_root/server"/*.js; do
  mounts+=(-v "$file:/app/$(basename "$file"):ro")
done
if [[ "${LOCAL_LOAD_PERF_BASELINE:-0}" == "1" ]]; then
  mounts+=(-v "$artifact/baseline/src/delivery-repository.js:/app/src/delivery-repository.js:ro")
fi
run() {
  docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" -v "$task_root/server/test-artifacts:/app/test-artifacts" \
    --entrypoint "$1" mbbs-retired-confirm-test:20260914 "${@:2}"
}
run npm run migrate > "$artifact/migrate.log" 2>&1
run "$@"

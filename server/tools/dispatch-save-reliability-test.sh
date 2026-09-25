#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_key="$(date +%s)-$$"
network="mbbs-dispatch-save-reliability-$run_key"
database="$network-db"
artifact="$repo_root/server/test-artifacts/dispatch-save-reliability"
mkdir -p "$artifact"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Use a small explicit range; other long-lived test networks may have consumed
# Docker's default /16 address pools. This affects only this disposable network.
for attempt in {1..10}; do
  subnet_octet=$((RANDOM % 256))
  subnet_block=$(((RANDOM % 32) * 8))
  if docker network create --internal --subnet "10.247.$subnet_octet.$subnet_block/29" "$network" >/dev/null 2>&1; then break; fi
  if [[ "$attempt" == 10 ]]; then exit 1; fi
done
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
mounts=()
for directory in src public test migrations tools contracts; do
  directory_source="$repo_root/server/$directory"
  if [[ -n "${DISPATCH_SAVE_RELIABILITY_BASELINE:-}" && ( "$directory" == src || "$directory" == public ) ]]; then
    directory_source="$DISPATCH_SAVE_RELIABILITY_BASELINE/$directory"
  fi
  mounts+=(-v "$directory_source:/app/$directory:ro")
done
for file in "$repo_root/server"/*.json "$repo_root/server"/*.js "$repo_root/server"/Dockerfile*; do
  mounts+=(-v "$file:/app/$(basename "$file"):ro")
done
run() {
  docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" -v "$repo_root/server/test-artifacts:/app/test-artifacts" -v "$repo_root:/workspace:ro" \
    --entrypoint "$1" "${DISPATCH_SAVE_RELIABILITY_TEST_IMAGE:-mbbs-retired-confirm-test:20260914}" "${@:2}"
}
run npm run migrate > "$artifact/migrate-$run_key.log" 2>&1
run "$@"

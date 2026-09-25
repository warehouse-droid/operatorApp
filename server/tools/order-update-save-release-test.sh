#!/usr/bin/env bash
# Existing isolated runner, with separate release sources and evidence output.
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release_source="${ORDER_UPDATE_RELEASE_SOURCE:?Release source directory required}"
release_artifact="${ORDER_UPDATE_RELEASE_ARTIFACT:?Separate release evidence directory required}"
run_key="$(date +%s)-$$"
network="mbbs-order-update-release-$run_key"
database="$network-db"
mkdir -p "$release_artifact/order-update-save"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for attempt in {1..10}; do
  subnet_octet=$((RANDOM % 256))
  subnet_block=$(((RANDOM % 32) * 8))
  if docker network create --internal --subnet "10.245.$subnet_octet.$subnet_block/29" "$network" >/dev/null 2>&1; then break; fi
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
  if [[ "$directory" == src || "$directory" == public ]]; then
    directory_source="$release_source/$directory"
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
    "${mounts[@]}" -v "$release_artifact:/app/test-artifacts" -v "$repo_root:/workspace:ro" \
    --entrypoint "$1" "${ORDER_UPDATE_TEST_IMAGE:-mbbs-retired-confirm-test:20260914}" "${@:2}"
}
run npm run migrate > "$release_artifact/migrate-$run_key.log" 2>&1
run "$@"

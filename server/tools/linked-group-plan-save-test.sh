#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_key="$(date +%s)-$$"
network="mbbs-linked-group-save-$run_key"
database="$network-db"
artifact="$repo_root/server/test-artifacts/linked-group-plan-save-20261001"
mkdir -p "$artifact"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
network_octet=$((BASHPID % 250 + 1))
docker network create --internal --subnet "10.253.$network_octet.0/24" "$network" >/dev/null
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
  if [[ -n "${LINKED_GROUP_BASELINE:-}" && ( "$directory" == src || "$directory" == public ) ]]; then
    directory_source="$LINKED_GROUP_BASELINE/$directory"
  fi
  mounts+=(-v "$directory_source:/app/$directory:ro")
done
for file in "$repo_root/server"/*.json "$repo_root/server"/*.js; do
  mounts+=(-v "$file:/app/$(basename "$file"):ro")
done
run() {
  docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled \
    -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" -v "$repo_root/server/test-artifacts:/app/test-artifacts" -v "$repo_root:/workspace:ro" \
    --entrypoint "$1" mbbs-regular-v2:e2e "${@:2}"
}
run npm run migrate > "$artifact/migrate-$run_key.log" 2>&1
run "$@"

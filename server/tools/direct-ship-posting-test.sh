#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${DIRECT_SHIP_POSTING_SOURCE:-$server_root}"
artifact="$server_root/test-artifacts/direct-ship-posting-20261001"
run_key="$(date +%s)-$$"
network="mbbs-direct-ship-posting-$run_key"
database="$network-db"
mkdir -p "$artifact"
cleanup() { docker rm -f "$database" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create --internal --subnet "10.252.$((BASHPID % 250 + 1)).0/24" "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db --memory=512m --cpus=1 \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi; sleep 1; done
mounts=()
for directory in src public test migrations tools contracts; do
  mount_source="$source_root/$directory"
  if [[ "$directory" == test && -n "${DIRECT_SHIP_POSTING_TESTS:-}" ]]; then mount_source="$DIRECT_SHIP_POSTING_TESTS"; fi
  mounts+=(-v "$mount_source:/app/$directory:ro")
done
if [[ -n "${DIRECT_SHIP_POSTING_TOOL:-}" ]]; then mounts+=(-v "$DIRECT_SHIP_POSTING_TOOL:/app/direct-ship-runner.mjs:ro"); fi
for file in "$source_root"/*.json "$source_root"/*.js; do mounts+=(-v "$file:/app/$(basename "$file"):ro"); done
run() {
  docker run --rm --network "$network" --memory=2g --cpus=2 --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled -e MBT_NETSUITE_WRITES_ENABLED=false \
    -e SAMSARA_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
    -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test "${mounts[@]}" \
    -v "$server_root/test-artifacts:/app/test-artifacts" -v "$server_root/..:/workspace:ro" \
    --entrypoint "$1" mbbs-regular-v2:e2e "${@:2}"
}
run node src/migrate.js > "$artifact/migrate-$run_key.log" 2>&1
run "$@"

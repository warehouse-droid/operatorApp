#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release="$server_root/test-artifacts/whole-worktree-deployment-20260925"
source_root="${WORKTREE_RELEASE_SOURCE_ROOT:-$release/source}"
artifact="$release/checks/${WORKTREE_RELEASE_CHECK:?Choose a check name}"
run_key="$(date +%s)-$$"
network="mbbs-worktree-check-$run_key"
database="$network-db"
database_name="${WORKTREE_RELEASE_DATABASE:-mbt_test}"
case "$database_name" in mbt_test|mbt_verify) ;; *) exit 2 ;; esac
mkdir -p "$artifact/executed-order-review" "$artifact/netsuite-priority-queue" "$artifact/split-address"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB="$database_name" postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d "$database_name" >/dev/null 2>&1; then break; fi
  sleep 1
done
mounts=()
for directory in src public test migrations tools contracts; do
  mounts+=(-v "$source_root/$directory:/app/$directory:ro")
done
for file in "$source_root"/*.json "$source_root"/*.js "$source_root"/*.mjs "$source_root"/Dockerfile*; do
  [[ -f "$file" ]] && mounts+=(-v "$file:/app/$(basename "$file"):ro")
done
run() {
  docker run --rm --network "$network" --ipc=host --cpus=2 --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app -e DISPATCH_PLANNER_ORDER_POOL_MODE=off \
    -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e SAMSARA_WRITES_ENABLED=false \
    -e MBT_NETSUITE_WRITES_ENABLED=false -e SMART_SCM_LIVE_EXECUTION_ENABLED=false \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e DATABASE_URL="postgres://mbt_test:mbt_test_password@db:5432/$database_name" \
    "${mounts[@]}" -v "$artifact:/app/test-artifacts" \
    -v "$server_root/..:/workspace:ro" -v "$source_root:/workspace/server:ro" \
    --entrypoint "$1" field-sales-check-2941306:latest "${@:2}"
}
run node src/migrate.js > "$artifact/migrate.log" 2>&1
run "$@"

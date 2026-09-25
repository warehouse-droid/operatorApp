#!/usr/bin/env bash
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
network="mbbs-local-load-replay-$(date +%s)-$$"
database="$network-db"
artifact="$task_root/server/test-artifacts/local-load-performance/replay"
source_root="${LOCAL_LOAD_REPLAY_SOURCE:-$artifact/live-code}"
cleanup() {
  docker rm -f "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Private database and local upload substitute, no external egress or host ports.
docker network create --internal --subnet "${LOCAL_LOAD_REPLAY_SUBNET:-10.253.172.0/28}" "$network" >/dev/null
docker run -d --name "$database" --network "$network" --network-alias db \
  --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
  -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
mounts=()
for directory in src public; do mounts+=(-v "$source_root/$directory:/app/$directory:ro"); done
for directory in test migrations tools contracts; do mounts+=(-v "$task_root/server/$directory:/app/$directory:ro"); done
for file in "$task_root/server"/*.json "$task_root/server"/*.js; do mounts+=(-v "$file:/app/$(basename "$file"):ro"); done
run() {
  docker run --rm --network "$network" --shm-size=512m --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -e LOCAL_LOAD_REPLAY_RUN="${LOCAL_LOAD_REPLAY_RUN:-deployed-normal}" \
    -e LOCAL_LOAD_REPLAY_UPLOAD_KBPS="${LOCAL_LOAD_REPLAY_UPLOAD_KBPS:-0}" \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" -v "$task_root/server/test-artifacts:/app/test-artifacts" \
    -v "$task_root/server/test-artifacts/schedule-columns/browser-cache:/ms-playwright:ro" \
    --entrypoint "$1" mbbs-scm-search-vendor-test:20260910 "${@:2}"
}
run npm run migrate > "$artifact/migrate.log" 2>&1
run node "${LOCAL_LOAD_REPLAY_SCRIPT:-tools/local-load-replay-browser.mjs}"

#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/reconciled-split-inbound"
image="${RECONCILED_SPLIT_INBOUND_TEST_IMAGE:-mbbs-retired-confirm-test:20260914}"
network="mbbs-reconciled-split-inbound-test-$(date +%s)-$$"
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
  local overrides=()
  if [[ "${RECONCILED_SPLIT_INBOUND_BASELINE:-0}" == "1" ]]; then
    while IFS= read -r -d '' file; do
      overrides+=(-v "$file:/app/${file#"$artifact/baseline/"}:ro")
    done < <(rg --files -0 "$artifact/baseline" -g '*.js' -g '*.html')
  fi
  docker run --rm --network "$network" --ipc=host --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e DISPATCH_PLANNER_ORDER_POOL_MODE=off \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    -v "$repo_root/server/src:/app/src:ro" -v "$repo_root/server/public:/app/public:ro" \
    -v "$repo_root/server/test:/app/test:ro" -v "$repo_root/server/migrations:/app/migrations:ro" \
    -v "$repo_root/server/tools:/app/tools:ro" -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
    "${overrides[@]}" \
    --entrypoint "$1" "$image" "${@:2}"
}
run npm run migrate > "$artifact/migrate.log" 2>&1
run "${@:-node}"

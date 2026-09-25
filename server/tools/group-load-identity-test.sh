#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
network="mbbs-group-load-identity-$(date +%s)-$$"
database="$network-db"
artifact="$repo_root/server/test-artifacts/group-load-identity"
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
for directory in src public test migrations tools contracts; do
  mounts+=(-v "$repo_root/server/$directory:/app/$directory:ro")
done
for file in "$repo_root/server"/*.json "$repo_root/server"/*.js; do
  mounts+=(-v "$file:/app/$(basename "$file"):ro")
done
if [[ "${GROUP_LOAD_IDENTITY_BASELINE:-0}" == "1" ]]; then
  for file in co-source-packing-handoff.js delivery-repository.js; do
    mounts+=(-v "$artifact/baseline/src/$file:/app/src/$file:ro")
  done
fi
run() {
  docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
    -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent -e NODE_ENV=test \
    -e DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test \
    "${mounts[@]}" -v "$repo_root/server/test-artifacts:/app/test-artifacts" \
    --entrypoint "$1" mbbs-retired-confirm-test:20260914 "${@:2}"
}
run npm run migrate > "$artifact/migrate.log" 2>&1
run "$@"

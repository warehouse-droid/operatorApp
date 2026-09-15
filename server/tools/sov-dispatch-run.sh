#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/sov-dispatch"
network=mbbs-sov-dispatch
database=mbbs-sov-dispatch-db
image=mbbs-retired-confirm-test:20260914
mkdir -p "$artifact/final"
docker network inspect "$network" >/dev/null 2>&1 || docker network create --internal "$network" >/dev/null
if ! docker inspect "$database" >/dev/null 2>&1; then
  docker run -d --name "$database" --network "$network" --network-alias db \
    --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=mbt_test_password \
    -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
fi
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
source_root="$repo_root/server"
if [[ "${SOV_BASELINE:-0}" == 1 ]]; then source_root="$artifact/baseline"; fi
docker run --rm --network "$network" --user "$(id -u):$(id -g)" \
  -e MBT_TEST_ISOLATED=1 -e MBT_ENABLED=true -e MBBS_ENV_FILE=/nonexistent \
  -e MBBS_REPO_ROOT=/workspace -e MBBS_SERVER_ROOT=/app \
  -e "DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/${SOV_TEST_DATABASE:-mbt_test}" \
  -v "$repo_root:/workspace:ro" -v "$source_root/src:/app/src:ro" \
  -v "$source_root/public:/app/public:ro" -v "$repo_root/server/test:/app/test:ro" \
  -v "$repo_root/server/tools:/app/tools:ro" -v "$repo_root/server/migrations:/app/migrations:ro" \
  -v "$repo_root/server/package.json:/app/package.json:ro" \
  -v "$artifact:/app/test-artifacts/sov-dispatch" \
  --entrypoint "$1" "$image" "${@:2}"

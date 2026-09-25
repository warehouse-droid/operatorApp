#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_artifacts="${FIELD_SALES_ARTIFACT_DIR:-$field_root/test-artifacts/field-sales/final}"
mkdir -p "$field_artifacts"
field_artifacts="$(cd "$field_artifacts" && pwd)"
field_tag="field-sales-check-$$"
field_image="${FIELD_SALES_TEST_IMAGE:-$field_tag}"
field_context="$(mktemp -d /tmp/field-sales-build.XXXXXX)"
cleanup() {
  docker rm -f "$field_tag-runner" "$field_tag-db" >/dev/null 2>&1 || true
  docker network rm "$field_tag" >/dev/null 2>&1 || true
  rm -rf "$field_context"
}
trap cleanup EXIT
if [[ -z "${FIELD_SALES_TEST_IMAGE:-}" ]]; then
  cd "$field_root"
  tar -cf - Dockerfile Dockerfile.test Dockerfile.scm-ir-split-reference .c8rc.json .env.example eslint.mbt.config.js eslint.driver-offline-stress.config.js tsconfig.mbt.json package.json package-lock.json contracts migrations public src test tools ./*.js | tar -xf - -C "$field_context"
  docker build --target test-e2e -f "$field_context/Dockerfile.test" -t "$field_image" "$field_context" > "$field_artifacts/build.log" 2>&1
fi
docker network create "$field_tag" >/dev/null
docker run -d --name "$field_tag-db" --network "$field_tag" --network-alias db --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=field_sales_test_only -e POSTGRES_DB=mbt_test postgres:18-alpine >/dev/null
for field_attempt in $(seq 1 60); do
  if docker exec "$field_tag-db" pg_isready -U mbt_test -d mbt_test >/dev/null 2>&1; then break; fi
  sleep 1
done
field_mounts=()
for field_directory in src public test tools migrations contracts; do
  field_mounts+=(-v "$field_root/$field_directory:/app/$field_directory:ro")
done
for field_file in "$field_root"/*.js "$field_root"/*.json "$field_root"/Dockerfile "$field_root"/Dockerfile.test; do
  field_mounts+=(-v "$field_file:/app/$(basename "$field_file"):ro")
done
docker run -d --name "$field_tag-runner" --network "$field_tag" --shm-size=512m --user root \
  -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e MBBS_REPO_ROOT=/workspace -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false \
  -e FIELD_SALES_NETSUITE_WRITES_ENABLED=false -e FIELD_SALES_ARTIFACT_DIR=/artifacts \
  -e DATABASE_URL=postgres://mbt_test:field_sales_test_only@db:5432/mbt_test \
  "${field_mounts[@]}" \
  -v "$field_root/..:/workspace:ro" -v "$field_artifacts:/artifacts" \
  --entrypoint sleep "$field_image" infinity >/dev/null
docker exec "$field_tag-runner" node src/migrate.js > "$field_artifacts/migrations.log" 2>&1
docker exec "$field_tag-db" psql -U mbt_test -d postgres -c 'CREATE DATABASE mbt_test_field_sales TEMPLATE mbt_test;' > "$field_artifacts/database.log"
docker exec -e DATABASE_URL=postgres://mbt_test:field_sales_test_only@db:5432/mbt_test_field_sales "$field_tag-runner" node tools/field-sales-checks.mjs | tee "$field_artifacts/gauntlet.log"

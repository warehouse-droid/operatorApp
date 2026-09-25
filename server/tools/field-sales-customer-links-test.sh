#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_name="field-sales-customer-links-check"
field_image="${FIELD_SALES_TEST_IMAGE:-field-sales-check-2941306}"
field_artifacts="$field_root/test-artifacts/field-sales/customer-links"
mkdir -p "$field_artifacts"
case "${1:-test}" in
 start)
  docker network create --internal "$field_name" >/dev/null
  docker run -d --name "$field_name-db" --network "$field_name" --network-alias db --tmpfs /var/lib/postgresql -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=field_sales_test_only -e POSTGRES_DB=mbt_test_field_sales postgres:18-alpine >/dev/null
  for attempt in $(seq 1 60); do
   if docker exec "$field_name-db" pg_isready -U mbt_test -d mbt_test_field_sales >/dev/null 2>&1; then break; fi
   sleep 1
  done
  mounts=()
  for folder in src public migrations test tools contracts; do mounts+=(-v "$field_root/$folder:/app/$folder:ro"); done
  docker run -d --name "$field_name-runner" --network "$field_name" --shm-size=512m --user root \
   -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
   -e DATABASE_URL=postgres://mbt_test:field_sales_test_only@db:5432/mbt_test_field_sales \
   -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled -e SAMSARA_WRITES_ENABLED=false \
   -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false -e FIELD_SALES_NETSUITE_WRITES_ENABLED=false \
   -e FIELD_SALES_ARTIFACT_DIR=/artifacts "${mounts[@]}" \
   -v "$field_root/netsuite-field-sales-restlet.js:/app/netsuite-field-sales-restlet.js:ro" \
   -v "$field_root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
   -v "$field_artifacts:/artifacts" --entrypoint sleep "$field_image" infinity >/dev/null
  docker exec "$field_name-runner" node src/migrate.js > "$field_artifacts/migrations.log" 2>&1
  ;;
 stop) docker rm -f "$field_name-runner" "$field_name-db" >/dev/null; docker network rm "$field_name" >/dev/null ;;
 exec) shift; docker exec "$field_name-runner" "$@" ;;
 test) shift; docker exec "$field_name-runner" node --test --test-concurrency=1 "$@" ;;
 *) exit 2 ;;
esac

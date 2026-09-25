#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_tag="field-sales-recent-check-$$"
field_artifacts="${FIELD_SALES_ARTIFACT_DIR:-$field_root/test-artifacts/field-sales/recent}"
mkdir -p "$field_artifacts"
cleanup() {
  docker rm -f "$field_tag-runner" "$field_tag-db" >/dev/null 2>&1 || true
  docker network rm "$field_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$field_tag" >/dev/null
docker run -d --name "$field_tag-db" --network "$field_tag" --network-alias db --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=mbt_test -e POSTGRES_PASSWORD=field_sales_test_only -e POSTGRES_DB=mbt_test_field_sales postgres:18-alpine >/dev/null
for field_attempt in $(seq 1 60); do
  if docker exec "$field_tag-db" pg_isready -U mbt_test -d mbt_test_field_sales >/dev/null 2>&1; then break; fi
  sleep 1
done
field_env=(-e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e DATABASE_URL=postgres://mbt_test:field_sales_test_only@db:5432/mbt_test_field_sales \
  -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled -e SAMSARA_WRITES_ENABLED=false \
  -e SMART_SCM_LIVE_EXECUTION_ENABLED=false -e MBT_NETSUITE_WRITES_ENABLED=false -e FIELD_SALES_NETSUITE_WRITES_ENABLED=false)
field_mounts=()
for field_dir in src public migrations test tools contracts; do
  field_mounts+=(-v "$field_root/$field_dir:/app/$field_dir:ro")
done
field_mounts+=(-v "$field_root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro")
docker run -d --name "$field_tag-runner" --network "$field_tag" --shm-size=512m --user root \
  "${field_env[@]}" -e FIELD_SALES_ARTIFACT_DIR=/artifacts "${field_mounts[@]}" -v "$field_artifacts:/artifacts" \
  --entrypoint sleep "${FIELD_SALES_TEST_IMAGE:-field-sales-check-2941306}" infinity >/dev/null
docker exec "$field_tag-runner" node src/migrate.js > "$field_artifacts/migrations.log" 2>&1
docker exec "$field_tag-runner" node_modules/.bin/eslint --config tools/field-sales-eslint.config.mjs src/field-sales public/field-sales test/field-sales/recent*.js tools/field-sales-recent-*.mjs > "$field_artifacts/lint.log" 2>&1
docker exec "$field_tag-runner" node_modules/.bin/tsc --allowJs --checkJs --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck public/field-sales/domain.js public/field-sales/lead-policy.js src/field-sales/lead-filters.js > "$field_artifacts/types.log" 2>&1
docker exec "$field_tag-runner" node --test test/field-sales/recent.test.js > "$field_artifacts/recent.log" 2>&1
if [[ "${1:-}" == "recent-only" ]]; then cat "$field_artifacts/recent.log"; exit 0; fi
docker exec "$field_tag-runner" node tools/field-sales-recent-browser.mjs > "$field_artifacts/recent-browser.log" 2>&1
if [[ "${1:-}" == "browser-only" ]]; then cat "$field_artifacts/recent-browser.log"; exit 0; fi
docker exec "$field_tag-runner" node --test --test-concurrency=1 $(cd "$field_root" && rg --files test/field-sales -g '*.test.js' | sort) > "$field_artifacts/focused.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-map-browser.mjs > "$field_artifacts/map-browser.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-browser.mjs > "$field_artifacts/browser.log" 2>&1
docker exec "$field_tag-runner" node_modules/.bin/c8 --all --include=src/field-sales/repository.js --include=src/field-sales/lead-filters.js --include=public/field-sales/lead-policy.js --reporter=text --reporter=json-summary --reporter=json --report-dir=/artifacts/coverage --temp-directory=/artifacts/v8 node --test --test-concurrency=1 $(cd "$field_root" && rg --files test/field-sales -g '*.test.js' | sort) > "$field_artifacts/coverage.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-recent-mutations.mjs > "$field_artifacts/mutations.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-recent-health.mjs > "$field_artifacts/health.log" 2>&1
cat "$field_artifacts/recent.log"

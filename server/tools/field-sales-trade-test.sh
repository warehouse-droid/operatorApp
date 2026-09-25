#!/usr/bin/env bash
set -Eeuo pipefail
field_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
field_tag="field-sales-trade-check-$$"
field_artifacts="${FIELD_SALES_ARTIFACT_DIR:-$field_root/test-artifacts/field-sales/trade}"
mkdir -p "$field_artifacts"
docker run --rm --network none --user root -v "$field_artifacts:/artifacts" --entrypoint rm "${FIELD_SALES_TEST_IMAGE:-field-sales-check-2941306}" -rf /artifacts/v8 /artifacts/coverage
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
field_mounts=(-v "$field_root/test-artifacts/field-sales/trade-baseline:/baseline:ro")
for field_dir in src public migrations test tools contracts; do
  field_mounts+=(-v "$field_root/$field_dir:/app/$field_dir:ro")
done
field_mounts+=(-v "$field_root/netsuite-field-sales-restlet.js:/app/netsuite-field-sales-restlet.js:ro")
field_mounts+=(-v "$field_root/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro")
docker run -d --name "$field_tag-runner" --network "$field_tag" --shm-size=512m --user root \
  "${field_env[@]}" -e FIELD_SALES_ARTIFACT_DIR=/artifacts "${field_mounts[@]}" -v "$field_artifacts:/artifacts" \
  --entrypoint sleep "${FIELD_SALES_TEST_IMAGE:-field-sales-check-2941306}" infinity >/dev/null
docker exec "$field_tag-runner" node src/migrate.js > "$field_artifacts/migrations.log" 2>&1
if [[ "${1:-}" == "quote-ui" ]]; then
  docker exec "$field_tag-runner" node_modules/.bin/eslint --config tools/field-sales-eslint.config.mjs public/field-sales tools/field-sales-trade-browser.mjs tools/field-sales-browser.mjs > "$field_artifacts/lint.log" 2>&1
  docker exec "$field_tag-runner" node tools/field-sales-trade-browser.mjs > "$field_artifacts/trade-browser.log" 2>&1
  docker exec "$field_tag-runner" node tools/field-sales-browser.mjs > "$field_artifacts/browser.log" 2>&1
  exit 0
fi
if [[ "${1:-}" == "browser-only" ]]; then
  docker exec "$field_tag-runner" node tools/field-sales-trade-browser.mjs > "$field_artifacts/trade-browser.log" 2>&1
  exit 0
fi
docker exec "$field_tag-runner" node --test --test-concurrency=1 $(cd "$field_root" && { if command -v rg >/dev/null; then rg --files test/field-sales -g '*.test.js'; else find test/field-sales -type f -name '*.test.js'; fi; } | sort) > "$field_artifacts/focused.log" 2>&1
if [[ "${1:-}" == "tests-only" ]]; then cat "$field_artifacts/focused.log"; exit 0; fi
docker exec "$field_tag-runner" node_modules/.bin/eslint --config tools/field-sales-eslint.config.mjs src/field-sales public/field-sales test/field-sales/trade*.js test/field-sales/catalog.test.js tools/field-sales-trade-*.mjs netsuite-field-sales-restlet.js > "$field_artifacts/lint.log" 2>&1
docker exec "$field_tag-runner" node_modules/.bin/tsc --allowJs --checkJs --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck public/field-sales/domain.js public/field-sales/pricing.js > "$field_artifacts/types.log" 2>&1
docker exec "$field_tag-runner" node_modules/.bin/eslint --config tools/field-sales-eslint.config.mjs --rule 'complexity:[error,25]' src/field-sales/catalog.js src/field-sales/netsuite-catalog.js public/field-sales/pricing.js public/field-sales/item-autocomplete.js > "$field_artifacts/complexity.log" 2>&1
for field_browser in trade visiting recent map ''; do
  field_script="tools/field-sales-${field_browser:+$field_browser-}browser.mjs"
  docker exec "$field_tag-runner" node "$field_script" > "$field_artifacts/${field_browser:-original}-browser.log" 2>&1
done
docker exec "$field_tag-runner" node_modules/.bin/c8 --clean=false --all --include=src/field-sales/**/*.js --include=public/field-sales/pricing.js --include=public/field-sales/domain.js --reporter=text --reporter=json --reporter=json-summary --report-dir=/artifacts/coverage --temp-directory=/artifacts/v8 node --test --test-concurrency=1 $(cd "$field_root" && { if command -v rg >/dev/null; then rg --files test/field-sales -g '*.test.js'; else find test/field-sales -type f -name '*.test.js'; fi; } | sort) > "$field_artifacts/coverage.log" 2>&1
# UI coverage is a new diagnostic; retain the existing strict server thresholds above.
docker exec "$field_tag-runner" node_modules/.bin/c8 report --all --check-coverage=false --include=public/field-sales/quotes.js --include=public/field-sales/item-autocomplete.js --reporter=text --reporter=json --reporter=json-summary --report-dir=/artifacts/ui-coverage --temp-directory=/artifacts/v8 > "$field_artifacts/ui-coverage.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-trade-coverage.mjs > "$field_artifacts/changed-lines.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-trade-mutations.mjs > "$field_artifacts/mutations.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-recent-health.mjs > "$field_artifacts/health.log" 2>&1
docker exec "$field_tag-runner" node tools/field-sales-trade-evidence.mjs > "$field_artifacts/evidence.log" 2>&1
cat "$field_artifacts/focused.log"

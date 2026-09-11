#!/usr/bin/env bash
set -euo pipefail
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_artifacts="$task_root/test-artifacts/schedule-columns"
task_cache=${SCM_BROWSER_CACHE:-"$task_artifacts/browser-cache"}
mkdir -p "$task_artifacts" "$task_cache"
chmod a+rwx "$task_artifacts"
cd "$task_root"

docker build -f test/support/Dockerfile.schedule-columns -t mbbs-schedule-columns-test:20260910 .
if ! compgen -G "$task_cache/chromium-*/chrome-linux64/chrome" > /dev/null; then
  docker run --rm --network bridge --user root -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -v "$task_cache:/ms-playwright" --entrypoint npx mbbs-schedule-columns-test:20260910 playwright install chromium
fi

task_mounts=(-v "$task_root/public:/app/public:ro" -v "$task_root/src:/app/src:ro"
  -v "$task_root/test:/app/test:ro" -v "$task_root/test/support:/app/test/support:ro"
  -v "$task_artifacts:/app/test-artifacts/schedule-columns"
  -v "$task_cache:/ms-playwright:ro")

docker run --rm --network none "${task_mounts[@]}" --entrypoint node mbbs-schedule-columns-test:20260910 \
  --test --test-concurrency=1 src/scm-schedule-column-filter-harness.js src/scm-schedule-row-refresh-harness.js \
  test/dispatch/frontend/scm-schedule-status-save.test.js test/dispatch/frontend/scm-schedule-remarks-ui.red.test.js \
  test/dispatch/frontend/scm-schedule-column-preferences.test.js

docker run --rm --network none --shm-size 256m "${task_mounts[@]}" \
  -e SCHEDULE_SCREENSHOT_DIR=/app/test-artifacts/schedule-columns --entrypoint node mbbs-schedule-columns-test:20260910 \
  --test --test-concurrency=1 test/dispatch/frontend/scm-schedule-columns.browser.test.mjs
docker run --rm --network none --shm-size 256m "${task_mounts[@]}" --entrypoint node mbbs-schedule-columns-test:20260910 \
  test/support/run-schedule-column-mutations.mjs

# This harness requires PostgreSQL. Its isolated database contains schema only.
task_db=$(docker run -d --rm --network none --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=schedule_test -e POSTGRES_PASSWORD=schedule_test_only -e POSTGRES_DB=schedule_test \
  -v "$task_root/migrations/001_baseline_current_schema.sql:/docker-entrypoint-initdb.d/001.sql:ro" \
  -v "$task_root/migrations/014_scm_transport_schedule.sql:/docker-entrypoint-initdb.d/014.sql:ro" \
  -v "$task_root/migrations/083_scm_schedule_formatting.sql:/docker-entrypoint-initdb.d/083.sql:ro" postgres:18-alpine)
trap 'docker rm -f "$task_db" >/dev/null 2>&1 || true' EXIT
task_ready=false
for task_attempt in {1..40}; do
  if docker exec "$task_db" psql -h 127.0.0.1 -U schedule_test -d schedule_test -Atc \
    "SELECT count(*) FROM scm_schedule_formatting_settings" >/dev/null 2>&1; then
    task_ready=true
    break
  fi
  sleep 1
done
if [[ "$task_ready" != true ]]; then docker logs "$task_db"; exit 1; fi
docker run --rm --network "container:$task_db" "${task_mounts[@]}" \
  -e DATABASE_URL=postgresql://schedule_test:schedule_test_only@127.0.0.1:5432/schedule_test \
  --entrypoint node mbbs-schedule-columns-test:20260910 src/scm-schedule-formatting-harness.js

docker run --rm --network none "${task_mounts[@]}" --entrypoint node mbbs-schedule-columns-test:20260910 --check public/scm-schedule.js
docker run --rm --network none "${task_mounts[@]}" --entrypoint npx mbbs-schedule-columns-test:20260910 \
  eslint --no-config-lookup --no-ignore --rule 'no-unreachable:error' --rule 'no-dupe-args:error' \
  --rule 'no-dupe-keys:error' --rule 'valid-typeof:error' public/scm-schedule.js \
  test/dispatch/frontend/scm-schedule-column-preferences.test.js \
  test/dispatch/frontend/scm-schedule-columns.browser.test.mjs test/support/run-schedule-column-mutations.mjs
git diff --check -- public/scm-schedule.js public/dispatch.css public/scm-schedule.html test/dispatch/frontend/scm-schedule-remarks-ui.red.test.js
sha256sum public/scm-schedule.js public/dispatch.css public/scm-schedule.html

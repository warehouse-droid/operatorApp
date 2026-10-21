#!/usr/bin/env bash
set -euo pipefail
driver_upload_repo=$(cd "$(dirname "$0")/../.." && pwd)
driver_upload_phase=${1:-final}
driver_upload_artifacts="$driver_upload_repo/server/test-artifacts/driver-upload-reliability"
mkdir -p "$driver_upload_artifacts"
mkdir -p "$driver_upload_artifacts/toolchain/node_modules"
driver_upload_container="mbbs-driver-upload-unit-$$"
cleanup_driver_upload_unit() {
  docker rm -f "$driver_upload_container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$driver_upload_artifacts/$driver_upload_phase-docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$driver_upload_artifacts/$driver_upload_phase-docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$driver_upload_artifacts/$driver_upload_phase-production-health.txt"
}
trap cleanup_driver_upload_unit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
driver_upload_command='node --test --test-concurrency=1 test/mbt/unit/driver-upload-*.test.js test/mbt/unit/driver-pwa-recovery-assets.test.js test/mbt/property/driver-upload-progress.test.js'
if [[ "$driver_upload_phase" == baseline ]]; then
  driver_upload_command='set --; for driver_test_file in test/mbt/unit/driver-*.test.js; do case "$driver_test_file" in *driver-upload-*) continue ;; esac; set -- "$@" "$driver_test_file"; done; node --test --test-concurrency=1 "$@"'
fi
if [[ "$driver_upload_phase" == inspect ]]; then
  driver_upload_command='find / -maxdepth 4 -type d -name node_modules 2>/dev/null; command -v node'
fi
driver_upload_network=none
driver_upload_extra_mounts=()
if [[ "$driver_upload_phase" == install ]]; then
  cp "$driver_upload_repo/server/package.json" "$driver_upload_repo/server/package-lock.json" "$driver_upload_artifacts/toolchain/"
  driver_upload_network=bridge
  driver_upload_command='cd /toolchain && npm ci --ignore-scripts --include=dev --no-audit --no-fund --cache /tmp/npm-cache'
fi
if [[ "$driver_upload_phase" == quality ]]; then
  driver_upload_command='node --check public/driver.js && node --check public/driver-upload.js && node --check src/server.js && node node_modules/eslint/bin/eslint.js --config eslint.driver-upload.config.mjs --max-warnings=0 public/driver-upload.js src/driver-upload-failure.js src/driver-upload-failure-repository.js test/mbt/unit/driver-upload-*.test.js test/mbt/property/driver-upload-progress.test.js test/mbt/integration/driver-upload-failure-http.test.js test/support/driver-upload-*.mjs test/driver-upload/*.js test/driver-upload.playwright.config.mjs && node node_modules/typescript/bin/tsc --project test/driver-upload-types.json && node node_modules/typescript/bin/tsc --project tsconfig.mbt.json --noEmit'
fi
if [[ "$driver_upload_phase" == quality-focused ]]; then
  driver_upload_command='node --check public/driver.js && node --check public/driver-upload.js && node --check public/driver-service-worker.js && node --check src/server.js && node node_modules/eslint/bin/eslint.js --config eslint.driver-upload.config.mjs --max-warnings=0 public/driver-upload.js src/driver-upload-failure.js src/driver-upload-failure-repository.js test/mbt/unit/driver-upload-*.test.js test/mbt/property/driver-upload-progress.test.js test/mbt/integration/driver-upload-failure-http.test.js test/support/driver-upload-*.mjs test/driver-upload/*.js test/driver-upload.playwright.config.mjs tools/driver-upload-*.mjs && node node_modules/typescript/bin/tsc --project test/driver-upload-types.json'
fi
if [[ "$driver_upload_phase" == repository-types ]]; then
  driver_upload_command='node node_modules/typescript/bin/tsc --project tsconfig.mbt.json --noEmit'
fi
if [[ "$driver_upload_phase" == baseline-types ]]; then
  driver_upload_command='node node_modules/typescript/bin/tsc --project tsconfig.mbt.json --noEmit'
  for driver_baseline_file in public/driver.js public/driver.html public/driver.css public/driver-service-worker.js src/server.js src/driver-client-version.js; do
    driver_upload_extra_mounts+=(--mount "type=bind,source=$driver_upload_artifacts/baseline/$driver_baseline_file,target=/app/$driver_baseline_file,readonly")
  done
fi
if [[ "$driver_upload_phase" == coverage ]]; then
  driver_upload_command='node node_modules/c8/bin/c8.js --all=false --include=public/driver-upload.js --include=src/driver-upload-failure.js --temp-directory=/app/test-artifacts/coverage-unit/raw --reports-dir=/app/test-artifacts/coverage-unit --reporter=text --reporter=json --reporter=json-summary node --test --test-concurrency=1 test/mbt/unit/driver-upload-*.test.js test/mbt/unit/driver-pwa-recovery-assets.test.js test/mbt/property/driver-upload-progress.test.js; driver_upload_status=$?; chmod -R a+rX /app/test-artifacts/coverage-unit/raw; exit "$driver_upload_status"'
fi
if [[ "$driver_upload_phase" == mutations ]]; then
  driver_upload_command='node tools/driver-upload-mutations.mjs'
fi
if [[ "$driver_upload_phase" == secrets ]]; then
  driver_upload_command='node test/support/scan-diff-secrets.mjs public/driver-upload.js src/driver-upload-failure.js src/driver-upload-failure-repository.js src/driver-seven-day-replay-harness.js migrations/282_driver_upload_failure_audit.sql test/mbt/unit/driver-upload-reliability.test.js test/mbt/unit/driver-upload-failure.test.js test/mbt/unit/driver-upload-lifecycle.test.js test/mbt/unit/driver-upload-request.test.js test/mbt/integration/driver-upload-failure-http.test.js test/mbt/property/driver-upload-progress.test.js test/driver-upload test/driver-upload.playwright.config.mjs test/support/driver-upload-fixtures.mjs test/support/driver-upload-worker-fixture.mjs test/support/driver-upload-browser-fixture.mjs tools/driver-upload-gauntlet.sh tools/driver-upload-unit-check.sh tools/driver-upload-verify-all.sh tools/driver-upload-history-corpus.mjs tools/driver-upload-mutations.mjs tools/driver-upload-regressions.mjs tools/capture-driver-upload-history.py --unified-diff test-artifacts/task-source.diff'
fi
docker run --rm --pull=never --name "$driver_upload_container" --label com.mbbs.lifecycle=disposable-test --cgroup-parent=mbbs-tests.slice --init --memory=2g --memory-swap=2g --cpus=1 --pids-limit=256 --read-only --network="$driver_upload_network" --tmpfs /tmp:rw,nosuid,nodev,size=512m --tmpfs /app/data:rw,nosuid,nodev,size=32m --env NODE_ENV=test --env MBT_TEST_ISOLATED=1 --env MBBS_ENV_FILE=/tmp/does-not-exist --env DATABASE_URL=postgres://fixture:fixture@127.0.0.1:9/mbt_test --mount "type=bind,source=$driver_upload_repo/server/public,target=/app/public,readonly" --mount "type=bind,source=$driver_upload_repo/server/src,target=/app/src,readonly" --mount "type=bind,source=$driver_upload_repo/server/test,target=/app/test,readonly" --mount "type=bind,source=$driver_upload_repo/server/migrations,target=/app/migrations,readonly" --mount "type=bind,source=$driver_upload_repo/server/tools,target=/app/tools,readonly" --mount "type=bind,source=$driver_upload_repo/server/eslint.driver-upload.config.mjs,target=/app/eslint.driver-upload.config.mjs,readonly" --mount "type=bind,source=$driver_upload_repo/server/tsconfig.mbt.json,target=/app/tsconfig.mbt.json,readonly" --mount "type=bind,source=$driver_upload_artifacts,target=/app/test-artifacts" --mount "type=bind,source=$driver_upload_artifacts/toolchain/node_modules,target=/app/node_modules,readonly" --mount "type=bind,source=$driver_upload_artifacts/toolchain,target=/toolchain" "${driver_upload_extra_mounts[@]}" --workdir /app --entrypoint sh mbbs-to-yard-test-browser:20261009 -c "$driver_upload_command" 2>&1 | tee "$driver_upload_artifacts/$driver_upload_phase-unit.log"

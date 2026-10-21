#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
artifact="$root/server/test-artifacts/dispatch-save-after-2967-20261008"
mkdir -p "$artifact/verification"
name="mbbs-dispatch-open-gauntlet-$$"
deps="$name-deps"
image="sha256:265ccc84fdc677cb795f84cbf4d8a12a94ef2d290e3b6d3ded131a752bd5a749"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$deps" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  curl -fsS http://127.0.0.1:3000/health >/dev/null
}
trap cleanup EXIT INT TERM
docker volume create --label com.mbbs.lifecycle=disposable-test "$deps" >/dev/null
base=(docker run --rm --init --name "$name" --label com.mbbs.lifecycle=disposable-test
  --cgroup-parent=mbbs-tests.slice --cpus=1 --memory=2g --memory-swap=2g --pids-limit=256
  --read-only --tmpfs /tmp:rw,size=512m --workdir /app
  --env NODE_ENV=test --env MBT_TEST_ISOLATED=1 --env MBBS_ENV_FILE=/tmp/no-env
  --mount "type=volume,src=$deps,dst=/app/node_modules"
  --mount "type=bind,src=$root/server/package.json,dst=/app/package.json,readonly"
  --mount "type=bind,src=$root/server/package-lock.json,dst=/app/package-lock.json,readonly")
"${base[@]}" --user 0 --entrypoint npm "$image" ci --ignore-scripts --no-audit --no-fund --cache=/tmp/npm >"$artifact/verification/dependencies.log" 2>&1
for dir in public src test tools contracts; do
  base+=(--mount "type=bind,src=$root/server/$dir,dst=/app/$dir,readonly")
done
base+=(--network none --mount "type=bind,src=$artifact/verification,dst=/app/test-artifacts/dispatch-open-recovery"
  --mount "type=bind,src=$root/server/eslint.mbt.config.js,dst=/app/eslint.mbt.config.js,readonly"
  --mount "type=bind,src=$artifact/baseline/public/dispatch.js,dst=/baseline/dispatch.js,readonly")
"${base[@]}" --mount "type=bind,src=$artifact/baseline/public/dispatch.js,dst=/app/public/dispatch.js,readonly" \
  --entrypoint sh "$image" -c 'node --test --test-concurrency=1 $(find test/dispatch/frontend -maxdepth 1 -name "*.test.js" ! -name "dispatch-plan-open-recovery.test.js" | sort)' \
  >"$artifact/verification/frontend-baseline.log" 2>&1 || baseline_status=$?
echo "frontend baseline exit: ${baseline_status:-0}"
"${base[@]}" --env NODE_V8_COVERAGE=/app/test-artifacts/dispatch-open-recovery/v8 \
  --entrypoint sh "$image" -c 'node --test --test-concurrency=1 test/dispatch/frontend/*.test.js' \
  >"$artifact/verification/frontend-final.log" 2>&1 || final_status=$?
echo "frontend final exit: ${final_status:-0}"
"${base[@]}" --entrypoint node "$image" tools/dispatch-plan-open-recovery-checks.mjs \
  >"$artifact/verification/checks.log" 2>&1
cat "$artifact/verification/checks.log"

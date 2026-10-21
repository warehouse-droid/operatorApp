#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="mbbs-dispatch-open-recovery-$$"
image="sha256:265ccc84fdc677cb795f84cbf4d8a12a94ef2d290e3b6d3ded131a752bd5a749"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --filter label=com.mbbs.lifecycle=disposable-test --format '{{.Names}} {{.Status}}'
}
trap cleanup EXIT INT TERM
docker run --rm --init --name "$name" --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --cpus=2 --memory=1g --memory-swap=1g --pids-limit=128 \
  --read-only --network=none --tmpfs /tmp:rw,size=128m --workdir /app \
  --mount "type=bind,src=$root/server/public,dst=/app/public,readonly" \
  --mount "type=bind,src=$root/server/test/dispatch/frontend/dispatch-plan-open-recovery.test.js,dst=/app/test/dispatch/frontend/dispatch-plan-open-recovery.test.js,readonly" \
  --entrypoint node "$image" --test test/dispatch/frontend/dispatch-plan-open-recovery.test.js

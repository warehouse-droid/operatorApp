#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-lint}"
case "$mode" in types|lint) ;; *) exit 64 ;; esac
artifacts="$server_root/test-artifacts/delivery-requests"
test_name="mbbs-delivery-quality-$mode"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker rm -fv "$test_name" > "$artifacts/quality-teardown-$mode.log" 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$artifacts/quality-ps-$mode.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifacts/quality-ps-a-$mode.log"
  if docker ps -a --filter "name=^/$test_name$" --format '{{.Names}}' | rg -q .; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --init --name "$test_name" --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --memory=1g --memory-swap=1g --cpus=0.5 --pids-limit=256 \
  --network=none --read-only --tmpfs /tmp:rw,nosuid,noexec,size=64m \
  --mount "type=bind,src=$server_root/src,dst=/app/src,readonly" \
  --mount "type=bind,src=$server_root/public,dst=/app/public,readonly" \
  --mount "type=bind,src=$server_root/test,dst=/app/test,readonly" \
  --mount "type=bind,src=$server_root/tools,dst=/app/tools,readonly" \
  --mount "type=bind,src=$artifacts,dst=/app/test-artifacts/delivery-requests" \
  mbbs-delivery-requests:baseline node tools/delivery-request-quality.mjs "$mode" > "$artifacts/feature-$mode.log" 2>&1

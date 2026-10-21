#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scope="${1:-implementation}"
case "$scope" in implementation|tests) ;; *) exit 64 ;; esac
artifacts="$server_root/test-artifacts/delivery-requests"
test_name="mbbs-delivery-format-$scope"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker rm -fv "$test_name" > "$artifacts/format-teardown-$scope.log" 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$artifacts/format-ps-$scope.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifacts/format-ps-a-$scope.log"
  if docker ps -a --filter "name=^/$test_name$" --format '{{.Names}}' | rg -q .; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --init --name "$test_name" --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --memory=512m --memory-swap=512m --cpus=0.5 --pids-limit=256 \
  --network=none --read-only --tmpfs /tmp:rw,nosuid,noexec,size=64m \
  --mount "type=bind,src=$server_root/src,dst=/app/src,readonly" \
  --mount "type=bind,src=$server_root/public,dst=/app/public,readonly" \
  --mount "type=bind,src=$server_root/test,dst=/app/test,readonly" \
  --mount "type=bind,src=$server_root/tools,dst=/app/tools,readonly" \
  --mount "type=bind,src=$artifacts,dst=/app/test-artifacts/delivery-requests" \
  mbbs-delivery-requests:baseline node tools/delivery-request-format.mjs "$scope" > "$artifacts/format-$scope.log" 2>&1

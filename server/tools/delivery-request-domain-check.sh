#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
phase="${1:-green}"
test_path="${2:-test/mbt/unit/delivery-request-domain.test.js}"
test_memory=512m
if [[ "$test_path" == *browser* ]]; then test_memory=1g; fi
artifacts="$server_root/test-artifacts/delivery-requests"
mkdir -p "$artifacts"
test_name="mbbs-delivery-domain-$phase"
stub_file=''
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker rm -fv "$test_name" > "$artifacts/domain-teardown-$phase.log" 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$artifacts/domain-ps-$phase.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifacts/domain-ps-a-$phase.log"
  if docker ps -a --filter "name=^/$test_name$" --format '{{.Names}}' | rg -q .; then status=1; fi
  if [[ -n "$stub_file" ]]; then rm -f -- "$stub_file"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
extra_mounts=()
domain_source="$server_root/src/delivery-request-domain.js"
expiry_source="$server_root/src/delivery-request-expiry.js"
if [[ "$phase" == properties-red ]]; then domain_source="$server_root/test/mbt/support/delivery-request-domain-stub.js"; fi
if [[ "$phase" == browser-behavior-red ]]; then
  stub_file="$(mktemp /tmp/mbbs-delivery-ui-stub.XXXXXX)"
  printf '%s\n' '// Not implemented.' > "$stub_file"
  extra_mounts+=(--mount "type=bind,src=$stub_file,dst=/app/public/delivery-requests.js,readonly")
  extra_mounts+=(--mount "type=bind,src=$stub_file,dst=/app/public/delivery-request-alert.js,readonly")
fi
if [[ "$phase" == expiry-red ]]; then expiry_source="$server_root/test/mbt/support/delivery-request-expiry-stub.js"; fi
docker run --rm --init --name "$test_name" --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --memory="$test_memory" --memory-swap="$test_memory" --cpus=0.5 --pids-limit=256 \
  --network=none --read-only --tmpfs /tmp:rw,nosuid,noexec,size=64m \
  --mount "type=bind,src=$server_root/src,dst=/app/src,readonly" \
  --mount "type=bind,src=$server_root/test,dst=/app/test,readonly" \
  --mount "type=bind,src=$domain_source,dst=/app/src/delivery-request-domain.js,readonly" \
  --mount "type=bind,src=$expiry_source,dst=/app/src/delivery-request-expiry.js,readonly" \
  --mount "type=bind,src=$server_root/public,dst=/app/public,readonly" \
  --mount "type=bind,src=$artifacts,dst=/app/test-artifacts/delivery-requests" \
  "${extra_mounts[@]}" \
  mbbs-delivery-requests:baseline node --test "$test_path" \
  > "$artifacts/domain-$phase.log" 2>&1

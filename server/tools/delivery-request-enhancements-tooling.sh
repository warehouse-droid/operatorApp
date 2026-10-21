#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
artifact="$repo_root/server/test-artifacts/delivery-enhancements-20261013"
toolchain="$artifact/toolchain"
container="mbbs-delivery-enhancements-tooling"
mkdir -p "$toolchain"
chmod a+rwx "$toolchain"
cp "$repo_root/server/package.json" "$repo_root/server/package-lock.json" "$toolchain/"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$artifact/tooling-docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$artifact/tooling-docker-ps-a.log"
  if [[ -n "$(docker ps -a --filter "name=^/$container$" --format '{{.ID}}')" ]]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --name "$container" --init --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --memory=2g --memory-swap=2g --pids-limit=512 --cpus=2 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777,size=512m --read-only --user 1000:1000 \
  -e npm_config_cache=/tmp/npm-cache -v "$toolchain:/toolchain" -w /toolchain \
  --entrypoint npm mbbs-to-yard-test-browser:20261009 ci --ignore-scripts --no-audit --no-fund

#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
tools=server/tools/sales-order-null-packs-20261016
out=server/test-artifacts/sales-order-null-packs-20261016
cleanup() {
  local status=$?
  trap - EXIT
  # Only temporary dependency files created by this task are removed here.
  docker run --rm --name mbbs-so-null-packs-cleanup-20261016 --init --label com.mbbs.lifecycle=disposable-test \
    --cgroup-parent=mbbs-tests.slice --cpus=1 --memory=256m --memory-swap=256m --pids-limit=64 \
    --network none --read-only --tmpfs /tmp:rw,nosuid,size=16m \
    --mount type=bind,src=/tmp/mbbs-so-null-packs-tools-20261016,dst=/tooling \
    mbbs-operator-app:dispatch-editor-control-browser-test-20261015 \
    rm -rf /tooling/node_modules /tooling/package.json /tooling/package-lock.json >"$out/tools-cleanup.log" 2>&1 || status=1
  docker rm -f mbbs-so-null-packs-cleanup-20261016 >/dev/null 2>&1 || true
  rmdir /tmp/mbbs-so-null-packs-tools-20261016 || status=1
  docker ps --format '{{.Names}} {{.Status}}' >"$out/docker-ps.log"
  docker ps -a --format '{{.Names}} {{.Status}}' >"$out/docker-ps-a.log"
  if [[ "$status" == 0 ]]; then python3 "$tools/evidence.py" || status=1; fi
  exit "$status"
}
mkdir -p "$out"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash "$tools/setup-tools.sh" >"$out/setup-tools.log" 2>&1
bash "$tools/run.sh" --database node tools/sales-order-null-packs-20261016/check.mjs final

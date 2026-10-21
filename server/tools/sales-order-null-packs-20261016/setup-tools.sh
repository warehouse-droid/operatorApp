#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
name=mbbs-so-null-packs-tools-20261016
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p /tmp/mbbs-so-null-packs-tools-20261016
docker run --rm --name "$name" --init --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --cpus=2 --memory=2g --memory-swap=2g --pids-limit=512 \
  --read-only --tmpfs /tmp:rw,nosuid,size=512m \
  --mount type=bind,src="$root/server/package.json",dst=/input/package.json,readonly \
  --mount type=bind,src="$root/server/package-lock.json",dst=/input/package-lock.json,readonly \
  --mount type=bind,src=/tmp/mbbs-so-null-packs-tools-20261016,dst=/tooling \
  --workdir /tooling --env NODE_ENV=development \
  mbbs-operator-app:dispatch-editor-control-browser-test-20261015 \
  sh -c 'cp /input/package.json /input/package-lock.json /tooling/ && npm ci --ignore-scripts --cache /tmp/npm --include=dev --no-audit --no-fund'

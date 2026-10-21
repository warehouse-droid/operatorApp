#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
name=mbbs-pob04042-quality
evidence="$PWD/server/artifacts/pob04042-ir-20261019"
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$evidence/quality-containers-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$evidence/quality-containers-all.txt"
}
trap cleanup EXIT INT TERM
docker run --rm --name "$name" --cgroup-parent=mbbs-tests.slice --init \
  --label com.mbbs.lifecycle=disposable-test --memory=2g --memory-swap=2g --pids-limit=256 --cpus=1 \
  --network=none --read-only --tmpfs /tmp:rw,size=128m \
  -v "$PWD/server/tools/pob04042-ir:/app/tools/pob04042-ir:ro" \
  -v "$PWD/server/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro" \
  -v "$PWD/server/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
  --entrypoint node mbbs-operator-app:special-po-warning-20261019 tools/pob04042-ir/quality.mjs \
  > "$evidence/quality.log" 2>&1
cat "$evidence/quality.log"

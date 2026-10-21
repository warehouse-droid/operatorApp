#!/usr/bin/env bash
set -Eeuo pipefail
cd /home/ubuntu/apps/operatorApp
mode=${1:-red}
name="mbbs-pob04042-proof-${mode}"
evidence="$PWD/server/artifacts/pob04042-ir-20261019"
cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$evidence/${mode}-containers-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$evidence/${mode}-containers-all.txt"
}
trap cleanup EXIT INT TERM
docker run --rm --name "$name" --cgroup-parent=mbbs-tests.slice --init \
  --label com.mbbs.lifecycle=disposable-test --memory=512m --memory-swap=512m --pids-limit=128 --cpus=1 \
  --network=none --read-only --tmpfs /tmp:rw,size=128m \
  -v "$PWD/server/tools/pob04042-ir:/app/tools/pob04042-ir:ro" \
  -v "$PWD/server/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro" \
  --entrypoint node mbbs-operator-app:special-po-warning-20261019 \
  --experimental-test-coverage --test /app/tools/pob04042-ir/proof.test.mjs /app/tools/pob04042-ir/property.test.mjs \
  > "$evidence/${mode}-proof.log" 2>&1
tail -18 "$evidence/${mode}-proof.log"

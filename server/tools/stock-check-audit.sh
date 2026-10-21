#!/usr/bin/env bash
set -euo pipefail
stock_audit_root=$(cd "$(dirname "$0")/.." && pwd)
stock_audit_name=mbbs-stock-check-dependency-audit
trap 'sudo -n docker rm -f "$stock_audit_name" >/dev/null 2>&1 || true' EXIT INT TERM
sudo -n docker run --rm --init --name "$stock_audit_name" --user 1000:1000 \
  --label com.mbbs.lifecycle=disposable-test --cgroup-parent=mbbs-tests.slice \
  --memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=64 --read-only \
  --tmpfs /tmp:rw,uid=1000,gid=1000,mode=1777,size=128m --env npm_config_cache=/tmp/npm-cache \
  --volume "$stock_audit_root/deployments/stock-check-20261014/before:/baseline:ro" \
  --volume "$stock_audit_root/deployments/stock-check-20261014/candidate:/candidate:ro" \
  --volume "$stock_audit_root/tools/stock-check-audit.mjs:/audit.mjs:ro" \
  --volume "$stock_audit_root/test-artifacts/stock-check:/output" \
  --entrypoint node mbbs-operator-app:stock-check-20261014 /audit.mjs \
  2>&1 | tee "$stock_audit_root/test-artifacts/stock-check/dependency-audit.log"

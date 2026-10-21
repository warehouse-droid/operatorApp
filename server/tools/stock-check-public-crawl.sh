#!/usr/bin/env bash
set -euo pipefail
stock_catalog_root=$(cd "$(dirname "$0")/../.." && pwd)
stock_catalog_name=mbbs-stock-check-public-catalog-20261014
stock_catalog_output="$stock_catalog_root/server/test-artifacts/stock-check/catalog"
mkdir -p "$stock_catalog_output"
stock_catalog_cleanup() {
  stock_catalog_result=$?
  trap - EXIT INT TERM
  set +e
  sudo -n docker rm -f "$stock_catalog_name" >/dev/null 2>&1
  sudo -n docker ps --format '{{.Names}}\t{{.Status}}' > "$stock_catalog_output/docker-ps.txt"
  sudo -n docker ps -a --format '{{.Names}}\t{{.Status}}' > "$stock_catalog_output/docker-ps-a.txt"
  exit "$stock_catalog_result"
}
trap stock_catalog_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n systemctl is-active --quiet mbbs-tests.slice
sudo -n docker run --rm --init --name "$stock_catalog_name" --user 1000:1000 \
  --label com.mbbs.lifecycle=disposable-test --label com.mbbs.task=stock-check-public-catalog \
  --cgroup-parent=mbbs-tests.slice --memory=768m --memory-swap=768m --cpus=0.5 --pids-limit=256 \
  --read-only --tmpfs /tmp:rw,uid=1000,gid=1000,mode=1777,size=256m \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --env XDG_CONFIG_HOME=/tmp/config --env XDG_CACHE_HOME=/tmp/cache \
  --volume "$stock_catalog_root/server/src:/app/src:ro" \
  --volume "$stock_catalog_root/server/tools:/app/tools:ro" \
  --volume "$stock_catalog_root/server/test-artifacts/mbr-contract/toolchain/node_modules:/app/node_modules:ro" \
  --volume "$stock_catalog_root/server/test-artifacts/mbr-contract/playwright-browsers:/ms-playwright:ro" \
  --volume "$stock_catalog_root/server/test-artifacts/stock-check:/app/test-artifacts/stock-check" \
  --workdir /app mbbs-operator-app:mbr-nullable-browser-test-20261013 \
  node "${1:-tools/stock-check-catalog.mjs}" "${2:-/app/test-artifacts/stock-check/catalog}" \
  2>&1 | tee "$stock_catalog_output/crawl.log"

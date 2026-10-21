#!/usr/bin/env bash
set -euo pipefail
stock_build_root=$(cd "$(dirname "$0")/.." && pwd)
stock_build_image=mbbs-operator-app:stock-check-20261014
stock_build_base=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["image_id"])' "$stock_build_root/deployments/stock-check-20261014/capture.json")
python3 "$stock_build_root/tools/stock-check-prepare.py"
sudo -n env DOCKER_BUILDKIT=0 docker build --cgroup-parent=mbbs-tests.slice --memory=2g --memory-swap=2g \
  --cpu-period=100000 --cpu-quota=100000 --rm --force-rm \
  --build-arg "STOCK_CHECK_BASE_IMAGE=$stock_build_base" -t "$stock_build_image" \
  -f "$stock_build_root/tools/Dockerfile.stock-check.runtime" "$stock_build_root/deployments/stock-check-20261014/candidate" \
  > "$stock_build_root/test-artifacts/stock-check/build.log" 2>&1
sudo -n docker image inspect --format '{{.Id}}' "$stock_build_image"

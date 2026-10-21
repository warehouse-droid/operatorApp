#!/usr/bin/env bash
set -euo pipefail
stock_match_root=$(cd "$(dirname "$0")/../.." && pwd)
stock_match_run_label=history
if [[ "${1:-}" == --request ]]; then stock_match_run_label=request-history; fi
stock_match_project=mbbs-stock-check-batch-$stock_match_run_label
stock_match_artifacts="$stock_match_root/server/test-artifacts/stock-check-batch"
stock_match_compose=(sudo -n env STOCK_CHECK_SOURCE_ROOT=./server/deployments/stock-check-batch-20261015/candidate docker compose --project-directory "$stock_match_root" -p "$stock_match_project" -f "$stock_match_root/docker-compose.mbt-test.yml" -f "$stock_match_root/docker-compose.stock-check-test.yml" -f "$stock_match_root/server/test/support/stock-check-ollama-history.compose.yml" --profile tools)
stock_match_cleanup() {
  stock_match_status=$?
  trap - EXIT INT TERM
  set +e
  "${stock_match_compose[@]}" down --volumes --remove-orphans --timeout 10 > "$stock_match_artifacts/$stock_match_run_label-cleanup.log" 2>&1
  if [[ $? != 0 ]]; then stock_match_status=1; fi
  sudo -n docker ps --format '{{.Names}}\t{{.Status}}' > "$stock_match_artifacts/$stock_match_run_label-docker-ps.txt"
  sudo -n docker ps -a --format '{{.Names}}\t{{.Status}}' > "$stock_match_artifacts/$stock_match_run_label-docker-ps-a.txt"
  if [[ -n $(sudo -n docker ps -aq --filter "label=com.docker.compose.project=$stock_match_project") || $(sudo -n docker inspect --format '{{.State.Health.Status}}' mbbs-operator-app-app-1) != healthy ]]; then stock_match_status=1; fi
  exit "$stock_match_status"
}
trap stock_match_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n systemctl is-active --quiet mbbs-tests.slice
"${stock_match_compose[@]}" run --rm --no-deps test node tools/stock-check-batch-history.mjs "$@" 2>&1 | tee "$stock_match_artifacts/$stock_match_run_label-evaluation.log"

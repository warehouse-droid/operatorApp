#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(dirname "$server_root")"
export SPLIT_IF_RELEASE="$server_root/deployments/split-fulfillment-evidence-20261020"
export SPLIT_IF_SOURCE="${SPLIT_IF_SOURCE:-$SPLIT_IF_RELEASE/candidate}"
compose=(docker compose -p mbbs-split-if-evidence
  --project-directory "$repo_root"
  -f "$repo_root/docker-compose.mbt-test.yml"
  -f "$server_root/tools/split-fulfillment-evidence.compose.yml")
mkdir -p "$SPLIT_IF_RELEASE/evidence"
chmod 0777 "$SPLIT_IF_RELEASE/evidence"
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans
  docker ps --format '{{.Names}}\t{{.Status}}'
  docker ps -a --format '{{.Names}}\t{{.Status}}'
  if [[ -n "$(docker ps -aq --filter label=com.docker.compose.project=mbbs-split-if-evidence)" ]]; then
    echo "Disposable test containers remain." >&2
    return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$repo_root/docker/verify-memory-limits.py"
docker image inspect mbbs-operator-app:dispatch-editor-control-browser-test-20261015 --format '{{.Id}}'
"${compose[@]}" up -d --wait db
"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" run --rm --no-deps test "$@"

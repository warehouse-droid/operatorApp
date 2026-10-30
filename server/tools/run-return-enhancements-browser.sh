#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
cd "$repo_dir"
compose=(docker compose -p "mbbs-return-browser-$$" -f docker-compose.mbt-test.yml --profile '*')
finish() {
  result=$?
  trap - EXIT INT TERM
  "${compose[@]}" down --volumes --remove-orphans || result=1
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
if (( $# == 0 )); then set -- node tools/return-enhancements-browser.mjs; fi
"${compose[@]}" run --rm --no-deps -T --label com.mbbs.lifecycle=disposable-test \
  -v "$repo_dir/server/public:/app/public:ro" \
  -v "$repo_dir/server/src:/app/src:ro" \
  -v "$repo_dir/server/migrations:/app/migrations:ro" \
  -v "$repo_dir/server/test:/app/test:ro" \
  -v "$repo_dir/server/tools:/app/tools:ro" \
  e2e "$@"

#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
test_container="mbbs-return-notification-browser-$$"
finish() {
  result=$?
  trap - EXIT INT TERM
  docker rm -f -v "$test_container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
if (( $# == 0 )); then set -- node tools/return-notification-browser.mjs; fi
docker run --rm --init --name "$test_container" --network none --read-only \
  --cgroup-parent=mbbs-tests.slice --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 \
  --label com.mbbs.lifecycle=disposable-test --tmpfs /tmp:rw,size=256m \
  -v "$repo_dir/server/public:/app/public:ro" \
  -v "$repo_dir/server/src:/app/src:ro" \
  -v "$repo_dir/server/test:/app/test:ro" \
  -v "$repo_dir/server/tools:/app/tools:ro" \
  -v "$repo_dir/server/eslint.mbt.config.js:/app/eslint.mbt.config.js:ro" \
  -v "$MBBS_TEST_ARTIFACT_DIR:/app/test-artifacts" \
  mbbs-mbt-p1-test-e2e:latest "$@"

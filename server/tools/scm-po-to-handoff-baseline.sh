#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0"
fi
cd "$repo_dir"
container_name="mbbs-po-to-baseline-$$"
finish_baseline() {
  result=$?
  trap - EXIT INT TERM
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap finish_baseline EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git show HEAD:server/public/scm-smart.html > "$MBBS_TEST_ARTIFACT_DIR/baseline.html"
if docker run --rm --name "$container_name" --init --network=none --read-only \
  --label com.mbbs.lifecycle=disposable-test --cgroup-parent=mbbs-tests.slice \
  --cpus=1 --memory=256m --memory-swap=256m --pids-limit=128 --tmpfs /tmp:rw,size=32m \
  --mount "type=bind,source=$MBBS_TEST_ARTIFACT_DIR/baseline.html,target=/app/public/scm-smart.html,readonly" \
  mbbs-mbt-p1-test-test:latest node src/smart-scm-blanket-ui-harness.js \
  > "$MBBS_TEST_ARTIFACT_DIR/baseline.log" 2>&1; then
  echo 'Expected baseline failure did not reproduce.'
  exit 1
fi
python3 - "$MBBS_TEST_ARTIFACT_DIR/baseline.log" <<'PY'
from pathlib import Path
import sys
log = Path(sys.argv[1]).read_text()
expected = 'Smart SCM must load cache-busted asset scm-smart-exclusions.js?v=20260801-po-only-pauses-v1.'
assert expected in log, log
print('Baseline reproduced: obsolete Blanket exclusions asset assertion.')
PY

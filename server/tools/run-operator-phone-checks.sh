#!/usr/bin/env bash
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
artifacts="$repo/server/test-artifacts/operator-phone-20261008"
test_container="mbbs-operator-phone-test-$(date +%s)-$$"
mkdir -p "$artifacts"
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if sudo -n docker container inspect "$test_container" >/dev/null 2>&1; then
    sudo -n docker rm --force --volumes "$test_container" >>"$artifacts/cleanup.log" 2>&1
  fi
  sudo -n docker ps --format '{{.Names}} {{.Status}}' >"$artifacts/containers-running.txt"
  sudo -n docker ps -a --format '{{.Names}} {{.Status}}' >"$artifacts/containers-all.txt"
  if sudo -n docker ps -a --format '{{.Names}}' | rg -v '^(mbbs-operator-app-app-1|mbbs-operator-app-db-1|mbbs-operator-app-webhook-worker-1|mbbs-operator-app-ollama-1)$'; then
    result=1
  fi
  curl --silent --show-error --fail http://127.0.0.1:3000/health >"$artifacts/production-health.json" || result=1
  sudo -n docker inspect mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-ollama-1 --format '{{.Name}} {{.State.Health.Status}}' >"$artifacts/production-health.txt"
  if rg -v ' healthy$' "$artifacts/production-health.txt"; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$repo/docker/verify-memory-limits.py" >"$artifacts/memory-limits.log" 2>&1
sudo -n docker run --rm --name "$test_container" \
  --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --init --cpus=2 \
  --memory=2g --memory-swap=2g --pids-limit=512 \
  --tmpfs /tmp:rw,exec,size=512m --tmpfs /app/data:rw,size=128m \
  --user root --workdir /app --no-healthcheck \
  --env NODE_ENV=test --env MBT_TEST_ISOLATED=1 --env MBBS_ENV_FILE=.env.mbt-test-does-not-exist \
  --mount "type=bind,src=$repo/server/public,dst=/app/public,readonly" \
  --mount "type=bind,src=$repo/server/src,dst=/app/src,readonly" \
  --mount "type=bind,src=$repo/server/migrations,dst=/app/migrations,readonly" \
  --mount "type=bind,src=$repo/server/test,dst=/app/test,readonly" \
  --mount "type=bind,src=$repo/server/test-artifacts,dst=/app/test-artifacts" \
  --mount "type=bind,src=$repo/server/tools/operator-phone-checks.sh,dst=/app/operator-phone-checks.sh,readonly" \
  "${PHONE_TEST_IMAGE:-mbbs-operator-app:registered-split-planning-20261007}" \
  bash operator-phone-checks.sh >"$artifacts/checks.log" 2>&1

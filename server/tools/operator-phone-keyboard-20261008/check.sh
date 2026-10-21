#!/usr/bin/env bash
set -Eeuo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
artifacts="$repo/server/test-artifacts/operator-phone-keyboard-20261008"
release="$repo/server/deployments/operator-phone-keyboard-20261008"
test_container="mbbs-phone-keyboard-test-$$"
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  docker rm --force --volumes "$test_container" >"$artifacts/cleanup.log" 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' >"$artifacts/containers-running.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' >"$artifacts/containers-all.txt"
  if docker ps -a --format '{{.Names}}' | rg -v '^(mbbs-operator-app-app-1|mbbs-operator-app-db-1|mbbs-operator-app-webhook-worker-1|mbbs-operator-app-ollama-1)$'; then result=1; fi
  curl --silent --show-error --fail http://127.0.0.1:3000/health >"$artifacts/production-health.json" || result=1
  docker inspect mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-ollama-1 --format '{{.Name}} {{.State.Health.Status}}' >"$artifacts/production-health.txt"
  if rg -v ' healthy$' "$artifacts/production-health.txt"; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$repo/docker/verify-memory-limits.py" >"$artifacts/memory-limits.log" 2>&1
image=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["app"]["imageId"])' "$release/manifest.json")
docker run --rm --name "$test_container" --init --cgroup-parent=mbbs-tests.slice \
  --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
  --label com.mbbs.lifecycle=disposable-test --tmpfs /tmp:rw,exec,size=768m --tmpfs /app/data:rw,size=32m \
  --user root --workdir /app --no-healthcheck \
  -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=/nonexistent \
  -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled \
  -e DATABASE_URL=postgres://disposable:disposable@127.0.0.1:1/disposable \
  --mount "type=bind,src=$release/candidate/public,dst=/candidate-public,readonly" \
  --mount "type=bind,src=$repo/server/test,dst=/app/test,readonly" \
  --mount "type=bind,src=$artifacts,dst=/app/test-artifacts/operator-phone-keyboard-20261008" \
  --mount "type=bind,src=$repo/server/tools/operator-phone-keyboard-20261008/browser.sh,dst=/checks.sh,readonly" \
  --entrypoint bash "$image" /checks.sh >"$artifacts/checks.log" 2>&1
python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["candidateTreeHash"])' "$release/manifest.json" >"$artifacts/checks-passed"

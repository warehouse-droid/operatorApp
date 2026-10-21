#!/usr/bin/env bash
set -euo pipefail
recovery_repo=$(cd "$(dirname "$0")/../.." && pwd)
recovery_phase=${1:?phase required}
recovery_source=${RECOVERY_SOURCE:-"$recovery_repo/server"}
recovery_command=${2:?command required}
recovery_artifacts="$recovery_repo/server/test-artifacts/driver-upload-recovery-20261015"
recovery_container="mbbs-driver-recovery-unit-$$"
mkdir -p "$recovery_artifacts/$recovery_phase"
cleanup_recovery_unit() {
  docker rm -f "$recovery_container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}' > "$recovery_artifacts/$recovery_phase/docker-ps.txt"
  docker ps -a --format '{{.Names}} {{.Status}}' > "$recovery_artifacts/$recovery_phase/docker-ps-a.txt"
  docker inspect --format '{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' mbbs-operator-app-app-1 mbbs-operator-app-db-1 mbbs-operator-app-webhook-worker-1 mbbs-operator-app-ollama-1 > "$recovery_artifacts/$recovery_phase/production-health.txt"
}
trap cleanup_recovery_unit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --pull=never --name "$recovery_container" --label com.mbbs.lifecycle=disposable-test --cgroup-parent=mbbs-tests.slice --init --memory=2g --memory-swap=2g --cpus=1 --pids-limit=256 --read-only --network=none --tmpfs /tmp:rw,nosuid,nodev,size=512m --tmpfs /app/data:rw,nosuid,nodev,size=32m --env NODE_ENV=test --env MBT_TEST_ISOLATED=1 --env MBBS_ENV_FILE=/tmp/does-not-exist --env DATABASE_URL=postgres://fixture:fixture@127.0.0.1:9/mbt_test --mount "type=bind,source=$recovery_repo/server,target=/app,readonly" --mount "type=bind,source=$recovery_artifacts,target=/app/test-artifacts" --mount "type=bind,source=$recovery_source/public,target=/app/public,readonly" --mount "type=bind,source=$recovery_source/src,target=/app/src,readonly" --mount "type=bind,source=$recovery_repo/server/test-artifacts/driver-upload-reliability/toolchain/node_modules,target=/app/node_modules,readonly" --workdir /app --entrypoint sh mbbs-to-yard-test-browser:20261009 -c "$recovery_command" 2>&1 | tee "$recovery_artifacts/$recovery_phase/checks.log"

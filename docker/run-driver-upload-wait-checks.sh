#!/usr/bin/env bash
set -Eeuo pipefail
wait_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$wait_repo/docker/retention/retention.py" run -- bash "$0" "$@"
fi
wait_container="mbbs-upload-wait-$$"
finish_upload_checks() {
  wait_status=$?
  trap - EXIT INT TERM
  docker rm -f -v "$wait_container" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "name=^/$wait_container$")" ]]; then wait_status=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || wait_status=1
  exit "$wait_status"
}
trap finish_upload_checks EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$wait_repo/docker/verify-memory-limits.py"
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
git -C "$wait_repo" show HEAD:server/public/driver-upload.js > "$MBBS_TEST_ARTIFACT_DIR/baseline-driver-upload.js"
git -C "$wait_repo" diff --unified=0 -- server/public/driver-upload.js > "$MBBS_TEST_ARTIFACT_DIR/driver-upload.patch"
wait_mounts=()
for wait_path in public src test tools contracts package.json package-lock.json eslint.driver-upload.config.mjs eslint.driver-recovery.config.mjs eslint.driver-reconnect.config.mjs eslint.driver-upload-wait.config.mjs; do
  wait_mounts+=(--mount "type=bind,source=$wait_repo/server/$wait_path,target=/app/$wait_path,readonly")
done
if (( $# == 0 )); then set -- node tools/driver-upload-wait-checks.mjs; fi
docker run --rm --pull=never --name "$wait_container" --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --init --memory=2g --memory-swap=2g --cpus=2 --pids-limit=512 \
  --read-only --network=none --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --tmpfs /app/data:rw,nosuid,nodev,size=32m --shm-size=128m \
  --env NODE_ENV=test --env MBT_TEST_ISOLATED=1 --env MBBS_ENV_FILE=/tmp/nonexistent \
  --env MBBS_TEST_ARTIFACT_DIR=/app/test-artifacts --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  "${wait_mounts[@]}" --mount "type=bind,source=$MBBS_TEST_ARTIFACT_DIR,target=/app/test-artifacts" \
  --workdir /app --entrypoint /usr/bin/env mbbs-dispatch-source-test:latest "$@"

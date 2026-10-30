#!/usr/bin/env bash
set -Eeuo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${MBBS_TEST_ARTIFACT_DIR:-}" ]]; then
  exec python3 "$repo_dir/docker/retention/retention.py" run -- bash "$0" "$@"
fi
test_name="mbbs-pallet-payment-test-$$"
cleanup() {
  result=$?
  trap - EXIT INT TERM
  docker rm -f -v "$test_name" >/dev/null 2>&1 || true
  docker ps --format '{{.Names}} {{.Status}}'
  docker ps -a --format '{{.Names}} {{.Status}}'
  if [[ -n "$(docker ps -aq --filter "name=^${test_name}$")" ]]; then result=1; fi
  curl -fsS -o /dev/null http://127.0.0.1:3000/health || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$repo_dir/docker/verify-memory-limits.py"
chmod 0777 "$MBBS_TEST_ARTIFACT_DIR"
if (( $# == 0 )); then set -- node test/checks.cjs; fi
test_network=none
if [[ "${PPA_TEST_TOOLING:-0}" == 1 ]]; then test_network=bridge; fi
docker run --rm --name "$test_name" --init --network "$test_network" --user "$(id -u):$(id -g)" \
  --cgroup-parent=mbbs-tests.slice --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 \
  --label com.mbbs.lifecycle=disposable-test --read-only --tmpfs /tmp:rw,nosuid,size=128m \
  --mount "type=bind,src=$repo_dir/server/netsuite/pallet-payment,dst=/work,readonly" \
  --mount "type=bind,src=$MBBS_TEST_ARTIFACT_DIR,dst=/artifacts" \
  --env "PPA_TEST_TOOLING=${PPA_TEST_TOOLING:-0}" --env npm_config_cache=/artifacts/npm-cache \
  --workdir /work --entrypoint /usr/local/bin/node \
  mbbs-operator-app:dispatch-editor-control-browser-test-20261015 \
  /work/test/entry.cjs "$@"

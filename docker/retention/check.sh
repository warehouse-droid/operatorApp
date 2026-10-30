#!/usr/bin/env bash
set -Eeuo pipefail
suite_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_name="mbbs-retention-tests-$$"
cleanup_retention_tests() {
  result=$?
  trap - EXIT INT TERM
  docker rm -f "$test_name" >/dev/null 2>&1 || true
  docker ps --filter "name=^/${test_name}$" --format '{{.Names}}'
  docker ps -a --filter "name=^/${test_name}$" --format '{{.Names}}'
  if [[ -n "$(docker ps -aq --filter "name=^/${test_name}$")" ]]; then result=1; fi
  exit "$result"
}
trap cleanup_retention_tests EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$suite_dir/check_config.py"
docker run --rm --init --name "$test_name" \
  --label com.mbbs.lifecycle=disposable-test \
  --cgroup-parent=mbbs-tests.slice --cpus=1 --memory=512m \
  --memory-swap=512m --pids-limit=128 --network=none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --mount "type=bind,src=$suite_dir,dst=/suite,readonly" \
  --workdir /suite -e PYTHONDONTWRITEBYTECODE=1 \
  python:3.12-alpine@sha256:1b668429b3511ab407d8e00648891631b0b1a4d7e15e3ca70f38ab5b91ad4ab4 \
  python /suite/gauntlet.py

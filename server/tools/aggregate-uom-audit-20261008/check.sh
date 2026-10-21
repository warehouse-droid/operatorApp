#!/usr/bin/env bash
set -euo pipefail
audit_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
audit_tools="$audit_root/server/tools/aggregate-uom-audit-20261008"
audit_out="$audit_root/server/test-artifacts/aggregate-uom-audit-20261008/checks"
audit_prefix="aggregate-uom-audit-20261008-$$"
mkdir -p "$audit_out"
cleanup() {
  for audit_suffix in core defects mutations; do
    docker rm -f -v "$audit_prefix-$audit_suffix" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
audit_image=$(docker inspect mbbs-operator-app-app-1 --format '{{.Image}}')
printf '%s\n' "$audit_image" > "$audit_out/image.txt"
audit_common=(--rm --network none --read-only --cgroup-parent=mbbs-tests.slice --init
  --memory=512m --memory-swap=512m --cpus=1 --pids-limit=128
  --label com.mbbs.lifecycle=disposable-test --tmpfs /tmp:size=64m
  --tmpfs /app/data:size=32m,uid=1000,gid=1000 --user 1000:1000 --workdir /app
  -e NODE_ENV=test -e MBT_TEST_ISOLATED=1 -e MBBS_ENV_FILE=.env.aggregate-audit-does-not-exist
  -e NETSUITE_DIRECT_ACCESS_ENABLED=false -e NETSUITE_MIRROR_ROLE=disabled
  -e DATABASE_URL=postgres://disposable:disposable@127.0.0.1:1/disposable
  --mount "type=bind,src=$audit_tools,dst=/app/tools/aggregate-audit,readonly" --entrypoint node)
set +e
docker run --name "$audit_prefix-core" "${audit_common[@]}" "$audit_image" --test --test-concurrency=1 \
  /app/tools/aggregate-audit/calculation.test.mjs > "$audit_out/core.log" 2>&1
audit_core=$?
docker run --name "$audit_prefix-defects" "${audit_common[@]}" "$audit_image" --test --test-concurrency=1 \
  /app/tools/aggregate-audit/known-defects.test.mjs > "$audit_out/defects.log" 2>&1
audit_defects=$?
docker run --name "$audit_prefix-mutations" "${audit_common[@]}" "$audit_image" \
  /app/tools/aggregate-audit/mutations.mjs > "$audit_out/mutations.log" 2>&1
audit_mutations=$?
set -e
printf '{"coreExit":%s,"defectsExit":%s,"mutationsExit":%s}\n' \
  "$audit_core" "$audit_defects" "$audit_mutations" > "$audit_out/results.json"
cat "$audit_out/results.json"
if [[ "$audit_core" != 0 || "$audit_mutations" != 0 ]]; then exit 1; fi
# A nonzero defects result is reported as an audit finding, never a passing calculation check.

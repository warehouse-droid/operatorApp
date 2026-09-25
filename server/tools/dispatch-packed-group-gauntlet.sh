#!/usr/bin/env bash
set -Eeuo pipefail
packed_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$packed_root"
packed_artifact="$packed_root/server/test-artifacts/packed-group-review"
mkdir -p "$packed_artifact/baseline"
git show HEAD:server/src/dispatch-plan-repository.js > "$packed_artifact/baseline/dispatch-plan-repository.js"
packed_runner=(bash server/tools/dispatch-packed-group-test.sh)
"${packed_runner[@]}" node tools/dispatch-packed-group-checks.mjs > "$packed_artifact/checks-run.log" 2>&1
PACKED_GROUP_SOURCE="$packed_artifact/baseline/dispatch-plan-repository.js" "${packed_runner[@]}" npm run typecheck:mbt > "$packed_artifact/types-baseline.log" 2>&1 || true
"${packed_runner[@]}" npm run typecheck:mbt > "$packed_artifact/types-final.log" 2>&1 || true
python3 server/tools/dispatch-retired-confirm-evidence.py types "$packed_artifact/types-baseline.log" "$packed_artifact/types-final.log"
# The check script compares all four legacy harness failures using node --test,
# including the sales-order integration harness and its assertion details.
if [[ "${PACKED_GROUP_REUSE_FULL:-0}" != 1 ]]; then
  PACKED_GROUP_SOURCE="$packed_artifact/baseline/dispatch-plan-repository.js" "${packed_runner[@]}" npm test > "$packed_artifact/full-baseline.log" 2>&1 || true
  "${packed_runner[@]}" npm test > "$packed_artifact/full-final.log" 2>&1 || true
fi
python3 server/tools/dispatch-retired-confirm-evidence.py compare "$packed_artifact/full-baseline.log" "$packed_artifact/full-final.log"
git diff --check

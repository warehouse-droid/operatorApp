#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
baseline="$server_root/test-artifacts/dispatch-po-line-destinations/baseline"
if [[ ! -f "$baseline/dispatch-repository.js" ]]; then
  source_copy="$(mktemp -d /tmp/po-line-destinations-baseline-XXXXXX)"
  mkdir -p "$source_copy/src" "$baseline"
  for file in dispatch-repository.js dispatch-planner-v2-repository.js dispatch-po-route-projection.js; do
    cp "src/$file" "$source_copy/src/$file"
  done
  patch --reverse --batch --fuzz=0 -p1 -d "$source_copy" < test/dispatch-po-line-destinations.changes.patch
  cp "$source_copy/src/"* "$baseline/"
  rm -rf "$source_copy"
fi
check_name="po-line-destinations-verify-$(date +%Y%m%d%H%M%S)-$$"
BIN_PLANNING_CHECK="$check_name" bash tools/bin-planning-test.sh node tools/dispatch-po-line-destinations-check.mjs all
python3 tools/dispatch-po-line-destinations-evidence.py "$check_name"

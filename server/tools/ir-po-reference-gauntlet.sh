#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
runner=(bash tools/ir-po-reference-test.sh)
baseline_root="$(python3 tools/ir-po-reference-snapshot.py)"
cleanup() {
  wait "${baseline_pid:-}" 2>/dev/null || true
  wait "${candidate_pid:-}" 2>/dev/null || true
  rm -rf "$baseline_root"
}
trap cleanup EXIT
# Both full suites mount a complete source tree at /app with separate databases.
IR_REFERENCE_SOURCE_ROOT="$baseline_root" "${runner[@]}" node tools/ir-po-reference-checks.mjs --record-baseline &
baseline_pid=$!
"${runner[@]}" node tools/ir-po-reference-checks.mjs --record-full &
candidate_pid=$!
"${runner[@]}" node tools/ir-po-reference-checks.mjs
wait "$baseline_pid"
wait "$candidate_pid"
python3 tools/ir-po-reference-evidence.py

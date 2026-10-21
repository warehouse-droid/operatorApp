#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$server_root"
artifact="$server_root/test-artifacts/direct-ship-lifecycle-20260925"
baseline="$server_root/test-artifacts/direct-ship-deployment-20260926-v2/baseline"
frozen="$server_root/test-artifacts/direct-ship-deployment-20260926-v2/source"
test -d "$baseline"
test -d "$frozen"
if ! sudo -n docker image inspect field-sales-check-2941306:latest >/dev/null 2>&1; then
  sudo -n docker build --target test-e2e -f Dockerfile.test -t field-sales-check-2941306:latest "$server_root"
fi
sudo -n python3 tools/direct-ship-test-source.py
run_check() {
  local name="$1"
  shift
  local check_source="$frozen"
  if [[ "$name" == "final-secrets" ]]; then check_source="$server_root"; fi
  if sudo -n env SPECIAL_PO_CHECK="direct-ship-$name" SPECIAL_PO_SOURCE_ROOT="$check_source" bash tools/dispatch-special-po-test.sh "$@" > "$artifact/$name.log" 2>&1; then
    printf '%s passed\n' "$name"
  else
    printf '%s has failures; evidence comparison determines whether they are pre-existing\n' "$name"
  fi
}
if sudo -n env SPECIAL_PO_CHECK=direct-ship-frozen-full SPECIAL_PO_SOURCE_ROOT="$frozen" bash tools/dispatch-special-po-test.sh npm test > "$artifact/frozen-full.log" 2>&1; then :; fi
run_check final-coverage node tools/direct-ship-coverage.mjs
run_check final-random node tools/direct-ship-suites.mjs random
run_check final-offline node tools/direct-ship-suites.mjs offline
run_check final-mutations node tools/direct-ship-mutations.mjs
run_check final-static node tools/direct-ship-static.mjs
python3 tools/direct-ship-diff.py
run_check final-secrets bash tools/direct-ship-secrets.sh
cp tools/direct-ship-static.mjs tools/direct-ship-files.json tools/direct-ship-eslint.config.mjs "$baseline/tools/"
sudo -n env SPECIAL_PO_CHECK=direct-ship-baseline-static SPECIAL_PO_SOURCE_ROOT="$baseline" bash tools/dispatch-special-po-test.sh node tools/direct-ship-static.mjs > "$artifact/baseline-static.log" 2>&1
if sudo -n env SPECIAL_PO_CHECK=direct-ship-baseline-related SPECIAL_PO_SOURCE_ROOT="$baseline" bash tools/dispatch-special-po-test.sh node tools/dispatch-special-po-suites.mjs src/dispatch-driver-order-harness.js > "$artifact/baseline-related.log" 2>&1; then :; fi
python3 tools/direct-ship-evidence.py replay
sudo -n python3 tools/direct-ship-replay.py > "$artifact/final-replay.log" 2>&1
python3 tools/direct-ship-evidence.py check

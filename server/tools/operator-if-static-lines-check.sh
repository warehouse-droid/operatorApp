#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/operator-if-static-lines"
state=/home/ubuntu/operatorapp-deploy-backups/operator-if-static-lines-20261010
python3 server/tools/operator-if-static-lines-prepare.py prepare
if [[ "${IF_LINES_REUSE_BASELINE:-0}" == 1 ]]; then
  python3 - "$artifact" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
manifest = json.loads((p/'manifest.json').read_text())
baseline = json.loads((p/'baseline-source.json').read_text())
assert baseline['hashes'] == {name: row['before'] for name,row in manifest['changes'].items()}
tests = json.loads((p/'baseline.json').read_text())
assert len(tests) >= 70 and all(row['exitCode'] == 0 for row in tests)
print(json.dumps({'baselineReused': True, 'files': len(tests)}))
PY
else
  TO_YARD_CANDIDATE_ROOT="$state/baseline/app" TO_YARD_TEST_BASELINE_ROOT="$state/baseline-tests" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-if-static-lines-checks.mjs baseline > "$artifact/baseline-checks.log" 2>&1
fi
final_args=()
if [[ "${IF_LINES_REUSE_REGRESSIONS:-0}" == 1 ]]; then final_args+=(--reuse-regressions); fi
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-if-static-lines-checks.mjs final "${final_args[@]}" > "$artifact/final-checks.log" 2>&1
python3 server/tools/operator-if-static-lines-coverage.py > "$artifact/changed-coverage.log"
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-if-static-lines-checks.mjs shuffled > "$artifact/shuffled-checks.log" 2>&1

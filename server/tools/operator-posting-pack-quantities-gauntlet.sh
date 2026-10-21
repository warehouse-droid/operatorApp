#!/usr/bin/env bash
set -Eeuo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
artifact="$repo/server/test-artifacts/operator-posting-pack-quantities"
state=/home/ubuntu/operatorapp-deploy-backups/operator-pack-quantities-20261010
python3 server/tools/operator-posting-pack-quantities-prepare.py
if [[ "${PACKS_REUSE_BASELINE:-0}" == 1 ]]; then
  python3 - "$artifact" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
manifest = json.loads((p/'manifest.json').read_text())
baseline = json.loads((p/'baseline-source.json').read_text())
assert baseline['hashes'] == {name: row['before'] for name,row in manifest['changes'].items()}
tests = json.loads((p/'baseline.json').read_text())
assert len(tests) >= 69 and all(row['exitCode'] == 0 for row in tests)
print(json.dumps({'baselineReused': True, 'files': len(tests)}))
PY
else
  TO_YARD_CANDIDATE_ROOT="$state/baseline/app" TO_YARD_TEST_BASELINE_ROOT="$state/baseline-tests" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-posting-pack-quantities-checks.mjs baseline > "$artifact/baseline-checks.log" 2>&1
fi
final_args=()
if [[ "${PACKS_REUSE_REGRESSIONS:-0}" == 1 ]]; then final_args+=(--reuse-regressions); fi
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-posting-pack-quantities-checks.mjs final "${final_args[@]}" > "$artifact/final-checks.log" 2>&1
python3 server/tools/operator-posting-pack-quantities-coverage.py > "$artifact/changed-coverage.log"
TO_YARD_CANDIDATE_ROOT="$state/candidate" bash server/tools/operator-to-yard-flow-test.sh node tools/operator-posting-pack-quantities-checks.mjs shuffled > "$artifact/shuffled-checks.log" 2>&1

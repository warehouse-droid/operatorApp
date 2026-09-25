#!/usr/bin/env bash
set -Eeuo pipefail
server_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="$server_root/test-artifacts/receiving-posting-status/reproduced"
mkdir -p "$artifact"
environment() { sudo -n env RECEIPT_STATUS_BASELINE=3 bash "$server_root/tools/receiving-posting-status-env.sh" "$@"; }
environment start
trap 'environment stop' EXIT
environment exec env NODE_V8_COVERAGE=/app/test-artifacts/receiving-posting-status/v8 node tools/receiving-posting-status-checks.mjs focused > "$artifact/focused.log"
environment exec node tools/receiving-posting-status-checks.mjs health > "$artifact/health.log"
environment exec node tools/receiving-posting-status-checks.mjs static > "$artifact/static.json"
environment exec node tools/receiving-posting-status-checks.mjs mutations > "$artifact/mutations.log"
environment exec node tools/receiving-posting-status-browser.mjs > "$artifact/browser.json"
environment exec node tools/receiving-posting-status-checks.mjs coverage > "$artifact/coverage.json"
environment exec npm test > "$artifact/full.log" 2>&1 || true
python3 - "$server_root" "$artifact" <<'PY'
from collections import Counter
import json
from pathlib import Path
import re
import sys
server, artifact = map(Path, sys.argv[1:])
baseline = json.loads((server/'test/receiving-posting-status-baseline.json').read_text())
current = json.loads((artifact/'static.json').read_text())
for key in ['lint','diagnostics']:
    assert not (Counter(current[key]) - Counter(baseline['static'][key])), 'New static findings'
full = (artifact/'full.log').read_text()
assert re.search(r'Isolated MBT main run (?:passed|failed)', full), 'Full suite did not finish'
failed = set(re.findall(r'^✖ (.+?) \([\d.]+m?s\)$', full, re.M))
assert not (failed - set(baseline['failureNames'])), 'New full-suite failure: ' + repr(failed-set(baseline['failureNames']))
summary = re.search(r'Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)', full)
failed_files = summary[1].split(', ') if summary else []
assert not (set(failed_files) - set(baseline['failureFiles'])), 'New failing test files'
print(json.dumps({'passed':True,'newFullSuiteFailures':0,'existingFailureNames':len(failed),'sources':current['sources']}))
PY

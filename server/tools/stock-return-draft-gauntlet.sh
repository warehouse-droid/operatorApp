#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
artifact="$PWD/server/test-artifacts/stock-return-insert"
mkdir -p "$artifact"
if [[ ! -f "$artifact/baseline/runtime.json" ]]; then
  python3 server/tools/stock-return-draft-release.py capture
fi
python3 server/tools/stock-return-draft-release.py prepare > "$artifact/prepare.log"
python3 -m py_compile server/tools/stock-return-draft-release.py
bash -n server/tools/stock-return-draft-test.sh
set +e
STOCK_RETURN_SOURCE_ROOT="$artifact/baseline" bash server/tools/stock-return-draft-test.sh \
  node --test test/mbt/integration/stock-return-draft-insert.test.js > "$artifact/red.log" 2>&1
red_status=$?
set -e
test "$red_status" = 1
python3 - <<'PY'
from pathlib import Path
text = Path('server/test-artifacts/stock-return-insert/red.log').read_text()
assert 'INSERT has more expressions than target columns' in text
assert '# fail 4' in text and '# pass 1' in text
PY
STOCK_RETURN_SOURCE_ROOT="$artifact/release" bash server/tools/stock-return-draft-test.sh \
  node tools/stock-return-draft-checks.mjs > "$artifact/checks.log" 2>&1
python3 server/tools/stock-return-draft-release.py build > "$artifact/build.log" 2>&1
STOCK_RETURN_TEST_IMAGE=mbbs-operator-app:stock-return-insert-20260918 STOCK_RETURN_IMAGE_ONLY=1 \
  bash server/tools/stock-return-draft-test.sh node --test test/mbt/integration/stock-return-draft-insert.test.js \
  > "$artifact/image-smoke.log" 2>&1
set +e
bash server/tools/stock-return-draft-test.sh npm test > "$artifact/workspace-full.log" 2>&1
full_status=$?
set -e
printf '%s\n' "$full_status" > "$artifact/workspace-full-exit-code.txt"
python3 - <<'PY'
import json
from pathlib import Path
import re
root = Path('server/test-artifacts/stock-return-insert')
text = (root / 'workspace-full.log').read_text()
status = int((root / 'workspace-full-exit-code.txt').read_text())
failures = re.findall(r'^Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)$', text, re.M)
actual = set(failures[0].split(', ')) if failures else set()
baseline = json.loads(Path('server/test/stock-return-draft-workspace-baseline.json').read_text())
expected = set(baseline['failedFiles'])
assert status == 0 or (status == 1 and len(failures) == 1 and actual <= expected), (status, sorted(actual - expected))
for section in text.split('[isolation]'):
    lines = section.splitlines()
    if not lines:
        continue
    for file in actual:
        if not lines[0].endswith(file):
            continue
        names = {re.sub(r' \([0-9.]+ms\)$', '', line[2:]) for line in lines
                 if line.startswith('✖ ') and not line.startswith('✖ failing tests:')}
        assert names <= set(baseline['failedTests'][file]), (file, sorted(names))
assert 'stock-return-draft-insert.test.js' in text
print(json.dumps({'releaseChecksPassed': True, 'workspaceBaselineFailures': len(actual)}))
PY

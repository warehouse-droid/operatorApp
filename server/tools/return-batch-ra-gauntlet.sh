#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
artifact=server/test-artifacts/return-batch-ra
mkdir -p "$artifact"
runner=(bash server/tools/stock-return-draft-test.sh)
"${runner[@]}" node tools/return-batch-ra-checks.mjs --static > "$artifact/static-run.log" 2>&1
"${runner[@]}" node tools/return-batch-ra-checks.mjs > "$artifact/release-checks-final.log" 2>&1
"${runner[@]}" node tools/return-batch-ra-checks.mjs --mutate > "$artifact/mutation-final.log" 2>&1
# Browser binaries are test-only; application dependencies remain unchanged.
docker run --rm --network none --ipc=host -e PLAYWRIGHT_BROWSERS_PATH=/browsers \
  -v "${RETURN_BATCH_BROWSER_PATH:-/tmp/return-batch-playwright}:/browsers:ro" \
  -v "$PWD/server/public:/app/public:ro" -v "$PWD/server/src:/app/src:ro" \
  -v "$PWD/server/tools:/app/tools:ro" -v "$PWD/server/test-artifacts:/app/test-artifacts" \
  --entrypoint node mbbs-return-batch-browser-test:20260918 tools/return-batch-ra-browser.mjs > "$artifact/browser.log" 2>&1
set +e
"${runner[@]}" npm test > "$artifact/full-final.log" 2>&1
full_status=$?
set -e
python3 - "$full_status" <<'PY'
import json,re,sys
from pathlib import Path
text=Path('server/test-artifacts/return-batch-ra/full-final.log').read_text()
baseline=json.loads(Path('server/test/stock-return-draft-workspace-baseline.json').read_text())
failures=re.findall(r'^Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)$',text,re.M)
actual=set(failures[0].split(', ')) if failures else set()
assert int(sys.argv[1])==0 or (int(sys.argv[1])==1 and len(failures)==1 and actual<=set(baseline['failedFiles']))
for section in text.split('[isolation]'):
    lines=section.splitlines()
    if not lines: continue
    for filename in actual:
        if not lines[0].endswith(filename): continue
        names={re.sub(r' \([0-9.]+ms\)$','',line[2:]) for line in lines if line.startswith('✖ ') and not line.startswith('✖ failing tests:')}
        assert names<=set(baseline['failedTests'][filename]), (filename,names)
print(json.dumps({'baselineFailedFiles':len(actual),'newFailedFiles':0}))
PY

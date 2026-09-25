#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
artifact=server/test-artifacts/return-ra-workflow
mkdir -p "$artifact"
runner=(bash server/tools/order-line-storage-test.sh)
"${runner[@]}" node tools/return-ra-checks.mjs --static > "$artifact/static-run.log" 2>&1
"${runner[@]}" node tools/return-ra-checks.mjs > "$artifact/checks-run.log" 2>&1
"${runner[@]}" node tools/return-ra-checks.mjs --mutate > "$artifact/mutation-run.log" 2>&1
docker run --rm --network none --ipc=host -v "$PWD/server/public:/app/public:ro" \
  -v "$PWD/server/src:/app/src:ro" -v "$PWD/server/tools:/app/tools:ro" \
  -v "$PWD/server/test-artifacts:/app/test-artifacts" --entrypoint node \
  mbbs-mbt-p1-test-e2e:latest tools/return-ra-browser.mjs > "$artifact/browser.log" 2>&1
# The existing unrelated infrastructure assertion is retained in the full log.
set +e
"${runner[@]}" npm test > "$artifact/full-final.log" 2>&1
status=$?
set -e
printf '%s\n' "$status" > "$artifact/full-exit-code.txt"
if [[ "$status" != 0 ]]; then
  python3 - <<'PY'
from pathlib import Path
text = Path('server/test-artifacts/return-ra-workflow/full-final.log').read_text()
summary = [line for line in text.splitlines() if line.startswith('Isolated MBT main run failed in')]
expected = '1/511 file(s): /app/test/mbt/infrastructure/p3-gauntlet-contract.test.js'
assert len(summary) == 1 and summary[0].endswith(expected), summary
assert 'dispatch-unpacked-split.spec.js must use the shared worker-scoped E2E fixture.' in text
PY
fi
python3 server/tools/return-ra-report.py

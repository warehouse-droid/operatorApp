#!/usr/bin/env bash
# Six fixed, balanced pairs; retain the original three, including their failure.
set -Eeuo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_root"
artifact=server/test-artifacts/order-update-save
baseline="$task_root/$artifact/baseline"
runner=server/tools/dispatch-save-reliability-test.sh
browser_image="${DISPATCH_SAVE_BROWSER_IMAGE:-mbbs-mbt-p1-test-e2e:latest}"
if [[ "${1:-}" == --full ]]; then
  bash server/tools/order-update-save-gauntlet.sh || initial_exit=$?
fi
# A failed timing gate is the only reason this continuation may run. Require
# every preceding layer to have completed on the same frozen source.
python3 - <<'PY'
import hashlib,json
from pathlib import Path
from datetime import datetime
r=Path('server/test-artifacts/order-update-save')
start=json.loads((r/'final-run-start.json').read_text())
for name,want in start['sources'].items():
    assert hashlib.sha256((Path('server')/name).read_bytes()).hexdigest()==want,name
for file in ['full-comparison.json','adjacent-comparison.json','static-comparison.json','checks.json',
             'complexity.json','secrets.json','startup.json','rollback.json','changed-line-coverage.json','browser.json','performance-comparison.json']:
    p=r/file
    assert p.stat().st_mtime >= datetime.fromisoformat(start['timestamp']).timestamp(),f'Stale layer: {file}'
for file in ['full-comparison.json','adjacent-comparison.json']:
    assert not json.loads((r/file).read_text())['newFailures']
static=json.loads((r/'static-comparison.json').read_text())
assert not static['newLint'] and not static['newTypes']
assert not json.loads((r/'secrets.json').read_text())['findings']
assert not json.loads((r/'complexity.json').read_text())['exceeded']
assert all(not row['uncovered'] for row in json.loads((r/'changed-line-coverage.json').read_text()).values())
assert len(json.loads((r/'checks.json').read_text())['kills'])==7
assert len(json.loads((r/'checks.json').read_text())['propertyKills'])==7
assert len(json.loads((r/'browser.json').read_text()))==2
original=r/'performance-three-pairs.json'
if not original.exists(): original.write_bytes((r/'performance-comparison.json').read_bytes())
PY
for round in 4 5 6; do
  variants=(candidate baseline)
  if [[ "$round" == 5 ]]; then variants=(baseline candidate); fi
  for variant in "${variants[@]}"; do
    if [[ "$variant" == baseline ]]; then
      DISPATCH_SAVE_RELIABILITY_BASELINE="$baseline" DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="$browser_image" \
        bash "$runner" node tools/order-update-save-benchmark.mjs baseline > "$artifact/benchmark-$variant-$round.log" 2>&1
    else
      DISPATCH_SAVE_RELIABILITY_TEST_IMAGE="$browser_image" bash "$runner" node tools/order-update-save-benchmark.mjs candidate > "$artifact/benchmark-$variant-$round.log" 2>&1
    fi
    cp "$artifact/browser-$variant.json" "$artifact/browser-$variant-pair-$round.json"
  done
done
python3 server/tools/dispatch-save-performance.py --directory "$artifact" --series pair- --replicates 6 > "$artifact/performance.log"
python3 - <<'PY'
import hashlib,json
from pathlib import Path
from datetime import datetime,timezone
r=Path('server/test-artifacts/order-update-save')
start=json.loads((r/'final-run-start.json').read_text())
for name,want in start['sources'].items():
    assert hashlib.sha256((Path('server')/name).read_bytes()).hexdigest()==want,name
tool=Path('server/tools/order-update-save-performance-followup.sh')
start.update(timestamp=datetime.now(timezone.utc).isoformat(),
             supplementalMeasurementTool={str(tool):hashlib.sha256(tool.read_bytes()).hexdigest()},
             note='All original frozen source, test and tool bytes unchanged. Only this fixed measurement continuation was added; all six pairs are retained.')
(r/'final-run-complete.json').write_text(json.dumps(start,indent=2)+'\n')
print(start['treeSha256'])
PY

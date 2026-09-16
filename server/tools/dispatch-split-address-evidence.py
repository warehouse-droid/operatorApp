"""Compare regression failures to the observed pre-fix baseline and record counts."""
from pathlib import Path
import json
import re

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/split-address'

def failures(text):
    return sorted(set(re.findall(r'^✖ (.+?) \([0-9.]+ms\)$', text, re.M)))

baseline = (artifact / 'baseline-failures.log').read_text()
current = (artifact / 'regression-final.log').read_text()
assert '[isolation] Split address Dispatch regression 170/170' in current
assert 'concurrent cancellation blocks the repair' in current
assert failures(current) == failures(baseline), 'Regression failures differ from the verified pre-fix baseline.'
assert not re.search(r'^not ok ', current, re.M), 'The standalone fixture failed.'
counts = {label: sum(map(int, re.findall(rf'^(?:ℹ |# ){label} (\d+)$', current, re.M)))
          for label in ['tests', 'pass', 'fail', 'skipped']}
result = {'baselineFailures': failures(baseline), 'newFailures': 0, 'regression': counts}
(artifact / 'regression-comparison.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))

"""Record failures independently reproduced on the latest captured live baseline."""
import hashlib
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
baseline_path = root / 'test/receiving-multi-yard-full-baseline.json'
baseline = json.loads(baseline_path.read_text())
manifest = json.loads((root / 'test/receiving-multi-yard-manifest.json').read_text())
log = root / 'test-artifacts/receiving-multi-yard/full-baseline-live-rebase.log'
output = log.read_text()
assert 'Isolated Receiving live rebase baseline run failed in 2/3 file(s)' in output
assert re.search(r'^✔ selected receiving order card counts the same current remaining lines as its detail ', output, re.M)
source = root / 'deployments/receiving-multi-yard-20260930/baseline'
for file, expected in manifest['before'].items():
    assert hashlib.sha256((source / file).read_bytes()).hexdigest() == expected, file
special_file = 'src/special-stock-request-repository.js'
special_hash = hashlib.sha256((source / special_file).read_bytes()).hexdigest()
assert special_hash == hashlib.sha256((root / special_file).read_bytes()).hexdigest()
failures = list(dict.fromkeys(re.findall(r'^✖ (.+?) \([\d.]+ms\)', output, re.M)))
probe = {'files': 3, 'failures': failures,
         'passed': sum(map(int, re.findall(r'^ℹ pass (\d+)$', output, re.M))),
         'failed': sum(map(int, re.findall(r'^ℹ fail (\d+)$', output, re.M))),
         'log': str(log.relative_to(root)), 'logHash': hashlib.sha256(log.read_bytes()).hexdigest(),
         'capturedRuntimeBefore': manifest['before'], 'unchangedSpecialRepositoryHash': special_hash}
baseline['latestLiveProbe'] = probe
baseline['failures'] = list(dict.fromkeys(baseline['failures'] + failures))
baseline['source'] = 'Original full deployed baseline plus the listed failures independently reproduced after the unrelated live stock-purchase release.'
baseline_path.write_text(json.dumps(baseline, indent=2) + '\n')
print(json.dumps({'latestProbePassed': probe['passed'], 'latestProbeFailed': probe['failed'],
                  'verifiedBaselineFailureNames': len(baseline['failures'])}))

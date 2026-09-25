"""Verify the worker has no new failures against its captured release baseline."""
import importlib.util
import json
from pathlib import Path
import re

SERVER = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('split_release', SERVER / 'tools/active-split-parent-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
kit, core = release.kit, release.core

baseline = (release.ARTIFACT / 'worker-baseline.log').read_text()
candidate = (kit.RELEASE / 'worker/candidate-focused.log').read_text()
known = {
    'L1/L2 planned fully linked group remains discoverable with two reference lines',
    'L3 reference confirmation is rejected on canonical and grouped lines without writes',
}
fixed = {
    f'{family}: {case}'
    for family in ['sales_order', 'transfer_order']
    for case in ['completed splits keep their parent out of Active',
                 'a cached packed parent stays hidden behind its completed splits']
}
failures = lambda log: set(re.findall(r'^not ok \d+ - (.+)$', log, re.M))
assert '# tests 53\n' in baseline and '# pass 47\n# fail 6\n' in baseline
assert '# tests 53\n' in candidate and '# pass 51\n# fail 2\n' in candidate
assert failures(baseline) == known | fixed
assert failures(candidate) == known
new_tests = re.findall(r'^ok \d+ - ((?:sales_order|transfer_order): .+)$', candidate, re.M)
assert len(new_tests) == 8

def failure_detail(log, name):
    block = log.split(' - ' + name + '\n', 1)[1].split('\n  ...', 1)[0]
    block = re.sub(r'  duration_ms: .*\n', '', block)
    # Removing two SQL lines shifts subsequent repository stack locations only.
    return re.sub(r'(file:///app/src/delivery-repository\.js):\d+:', r'\1:<line>:', block)

for name in known:
    assert failure_detail(baseline, name) == failure_detail(candidate, name), name

release.source_gate()
with kit.service(True):
    state = core.manifest()
    core.current(state)
    for name, digest in state['before'].items():
        assert core.digest((core.RELEASE / 'baseline' / name).read_bytes()) == digest, name
    result = {
        'noNewFailures': True,
        'baseline': {'passed': 47, 'failed': 6},
        'candidate': {'passed': 51, 'failed': 2},
        'preExistingFailures': sorted(known),
        'fixedFailures': sorted(fixed),
        'newRegressionTestsPassed': 8,
        'baseImageId': state['app']['imageId'],
        'candidateImageId': state['candidateImageId'],
        'baselineLogSha256': core.digest(baseline.encode()),
        'candidateLogSha256': core.digest(candidate.encode()),
        'sources': state['after'],
    }
    core.save('baseline-comparison.json', result)
    core.save('verified.json', {
        'passed': True, 'imageId': state['candidateImageId'], 'sources': state['after'],
    })
print(json.dumps(result))

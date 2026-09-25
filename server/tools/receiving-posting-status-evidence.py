"""Validate the final evidence and emit the scoped release gate."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/receiving-posting-status'


def load(path):
    return json.loads(path.read_text())


def captured(name):
    content = subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'mbbs-receipt-status-0-runner',
                                      'cat', '/app/test-artifacts/receiving-posting-status/' + name + '.json'])
    target = ARTIFACT / (name + '.json')
    target.write_bytes(content)
    return json.loads(content)


manifest = load(ARTIFACT / 'release/manifest.json')
sources = {name: hashlib.sha256((SERVER / name).read_bytes()).hexdigest() for name in manifest['workspace']}
assert sources == manifest['workspace'], 'Release source changed'
for name in ['focused', 'health', 'mutations', 'coverage']:
    proof = captured(name)
    assert proof['sources'] == sources, 'Stale ' + name
    if name in ['focused', 'health']:
        assert '# fail 0' in proof['counts']
    elif name == 'mutations':
        assert all(row['killed'] for row in proof['evidence'])
    else:
        assert proof['missing'] == [] and proof['executed'] == proof['total']
browser = captured('browser')
assert len(browser) == 4 and all(row['submissions'] == 1 and row['browserErrors'] == 0 for row in browser)
before, after = load(ARTIFACT / 'baseline-static.json'), load(ARTIFACT / 'candidate-static.json')
assert after['sources'] == sources
for key in ['lint', 'diagnostics']:
    assert not (Counter(after[key]) - Counter(before[key])), 'New static findings: ' + key
full = (ARTIFACT / 'final-full.log').read_text()
assert re.search(r'Isolated MBT main run (?:passed|failed)', full), 'Full suite has not finished'
failed = sorted(set(re.findall(r'^✖ (.+?) \([\d.]+m?s\)$', full, re.M)))
baseline = load(SERVER / 'test/receiving-posting-status-baseline.json')
unexpected = sorted(set(failed) - set(baseline['failureNames']))
assert not unexpected, 'New full-suite failures: ' + repr(unexpected)
failure_summary = re.search(r'Isolated MBT main run failed in \d+/\d+ file\(s\): (.+)', full)
failed_files = failure_summary[1].split(', ') if failure_summary else []
assert not (set(failed_files) - set(baseline['failureFiles'])), 'New failing test files'
counts = {}
for key, value in re.findall(r'^ℹ (tests|pass|fail|skipped) (\d+)$', full, re.M):
    counts[key] = counts.get(key, 0) + int(value)
release_tests = (ARTIFACT / 'release-tests.log').read_text()
assert '# fail 0\n' in release_tests and not re.search(r'^not ok ', release_tests, re.M)
release_browser = load(ARTIFACT / 'release-browser.log')
assert len(release_browser) == 4 and all(row['submissions'] == 1 and row['browserErrors'] == 0 for row in release_browser)
candidate = {name: hashlib.sha256((ARTIFACT / 'release/candidate' / name).read_bytes()).hexdigest() for name in sources}
assert candidate == manifest['after']
result = {'passed': True, 'sources': sources, 'candidateSources': candidate, 'fullSuite': counts,
          'newFullSuiteFailures': unexpected, 'existingFailureNames': len(failed),
          'existingFailureFiles': len(failed_files),
          'newLintFindings': 0, 'newTypeFindings': 0}
(ARTIFACT / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))

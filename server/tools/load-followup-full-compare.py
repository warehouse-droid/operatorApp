"""Compare final complete runs and keep unrelated baseline failures explicit."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/load-followup'


def summarize(name):
    source = (ARTIFACT / ('full-' + name + '.log')).read_text()
    current = None
    failures = set()
    totals = dict.fromkeys(['tests', 'pass', 'fail', 'skipped', 'cancelled'], 0)
    files = []
    for line in source.splitlines():
        if line.startswith('[isolation]'):
            current = line.split('/app/')[-1]
            files.append(current)
        if line.startswith('✖ ') and line != '✖ failing tests:':
            failures.add((current, re.sub(r' \([\d.]+ms\)$', '', line[2:])))
        match = re.match(r'ℹ (tests|pass|fail|skipped|cancelled) (\d+)$', line)
        if match:
            totals[match[1]] += int(match[2])
    assert re.search(r'Isolated Load follow-up .* run (?:failed|passed)', source), 'Unfinished suite: ' + name
    return {'files': len(files), 'counts': totals, 'failures': sorted(failures)}


baseline, candidate = summarize('baseline'), summarize('candidate')
sources = [file for file in json.loads((ARTIFACT / 'files.json').read_text()) if file.startswith('src/')] + [
    'src/operator-load-state.js', 'src/operator-load-state-repository.js']
hashes = {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in sources}
report = {'baseline': baseline, 'candidate': candidate,
          'newFailures': [row for row in candidate['failures'] if row not in baseline['failures']], 'sourceHashes': hashes}
assert json.loads((ARTIFACT / 'full-candidate-sources.json').read_text()) == hashes, 'Final full suite source hashes differ'
for file, expected in json.loads((ARTIFACT / 'full-candidate-frontend-sources.json').read_text()).items():
    assert hashlib.sha256((ROOT / file).read_bytes()).hexdigest() == expected
assert candidate['files'] == baseline['files'] + 4
assert not report['newFailures'], report['newFailures']
assert candidate['counts']['cancelled'] == baseline['counts']['cancelled'] == 0
(ARTIFACT / 'full-comparison.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))

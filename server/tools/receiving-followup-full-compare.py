"""Compare complete MBT runs while retaining known failures verbatim."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = ROOT / 'test-artifacts/receiving-followup'


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
    assert re.search(r'Isolated Receiving follow-up .* run (?:failed|passed)', source), 'Full suite unfinished: ' + name
    return {'files': len(files), 'counts': totals, 'failures': sorted(failures)}


baseline = summarize('baseline')
candidate = summarize('candidate')
raw_new = [row for row in candidate['failures'] if row not in baseline['failures']]
cache = json.loads((ARTIFACT / 'cache-contracts.json').read_text())
assert '# fail 0' in cache['counts']
for file, expected in cache['testHashes'].items():
    assert hashlib.sha256((ROOT / file).read_bytes()).hexdigest() == expected, 'Stale cache contract rerun'
resolved = [row for row in raw_new if row[0] in cache['files']]
new = [row for row in raw_new if row not in resolved]
report = {'baseline': baseline, 'candidate': candidate, 'resolvedCacheFailures': resolved,
          'cacheContractRerun': cache, 'newFailures': new, 'sourceHashes': {
    file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in [
        'src/receiving-repository.js', 'src/operator-netsuite-posting-targets.js', 'src/receiving-receipt-progress.js']}}
(ARTIFACT / 'full-comparison.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
assert json.loads((ARTIFACT / 'full-candidate-sources.json').read_text()) == report['sourceHashes'], 'Stale full-suite sources'
assert cache['sourceHashes'] == report['sourceHashes'], 'Cache rerun must use the same implementation as the full suite'
assert not new, 'New full-suite failures'
assert candidate['counts']['cancelled'] == baseline['counts']['cancelled'] == 0

"""Summarize final artifacts and enforce changed backend line coverage and integrity."""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
folder = root / 'test-artifacts/operator-posting-latency'
manifest = json.loads((root / 'test/operator-posting-latency-changes.json').read_text())
for entry in manifest:
    assert hashlib.sha256((root / entry['file']).read_bytes()).hexdigest() == entry['afterSha256'], entry['file']
coverage = {}
for name in ['coverage', 'smoke-coverage']:
    coverage.update(json.loads((folder / name / 'coverage-final.json').read_text()))
coverage_rows = []
for entry in manifest:
    if not entry['file'].startswith('src/'):
        continue
    data = next((v for k, v in coverage.items() if k.endswith('/' + entry['file'])), None)
    assert data is not None, entry['file']
    lines = {}
    for key, span in data['statementMap'].items():
        for line in range(span['start']['line'], span['end']['line'] + 1):
            lines[line] = max(lines.get(line, 0), data['s'][key])
    changed = [line for line in entry['changedLines'] if line in lines]
    missing = [line for line in changed if not lines[line]]
    coverage_rows.append({'file': entry['file'], 'covered': len(changed) - len(missing), 'total': len(changed), 'missing': missing})
    assert not missing, (entry['file'], missing)

def totals(name):
    text = (folder / name).read_text()
    result = {key: sum(map(int, re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)$', text, re.M))) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert result['tests'] > 0, name
    return result

baseline, current = totals('baseline-full.log'), totals('full-final.log')
assert current['fail'] == baseline['fail'] == 2
mutants = json.loads((folder / 'mutations/results.json').read_text())
assert len(mutants) == 12 and all(row['killed'] for row in mutants)
pattern = re.compile(r'(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_|sk-proj-)[A-Za-z0-9]{25,})')
additions = '\n'.join(line[1:] for line in (root / 'test/operator-posting-latency.changes.patch').read_text().splitlines() if line.startswith('+') and not line.startswith('+++'))
assert not pattern.search(additions), 'Potential secret in task diff'
assert not any(entry['file'] in ['package.json', 'package-lock.json'] for entry in manifest)
summary = {
    'sourceState': hashlib.sha256(json.dumps([(row['file'], row['afterSha256']) for row in manifest]).encode()).hexdigest(),
    'baseline': baseline, 'full': current, 'focused': totals('focused-final.log'),
    'types': sum('error TS' in line for line in (folder / 'types-final.log').read_text().splitlines()),
    'lint': sum(len(row['messages']) for row in json.loads((folder / 'lint-final.log').read_text())),
    'coverage': coverage_rows, 'backendChangedLines': {
        'covered': sum(row['covered'] for row in coverage_rows), 'total': sum(row['total'] for row in coverage_rows)},
    'mutantsKilled': 10, 'propertyMutantsKilled': 2, 'newDependencies': 0, 'diffSecretScan': 'pass',
    'browser': json.loads((folder / 'browser.json').read_text()),
    'consolidationBrowser': totals('consolidation-browser-final.log'),
    'live': json.loads((folder / 'live.json').read_text()),
    'smoke': json.loads((folder / 'smoke.json').read_text())
}
(folder / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))

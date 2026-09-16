"""Validate task integrity, coverage and final results; summarize reproducible evidence."""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
folder = root / 'test-artifacts/consolidation-group-planning'
manifest = json.loads((root / 'test/consolidation-group-planning-changes.json').read_text())
for entry in manifest:
    assert hashlib.sha256((root / entry['file']).read_bytes()).hexdigest() == entry['afterSha256'], entry['file']
runtime = [entry for entry in manifest if entry['file'].startswith(('src/', 'public/', 'migrations/'))]
assert [entry['file'] for entry in runtime] == ['src/consolidation-load-repository.js']
coverage = json.loads((folder / 'coverage/coverage-final.json').read_text())
coverage_rows = []
for entry in runtime:
    data = next(value for key, value in coverage.items() if key.endswith('/' + entry['file']))
    lines = {}
    for key, span in data['statementMap'].items():
        for line in range(span['start']['line'], span['end']['line'] + 1):
            lines[line] = max(lines.get(line, 0), data['s'][key])
    changed = [line for line in entry['changedLines'] if line in lines]
    missing = [line for line in changed if not lines[line]]
    coverage_rows.append({'file': entry['file'], 'covered': len(changed) - len(missing), 'total': len(changed), 'missing': missing})
    assert not missing, missing

def totals(name):
    text = (folder / name).read_text()
    result = {key: sum(map(int, re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)$', text, re.M))) for key in ['tests', 'pass', 'fail', 'skipped']}
    assert result['tests'] > 0, name
    return result

def failures(name):
    return sorted(set(re.findall(r'^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$', (folder / name).read_text(), re.M)) - {'failing tests:'})

baseline, current = totals('baseline-full.log'), totals('full-final.log')
assert current['fail'] == baseline['fail'] == 2
assert failures('full-final.log') == failures('baseline-full.log')
assert current['tests'] == baseline['tests'] + 4
assert totals('focused-final.log')['fail'] == totals('browser-final.log')['fail'] == 0
assert all(row['accepted'] for row in json.loads((folder / 'checks.json').read_text()))
mutants = json.loads((folder / 'mutations/results.json').read_text())
assert len(mutants) == 8 and all(row['killed'] for row in mutants)
additions = '\n'.join(line[1:] for line in (root / 'test/consolidation-group-planning.changes.patch').read_text().splitlines() if line.startswith('+') and not line.startswith('+++'))
assert not re.search(r'(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_|sk-proj-)[A-Za-z0-9]{25,})', additions)
assert not any(entry['file'] in ['package.json', 'package-lock.json'] for entry in manifest)
summary = {
    'sourceState': hashlib.sha256(json.dumps([(row['file'], row['afterSha256']) for row in manifest]).encode()).hexdigest(),
    'baseline': baseline, 'full': current, 'knownFailures': failures('full-final.log'), 'focused': totals('focused-final.log'),
    'types': sum('error TS' in line for line in (folder / 'types-final.log').read_text().splitlines()),
    'lint': sum(len(row['messages']) for row in json.loads((folder / 'lint-final.log').read_text())),
    'coverage': coverage_rows, 'mutantsKilled': 4, 'propertyMutantsKilled': 4,
    'browser': totals('browser-final.log'), 'versions': json.loads((folder / 'tool-versions.log').read_text()),
    'newDependencies': 0, 'diffSecretScan': 'pass', 'live': json.loads((folder / 'live.json').read_text())
}
(folder / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))

"""Enforce full coverage of the changed JS lines, using the saved task baseline."""
from pathlib import Path
import difflib
import json

root = Path(__file__).resolve().parents[1]
artifact = root / 'test-artifacts/split-inbound-completion'
static = json.loads((artifact / 'static.json').read_text())
report = json.loads((artifact / 'coverage/coverage-final.json').read_text())
results = []
for file in static['hashes']:
    if not file.endswith('.js'):
        continue
    before = (artifact / 'baseline' / file).read_text().splitlines()
    after = (root / file).read_text().splitlines()
    entry = next((value for key, value in report.items() if key.endswith('/' + file)), None)
    assert entry is not None, file
    hits = {}
    for key, span in entry['statementMap'].items():
        for line in range(span['start']['line'], span['end']['line'] + 1):
            hits[line] = max(hits.get(line, 0), entry['s'][key])
    changed = [i + 1 for tag, a, b, c, d in difflib.SequenceMatcher(None, before, after).get_opcodes()
               if tag in ('insert', 'replace') for i in range(c, d)
               if after[i].strip() and not after[i].lstrip().startswith(('//', '/*', '*'))]
    missing = [line for line in changed if hits.get(line, 0) == 0]
    results.append({'file': file, 'changedLines': len(changed), 'coveredLines': len(changed) - len(missing), 'missing': missing})
(artifact / 'changed-coverage.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results))
assert all(not row['missing'] for row in results), 'A changed line lacks test execution.'

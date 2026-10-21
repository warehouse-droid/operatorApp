"""Combine unit, PostgreSQL and browser execution for the changed source lines."""
import difflib
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-artifacts/special-status-following-20261005'
BASELINE = ROOT / 'tools/special-status-following-20261005/baseline'
manifest = json.loads((OUT / 'summary.json').read_text())['manifest']
new_files = {'src/special-stock-status-refresh.js', 'src/special-stock-logistics.js'}
reports = [json.loads((OUT / name / 'coverage-final.json').read_text()) for name in ['coverage', 'db-coverage', 'browser-coverage']]
results = {}
for name, expected_hash in manifest.items():
    source = (ROOT / name).read_text()
    assert hashlib.sha256(source.encode()).hexdigest() == expected_hash, 'Stale source coverage: ' + name
    lines = source.splitlines()
    previous = [] if name in new_files else (BASELINE / name).read_text().splitlines()
    changed = set()
    for operation, _, _, start, end in difflib.SequenceMatcher(None, previous, lines).get_opcodes():
        if operation in ['replace', 'insert']:
            changed.update(range(start + 1, end + 1))
    instrumented = set()
    executed = set()
    branches = {}
    for report in reports:
        data = report.get('/app/' + name)
        if not data:
            continue
        for key, location in data['statementMap'].items():
            affected = changed.intersection(range(location['start']['line'], location['end']['line'] + 1))
            instrumented.update(affected)
            if data['s'][key]:
                executed.update(affected)
        for key, location in data['branchMap'].items():
            if not changed.intersection(range(location['loc']['start']['line'], location['loc']['end']['line'] + 1)):
                continue
            signature = json.dumps(location, sort_keys=True)
            branches[signature] = [max(a, b) for a, b in zip(branches.get(signature, [0] * len(data['b'][key])), data['b'][key])]
    missed = sorted(instrumented - executed)
    assert instrumented, 'Missing coverage source: ' + name
    results[name] = {'changedInstrumentedLines': len(instrumented), 'executed': len(instrumented & executed),
                     'missed': [{'line': number, 'source': lines[number - 1].strip()} for number in missed],
                     'branches': {'covered': sum(bool(count) for counts in branches.values() for count in counts),
                                  'total': sum(len(counts) for counts in branches.values())}}
summary = {'sources': results, 'changedInstrumentedLines': sum(value['changedInstrumentedLines'] for value in results.values()),
           'executed': sum(value['executed'] for value in results.values()), 'allExecuted': all(not value['missed'] for value in results.values())}
(OUT / 'changed-line-coverage.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
assert summary['allExecuted'], 'Some changed instrumented lines have no execution evidence'

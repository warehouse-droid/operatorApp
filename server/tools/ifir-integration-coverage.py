"""Report changed-line coverage against the recorded pre-integration source."""
import difflib
import json
import os
from pathlib import Path
import sys

server = Path(__file__).resolve().parents[1]
source = Path(os.environ.get('IFIR_INTEGRATION_SOURCE_ROOT', str(server / 'src'))).parent
baseline = Path(os.environ.get('IFIR_INTEGRATION_BASELINE_ROOT',
                    str(server / 'artifacts/ifir-posting-integration-20261021/before')))
output = Path(sys.argv[1])
report = json.loads((output / 'report.json').read_text())
coverage = json.loads((output / 'coverage/coverage-final.json').read_text())
result = {}
for name in report['source']:
    original = baseline / name
    before = original.read_text().splitlines() if original.exists() else []
    after = (source / name).read_text().splitlines()
    changes = difflib.SequenceMatcher(None, before, after, autojunk=False)
    changed = {line + 1 for tag, _, _, start, end in changes.get_opcodes()
               if tag in ['insert', 'replace'] for line in range(start, end)}
    row = coverage['/app/' + name]
    counts = {}
    for key, location in row['statementMap'].items():
        for line in range(location['start']['line'], location['end']['line'] + 1):
            counts[line] = max(counts.get(line, 0), row['s'][key])
    relevant = changed.intersection(counts)
    missing = sorted(line for line in relevant if counts[line] == 0)
    result[name] = {'covered': len(relevant) - len(missing), 'total': len(relevant),
                    'missing': missing}
report['changedLineCoverage'] = result
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'changedLineCoverage': result}))
assert not any(row['missing'] for row in result.values()), 'Untested changed lines'

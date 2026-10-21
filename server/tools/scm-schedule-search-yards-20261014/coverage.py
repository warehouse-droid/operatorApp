"""Report changed executable coverage against the task's actual source baseline."""
import difflib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/scm-schedule-search-yards-20261014'
coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())
results = []
for file in ['src/scm-order-visibility.js', 'src/server.js', 'src/dispatch-repository.js', 'public/scm-schedule.js']:
    before = (OUT / 'before' / file).read_text().splitlines()
    after = (SERVER / file).read_text().splitlines()
    changed = set()
    for tag, _a, _b, c, d in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if tag in ['insert', 'replace']:
            changed.update(range(c + 1, d + 1))
    record = next(value for key, value in coverage.items() if key.endswith('/' + file))
    executable = {}
    for key, statement in record['statementMap'].items():
        for line in range(statement['start']['line'], statement['end']['line'] + 1):
            if line in changed and after[line - 1].strip() and not after[line - 1].lstrip().startswith(('//', '*', 'import')):
                executable[line] = max(executable.get(line, 0), record['s'][key])
    branches = [{'line': branch['line'], 'counts': record['b'][key]}
                for key, branch in record['branchMap'].items() if branch['line'] in changed]
    results.append({'file': file, 'changedExecutable': len(executable), 'covered': sum(bool(value) for value in executable.values()),
                    'missing': [line for line, value in executable.items() if not value], 'changedBranches': branches})
result = {'files': results, 'missing': [{'file': row['file'], 'line': line} for row in results for line in row['missing']],
          'uncoveredBranches': [{'file': row['file'], **branch} for row in results for branch in row['changedBranches']
                                if not all(branch['counts'])]}
(OUT / 'changed-coverage.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
assert not result['missing']
assert not result['uncoveredBranches']

"""Compare the immutable live baseline with coverage of the scoped candidate."""
import difflib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-if-static-lines-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-if-static-lines'
manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
coverage = json.loads((ARTIFACT / 'coverage/coverage-final.json').read_text())
report = {}
for name in manifest['changes']:
    if not name.endswith('.js'):
        # HTML cache version is verified by the executable asset contract.
        continue
    old = STATE / 'baseline/app' / name
    before = old.read_text().splitlines() if old.exists() else []
    after = (STATE / 'candidate' / name).read_text().splitlines()
    changed = set()
    for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if tag in ['insert', 'replace']:
            changed.update(range(start + 1, end + 1))
    data = coverage.get('/app/' + name)
    assert data, f'Missing coverage for {name}'
    hit = {}
    for key, statement in data['statementMap'].items():
        for line in range(statement['start']['line'], statement['end']['line'] + 1):
            hit[line] = max(hit.get(line, 0), data['s'][key])
    executable = {line for line in changed if line in hit and after[line - 1].strip()
                  and not after[line - 1].lstrip().startswith(('//', '/*', '*'))}
    uncovered = [{'line': line, 'text': after[line - 1]} for line in sorted(executable) if not hit[line]]
    report[name] = {'changedCovered': len(executable) - len(uncovered),
                    'changedExecutable': len(executable), 'uncovered': uncovered}
result = {'files': report, 'covered': sum(row['changedCovered'] for row in report.values()),
          'executable': sum(row['changedExecutable'] for row in report.values()),
          'uncovered': [{'file': name, **line} for name, row in report.items() for line in row['uncovered']]}
(ARTIFACT / 'changed-coverage.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['covered', 'executable', 'uncovered']}))
sys.exit(bool(result['uncovered']))

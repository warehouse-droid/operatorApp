"""Map changed executable lines to the final c8 coverage report."""
import difflib
import json
from pathlib import Path

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / 'test-artifacts/split-allocation-target-20261020'
coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())

result = {'files': {}, 'missing': []}
for name in [name for name in json.loads((TASK / 'files.json').read_text()) if name.endswith('.js')]:
    before = (TASK / 'baseline' / name).read_text().splitlines() if (TASK / 'baseline' / name).exists() else []
    after = (TASK / 'candidate' / name).read_text().splitlines()
    changed = []
    for tag, _a, _b, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if tag not in ['insert', 'replace']:
            continue
        changed += [i + 1 for i in range(start, end) if after[i].strip() and not after[i].strip().startswith(('//', '/**', '*'))]
    info = next(value for path, value in coverage.items() if path.endswith('/' + name))
    covered = set()
    for key, stmt in info['statementMap'].items():
        if info['s'][key] > 0:
            covered.update(range(stmt['start']['line'], stmt['end']['line'] + 1))
    missing = [line for line in changed if line not in covered]
    result['files'][name] = {'changedLines': changed, 'covered': len(changed) - len(missing), 'total': len(changed)}
    result['missing'] += [{'file': name, 'line': line} for line in missing]
(OUT / 'changed-coverage.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
assert not result['missing']

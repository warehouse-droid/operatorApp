"""Report statement coverage of added runtime lines relative to the captured source."""
import difflib
import json
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/special-item-planning-20261009'
FILE = 'src/dispatch-plan-repository.js'
before = (SERVER / 'tools/special-item-planning-20261009/baseline' / FILE).read_text().splitlines()
after = (SERVER / FILE).read_text().splitlines()
added = []
deleted = 0
patch = ''.join(difflib.unified_diff([line + '\n' for line in before], [line + '\n' for line in after], fromfile='before/' + FILE, tofile='after/' + FILE))
for tag, first, last, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
    if tag in ['replace', 'insert']:
        added.extend(range(start + 1, end + 1))
    if tag in ['replace', 'delete']:
        deleted += last - first
coverage = json.loads((OUT / 'coverage/coverage-final.json').read_text())
entry = next(value for key, value in coverage.items() if key.endswith('/' + FILE))
covered = set()
for key, statement in entry['statementMap'].items():
    if entry['s'][key] > 0:
        covered.update(range(statement['start']['line'], statement['end']['line'] + 1))
missing = [line for line in added if line not in covered]
result = {'file': FILE, 'addedLines': added, 'coveredAddedLines': len(added) - len(missing),
          'totalAddedLines': len(added), 'missing': missing, 'deletedLines': deleted}
(OUT / 'runtime.patch').write_text(patch)
(OUT / 'changed-coverage.json').write_text(json.dumps(result, indent=2) + '\n')
assert not missing, result
print(json.dumps(result))

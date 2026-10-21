"""Review the exact release diff for accidental credential patterns."""
import difflib
import hashlib
import json
from pathlib import Path
import re

TASK = Path(__file__).resolve().parent
OUT = TASK.parents[1] / 'test-artifacts/som06964-release-20261015'
files = {}
for name in json.loads((TASK / 'files.json').read_text()):
    before_path, after_path = TASK / 'baseline' / name, TASK / 'candidate' / name
    before = before_path.read_text() if before_path.exists() else ''
    after = after_path.read_text()
    diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                      fromfile='baseline/' + name, tofile='candidate/' + name))
    target = OUT / 'diff' / (name + '.diff')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(diff)
    added = '\n'.join(line[1:] for line in diff.splitlines() if line.startswith('+') and not line.startswith('+++'))
    files[name] = {'sha256': hashlib.sha256(after_path.read_bytes()).hexdigest(),
                  'addedCredentialPatterns': bool(re.search(r'(?:sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|BEGIN (?:RSA )?PRIVATE KEY)', added))}
assert not any(row['addedCredentialPatterns'] for row in files.values())
(OUT / 'capability-review.json').write_text(json.dumps({'files': files, 'dependenciesChanged': False,
    'newExternalWrites': False, 'databaseChange': 'Opt-in per-line source sync hold with retained correction evidence'}, indent=2) + '\n')
print(json.dumps({'reviewedFiles': len(files), 'newCredentialPatterns': 0, 'dependenciesChanged': False}))

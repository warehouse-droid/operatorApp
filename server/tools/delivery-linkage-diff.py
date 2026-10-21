"""Record the exact candidate's changed runtime lines for fresh coverage evidence."""
import difflib
import hashlib
import json
from pathlib import Path

server = Path(__file__).resolve().parents[1]
release = server / 'deployments/delivery-so-linkage-20261008'
out = server / 'test-artifacts/delivery-so-linkage-20261008/final/results'
out.mkdir(parents=True, exist_ok=True)
manifest = json.loads((release / 'manifest.json').read_text())
result, patches = {}, []
for name in manifest['files']:
    before = (release / 'before' / name).read_text().splitlines(keepends=True)
    current = (release / 'candidate' / name).read_bytes()
    after = current.decode().splitlines(keepends=True)
    lines = []
    for tag, _a, _b, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if tag in ('replace', 'insert'):
            lines.extend(range(start + 1, end + 1))
    result[name] = {'lines': lines, 'sourceHash': hashlib.sha256(current).hexdigest()}
    patches.extend(difflib.unified_diff(before, after, fromfile='live/' + name, tofile='candidate/' + name))
(out / 'changed-lines-input.json').write_text(json.dumps(result, indent=2) + '\n')
(out.parent.parent / 'changes.patch').write_text(''.join(patches))
print(json.dumps({'changedFiles': len(result), 'candidateTreeHash': manifest['candidateTreeHash']}))

"""Capture only this task's production edits against its frozen starting files."""
from pathlib import Path
import difflib
import hashlib
import json
import sys

root = Path(__file__).resolve().parents[1]
baseline = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/link-to-group-baseline')
files = ['public/dispatch.js', 'public/dispatch.html', 'src/order-dependency-repository.js',
         'src/dispatch-delivery-group-repository.js', 'src/sales-order-reconciliation.js',
         'src/yard-dependency-structure.js', 'src/scm-dependency-preview-service.js', 'src/server.js']
manifest, patch = [], []
for name in files:
    before = (baseline / name).read_text().splitlines(keepends=True)
    after = (root / name).read_text().splitlines(keepends=True)
    changed = []
    for tag, _, _, start, end in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if tag in ('replace', 'insert'):
            changed.extend(range(start + 1, end + 1))
    manifest.append(dict(file=name, lines=changed,
                         sha256=hashlib.sha256((root / name).read_bytes()).hexdigest(),
                         baselineSha256=hashlib.sha256((baseline / name).read_bytes()).hexdigest()))
    patch.extend(difflib.unified_diff(before, after, fromfile=f'a/{name}', tofile=f'b/{name}'))
(root / 'test/support/link-to-group-changes.json').write_text(json.dumps(manifest, indent=2) + '\n')
(root / 'test/support/link-to-group-changes.patch').write_text(''.join(patch))
print(f'{len(files)} production files; {sum(len(row["lines"]) for row in manifest)} changed lines')

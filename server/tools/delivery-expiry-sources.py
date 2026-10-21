"""Capture the exact expiry source state and changed lines before verification."""
from pathlib import Path
import difflib
import hashlib
import json

server = Path(__file__).resolve().parents[1]
baseline = server / 'test-artifacts/delivery-expiry-20261016/baseline'
files = ['src/delivery-request-domain.js', 'src/delivery-request-repository.js',
         'public/delivery-request-expiry-time.js', 'public/delivery-requests.js',
         'public/delivery-requests.css', 'public/delivery-requests.html', 'public/delivery-request-alert.js']
result = {}
patch = []
for name in files:
    source = server / name
    original = baseline / source.name
    before = original.read_text().splitlines(True) if original.exists() else []
    after = source.read_text().splitlines(True)
    changed = []
    for tag, _, _, start, end in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes():
        if tag in ('replace', 'insert'):
            changed.extend(range(start + 1, end + 1))
    result[name] = {'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'lines': changed}
    patch.extend(difflib.unified_diff(before, after, fromfile='before/' + name, tofile='after/' + name))
(server / 'tools/delivery-expiry-sources.json').write_text(json.dumps(result, indent=2) + '\n')
(baseline.parent / 'changes.patch').write_text(''.join(patch))

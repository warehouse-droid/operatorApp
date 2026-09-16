"""Capture this task's diff against the preserved pre-task source, without git reset."""
import difflib
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
baseline = Path('/tmp/operator-posting-latency-baseline')
records = []
patches = []
for folder in ['src', 'public', 'migrations', 'test/mbt', 'test/dispatch/frontend', 'tools', 'package.json', 'package-lock.json']:
    for target in sorted([(root / folder)] if (root / folder).is_file() else (root / folder).rglob('*')):
        if not target.is_file() or '__pycache__' in target.parts:
            continue
        relative = target.relative_to(root)
        prior = baseline / relative
        old = prior.read_bytes() if prior.exists() else b''
        new = target.read_bytes()
        if old == new:
            continue
        before = old.decode().splitlines(keepends=True)
        after = new.decode().splitlines(keepends=True)
        edits = []
        changed = []
        for tag, a, b, c, d in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
            if tag != 'equal':
                edits.append({'start': c, 'end': d, 'before': before[a:b]})
                changed.extend(range(c + 1, d + 1))
        records.append({'file': str(relative), 'beforeSha256': hashlib.sha256(old).hexdigest() if prior.exists() else None,
                        'afterSha256': hashlib.sha256(new).hexdigest(), 'edits': edits, 'changedLines': changed})
        patches.extend(difflib.unified_diff(before, after, fromfile=str(relative), tofile=str(relative)))
(root / 'test/operator-posting-latency-changes.json').write_text(json.dumps(records, indent=2) + '\n')
(root / 'test/operator-posting-latency.changes.patch').write_text(''.join(patches))
print(json.dumps({'files': len(records), 'runtimeFiles': [r['file'] for r in records if r['file'].startswith(('src/', 'public/', 'migrations/'))]}))

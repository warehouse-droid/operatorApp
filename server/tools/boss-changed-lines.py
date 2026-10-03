"""Record task changes against preimages, preserving the workspace's prior edits."""
from pathlib import Path
import difflib
import json

base = Path('test-artifacts/boss-approvals/baseline')
existing = ['src/server.js', 'src/auth-repository.js', 'src/netsuite.js',
            'src/netsuite-delayed-status-refresh-service.js', 'public/control.js',
            'public/app-sidebar.js', 'public/login.js', 'public/dispatch-auth.js',
            'public/service-worker.js']
new = [str(p) for p in Path('src').glob('boss-approval-*.js')]
new += ['src/account-email.js', 'public/boss.js', 'public/boss-admin.js']
changed, diff = {}, []
for name in existing + new:
    before = (base / name).read_text().splitlines(True) if (base / name).exists() else []
    after = Path(name).read_text().splitlines(True)
    indexes = []
    for tag, _i, _j, start, end in difflib.SequenceMatcher(a=before, b=after).get_opcodes():
        if tag in ('replace', 'insert'):
            indexes.extend(range(start + 1, end + 1))
    changed[name] = indexes
    diff.extend(difflib.unified_diff(before, after, fromfile='before/' + name, tofile=name))
Path('test-artifacts/boss-approvals/changed-lines.json').write_text(json.dumps(changed, indent=2))
Path('test-artifacts/boss-approvals/task.diff').write_text(''.join(diff))

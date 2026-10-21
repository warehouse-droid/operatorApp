"""Apply only this release's diff to the workspace, preserving unrelated edits."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
FILES = json.loads((TASK / 'files.json').read_text())
OUT = SERVER / 'test-artifacts/split-quantity-20261020'
summary = json.loads((OUT / 'summary.json').read_text())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
original = {name: digest(SERVER / name) for name in FILES}
with tempfile.TemporaryDirectory(prefix='split-quantity-workspace-') as temporary:
    stage = Path(temporary)
    patch = ''
    for name in FILES:
        before = TASK / 'baseline' / name
        candidate = TASK / 'candidate' / name
        assert digest(candidate) == summary['hashes'][name]
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if before.exists():
            shutil.copy2(SERVER / name, target)
            patch += ''.join(difflib.unified_diff(before.read_text().splitlines(True),
                candidate.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
        else:
            assert not (SERVER / name).exists()
            shutil.copy2(candidate, target)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(stage)], input=patch,
                            text=True, capture_output=True)
    (OUT / 'workspace-patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0
    assert all(digest(SERVER / name) == value for name, value in original.items()), 'Workspace changed'
    for name in FILES:
        backup = TASK / 'workspace-before-publish' / name
        backup.parent.mkdir(parents=True, exist_ok=True)
        if (SERVER / name).exists():
            shutil.copy2(SERVER / name, backup)
        shutil.copy2(stage / name, SERVER / name)
(OUT / 'workspace-sync.json').write_text(json.dumps({
    'before': original, 'after': {name: digest(SERVER / name) for name in FILES},
    'unrelatedEditsPreserved': True
}, indent=2) + '\n')
print(json.dumps({'workspaceUpdated': FILES, 'unrelatedEditsPreserved': True}))

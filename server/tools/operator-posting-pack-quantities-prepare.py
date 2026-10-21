"""Keep the release candidate and exact scoped source evidence current."""
import difflib
import hashlib
import json
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-pack-quantities-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-posting-pack-quantities'
data = json.loads((ARTIFACT / 'manifest.json').read_text())
patch = ''
for name, change in data['changes'].items():
    path = ROOT / 'server' / name
    old = STATE / 'baseline/app' / name
    candidate = STATE / 'candidate' / name
    candidate.parent.mkdir(parents=True, exist_ok=True)
    change['workspaceAfter'] = hashlib.sha256(path.read_bytes()).hexdigest()
    if change['before'] != change['workspaceBefore']:
        workspace_before = STATE / 'workspace-before' / name
        assert hashlib.sha256(workspace_before.read_bytes()).hexdigest() == change['workspaceBefore']
        shutil.copy2(old, candidate)
        task_patch = ''.join(difflib.unified_diff(workspace_before.read_text().splitlines(True),
            path.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
        if task_patch:
            result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1'], input=task_patch,
                text=True, cwd=STATE / 'candidate', capture_output=True)
            assert result.returncode == 0, result.stdout + result.stderr
    else:
        shutil.copy2(path, candidate)
    change['after'] = hashlib.sha256(candidate.read_bytes()).hexdigest()
    patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],
        candidate.read_text().splitlines(True), fromfile='a/' + name if old.exists() else '/dev/null', tofile='b/' + name))
(ARTIFACT / 'manifest.json').write_text(json.dumps(data, indent=2) + '\n')
(ARTIFACT / 'release.patch').write_text(patch)
print(json.dumps({'files': len(data['changes']), 'sourcePrepared': True}))

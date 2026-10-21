"""Capture the running app, then overlay only this task's source delta."""
import datetime
import difflib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/operator-if-static-lines-20261010')
ARTIFACT = ROOT / 'server/test-artifacts/operator-if-static-lines'
NAMES = ['src/operator-netsuite-posting-fulfillment-lines.js',
         'src/operator-netsuite-posting-netsuite-adapter.js', 'src/netsuite.js']
spec = importlib.util.spec_from_file_location('core', ROOT / 'server/tools/operator-to-yard-flow-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.STATE = STATE
core.ARTIFACT = ARTIFACT
core.SERVICES = {'app': 'mbbs-operator-app-app-1'}
core.NAMES = [name.removeprefix('src/') for name in NAMES]


def capture():
    assert not (ARTIFACT / 'manifest.json').exists(), 'Preserve the original capture'
    STATE.mkdir(parents=True, exist_ok=True)
    ARTIFACT.mkdir(parents=True, exist_ok=True)
    core.capture()
    before = json.loads((STATE / 'before.private.json').read_text())
    before['webhook-worker'] = core.inspect('mbbs-operator-app-webhook-worker-1')
    core.save(STATE / 'before.private.json', before)
    shutil.copytree(STATE / 'baseline/app', STATE / 'candidate')
    changes = {}
    for name in NAMES:
        live = STATE / 'baseline/app' / name
        workspace = ROOT / 'server' / name
        saved = STATE / 'workspace-before' / name
        if workspace.exists():
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(workspace, saved)
        changes[name] = {'before': core.digest(live) if live.exists() else None,
                         'workspaceBefore': core.digest(saved) if saved.exists() else None}
    core.save(ARTIFACT / 'manifest.json', {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'baseImage': before['app']['Image'], 'changes': changes})
    print(json.dumps({'captured': True, 'files': len(changes), 'baseImage': before['app']['Image']}))


def prepare():
    data = json.loads((ARTIFACT / 'manifest.json').read_text())
    patch = ''
    for name, change in data['changes'].items():
        path = ROOT / 'server' / name
        old = STATE / 'baseline/app' / name
        candidate = STATE / 'candidate' / name
        saved = STATE / 'workspace-before' / name
        candidate.parent.mkdir(parents=True, exist_ok=True)
        change['workspaceAfter'] = core.digest(path)
        if change['before'] != change['workspaceBefore']:
            assert saved.exists() and core.digest(saved) == change['workspaceBefore']
            shutil.copy2(old, candidate)
            task_patch = ''.join(difflib.unified_diff(saved.read_text().splitlines(True),
                path.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
            if task_patch:
                result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1'], input=task_patch,
                    text=True, cwd=STATE / 'candidate', capture_output=True)
                assert result.returncode == 0, result.stdout + result.stderr
        else:
            shutil.copy2(path, candidate)
        change['after'] = core.digest(candidate)
        patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],
            candidate.read_text().splitlines(True), fromfile='a/' + name if old.exists() else '/dev/null', tofile='b/' + name))
    core.save(ARTIFACT / 'manifest.json', data)
    (ARTIFACT / 'release.patch').write_text(patch)
    print(json.dumps({'prepared': True, 'files': len(data['changes'])}))


if __name__ == '__main__':
    os.umask(0o077)
    {'capture': capture, 'prepare': prepare}[sys.argv[1]]()

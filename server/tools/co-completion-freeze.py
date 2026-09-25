"""Isolate this task's recorded patch from concurrent shared-workspace changes."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess

SERVER = Path(__file__).resolve().parents[1]
BASELINE = Path('/home/ubuntu/co-completion-baseline-20260918')
ROOT = Path('/home/ubuntu/co-completion-verified-20260918')
TARGET = ROOT / 'server'
assert not TARGET.exists(), 'Refusing to replace a verification tree'
shutil.copytree(BASELINE, TARGET)
shutil.copytree(SERVER.parent / '.github', ROOT / '.github')
(ROOT / 'docker').mkdir()
for name in ['v2.env.example', 'prepare-env.mjs', 'set-host-port.mjs', 'README.md', 'update-vm.sh']:
    if (SERVER.parent / 'docker' / name).exists():
        shutil.copy2(SERVER.parent / 'docker' / name, ROOT / 'docker' / name)
for path in SERVER.parent.glob('docker-compose*.yml'):
    shutil.copy2(path, ROOT / path.name)
patch = (SERVER / 'test/support/co-completion-changes.patch').read_text()
subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(TARGET)], input=patch, text=True, check=True)
for item in json.loads((SERVER / 'test/support/co-completion-changes.json').read_text()):
    assert hashlib.sha256((TARGET / item['file']).read_bytes()).hexdigest() == item['sha256'], item['file']
for directory in ['tools', 'test/support']:
    for path in (SERVER / directory).glob('co-completion-*'):
        if path.is_file():
            shutil.copy2(path, TARGET / directory / path.name)
for path in (SERVER / 'test/mbt').rglob('co-completion*.test.js'):
    shutil.copy2(path, TARGET / path.relative_to(SERVER))
shutil.copy2(SERVER / 'test/co-completion-spec.md', TARGET / 'test/co-completion-spec.md')
(TARGET / 'test-artifacts').symlink_to(SERVER / 'test-artifacts', target_is_directory=True)
print(json.dumps({'verificationRoot': str(TARGET), 'productionFiles': 7, 'unrelatedWorkPreserved': True}))

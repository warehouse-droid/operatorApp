"""Capture a concurrent live release without replacing tested source."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

TASK = Path(__file__).resolve().parent
APP = 'mbbs-operator-app-app-1'
docker = ['sudo', '-n', 'docker']
identity = json.loads(subprocess.check_output(docker + ['inspect', '--format', '{"imageId":"{{.Image}}","containerId":"{{.Id}}"}', APP]))
root = TASK / 'live-refresh'
root.mkdir(exist_ok=True)
data = subprocess.check_output(docker + ['exec', APP, 'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'migrations'])
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    archive.extractall(root, filter='data')
after = json.loads(subprocess.check_output(docker + ['inspect', '--format', '{"imageId":"{{.Image}}","containerId":"{{.Id}}"}', APP]))
assert identity == after
(root / 'capture.json').write_text(json.dumps(identity, indent=2) + '\n')
changes = []
for path in root.rglob('*'):
    if not path.is_file() or path.name == 'capture.json':
        continue
    rel = str(path.relative_to(root))
    old = TASK / 'baseline' / rel
    if not old.exists() or old.read_bytes() != path.read_bytes():
        changes.append(rel)
(root / 'changes.json').write_text(json.dumps(changes, indent=2) + '\n')
print(json.dumps({'identity': identity, 'changedFiles': changes}))

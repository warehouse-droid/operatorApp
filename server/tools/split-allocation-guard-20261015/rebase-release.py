"""Adopt only a disjoint concurrent release; keep the tested reopen files exact."""
import hashlib
import json
from pathlib import Path
import subprocess

TASK = Path(__file__).resolve().parent
read = lambda path: json.loads(path.read_text())
capture = read(TASK / 'capture.json')
fresh = read(TASK / 'live-refresh/capture.json')
changes = read(TASK / 'live-refresh/changes.json')
files = read(TASK / 'files.json')
assert not set(changes).intersection(files), 'An overlapping change requires a tested merge'
current = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'inspect', '--format', '{"imageId":"{{.Image}}","containerId":"{{.Id}}"}', 'mbbs-operator-app-app-1']))
assert current == fresh
for name in files:
    old, new = TASK / 'baseline' / name, TASK / 'live-refresh' / name
    assert (old.read_bytes() if old.exists() else b'') == (new.read_bytes() if new.exists() else b'')
hashes = {name: hashlib.sha256((TASK / 'live-refresh' / name).read_bytes()).hexdigest() for name in changes}
record = {'testedBase': capture, 'deploymentBase': fresh, 'disjointFilesPreserved': hashes,
          'allReopenRuntimeBaselinesUnchanged': True}
(TASK / 'release-rebase.json').write_text(json.dumps(record, indent=2) + '\n')
(TASK / 'capture.json').write_text(json.dumps(fresh, indent=2) + '\n')
print(json.dumps(record))

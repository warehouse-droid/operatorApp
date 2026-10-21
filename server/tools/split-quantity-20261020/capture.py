import io
import json
import shutil
import subprocess
import tarfile
from pathlib import Path

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
DOCKER = ['sudo', '-n', 'docker']
APP = 'mbbs-operator-app-app-1'

def identity():
    return json.loads(subprocess.check_output(DOCKER + ['inspect', '--format',
        '{"imageId":"{{.Image}}","containerId":"{{.Id}}"}', APP]))

before = identity()
assert not (TASK / 'baseline').exists()
(TASK / 'baseline').mkdir()
data = subprocess.check_output(DOCKER + ['exec', APP, 'tar', '-C', '/app', '-cf', '-',
    'src', 'public', 'migrations', 'package.json', 'package-lock.json'])
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    archive.extractall(TASK / 'baseline', filter='data')
assert identity() == before
shutil.copytree(TASK / 'baseline', TASK / 'candidate')
for name in json.loads((TASK / 'files.json').read_text()):
    path = SERVER / name
    if path.exists():
        dest = TASK / 'workspace-before' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
(TASK / 'capture.json').write_text(json.dumps(before, indent=2) + '\n')
print(json.dumps(before))

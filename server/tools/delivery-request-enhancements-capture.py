"""Capture only nonsecret runtime source and immutable release identity."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'server/test-artifacts/delivery-enhancements-20261013/live-before'
APP = 'mbbs-operator-app-app-1'
FILES = ['src/delivery-request-domain.js', 'src/delivery-request-repository.js',
         'src/delivery-request-router.js', 'src/netsuite.js',
         'public/delivery-requests.js', 'public/delivery-requests.css', 'public/delivery-request-alert.js']
OUT.mkdir(parents=True, exist_ok=True)
identity = subprocess.check_output(['docker', 'inspect', '--format', '{{.Id}} {{.Image}} {{.Config.Image}}', APP], text=True).split()
hashes = {}
for name in FILES:
    target = OUT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['docker', 'cp', f'{APP}:/app/{name}', str(target)], check=True)
    hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
different = [name for name in FILES if hashes[name] != hashlib.sha256((ROOT / 'server' / name).read_bytes()).hexdigest()]
(OUT / 'identity.json').write_text(json.dumps({'containerId': identity[0], 'imageId': identity[1], 'image': identity[2], 'hashes': hashes, 'workspaceDifferences': different}, indent=2) + '\n')
print(json.dumps({'capturedFiles': len(FILES), 'workspaceDifferences': different}))

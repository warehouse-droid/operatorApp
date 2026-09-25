"""Reconstruct captured worker source into a new directory; never deploy it."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

record = Path(__file__).resolve().parent
server = record.parents[1]
manifest = json.loads((record / 'manifest.json').read_text())
destination = Path(sys.argv[1]).resolve()
assert not destination.exists(), 'Choose a new output directory'
for name, sha in manifest['services']['app']['files'].items():
    assert hashlib.sha256((server / name).read_bytes()).hexdigest() == sha, 'Use a clean production checkout: ' + name
destination.mkdir(parents=True)
for name in manifest['services']['app']['files']:
    target = destination / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(server / name, target)
subprocess.run(['git', 'apply', '-p2', str(record / 'webhook-worker.patch')], cwd=destination, check=True)
for name in json.loads((record / 'worker-deletions.json').read_text()):
    (destination / name).unlink()
actual = {str(file.relative_to(destination)): hashlib.sha256(file.read_bytes()).hexdigest()
          for file in destination.rglob('*') if file.is_file()}
assert actual == manifest['services']['webhook-worker']['files']
print(f'Worker source verified: {len(actual)} files in {destination}')

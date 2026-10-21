"""Capture non-secret production source before preparing the BIN release."""
from pathlib import Path
import hashlib
import importlib.util
import io
import json
import os
import tarfile

os.umask(0o077)
root = Path(__file__).resolve().parents[1]
release = root / 'test-artifacts/mbt-bin-planning-release-20260927'
release.mkdir(exist_ok=False, mode=0o700)
spec = importlib.util.spec_from_file_location('core', root / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
services = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
metadata = {service: core.metadata(container) for service, container in services.items()}
assert len({row['imageId'] for row in metadata.values()}) == 1
verified = json.loads((root / 'test-artifacts/mbt-bin-planning/final/result.json').read_text())
assert not verified['unexpected_failures']
assert all(hashlib.sha256((root / file).read_bytes()).hexdigest() == digest for file, digest in verified['files'].items())
files = [file for file in verified['files'] if file.startswith(('src/', 'public/', 'migrations/'))]
baseline = release / 'baseline'
baseline.mkdir()
data = core.docker('exec', services['app'], 'tar', '-C', '/app', '-cf', '-', 'src', 'public', 'migrations', 'package.json', 'package-lock.json')
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    archive.extractall(baseline, filter='data')
assert {service: core.metadata(container) for service, container in services.items()} == metadata
before = core.files_at(baseline)
local = core.files_at(root)
changed = sorted(file for file in local if local[file] != before.get(file) and not file.endswith('.orig'))
info = {'services': metadata, 'dependencies': [core.metadata(container) for container in ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']],
        'files': {file: verified['files'][file] for file in files}, 'before': before,
        'nonScopeLocalChanges': [file for file in changed if file not in files], 'verificationTreeHash': verified['source_tree_sha256']}
(release / 'capture.json').write_text(json.dumps(info, indent=2))
print(json.dumps({'captured': True, 'baseImageId': metadata['app']['imageId'], 'runtimeScopeCount': len(files),
                  'nonScopeLocalChanges': info['nonScopeLocalChanges']}))

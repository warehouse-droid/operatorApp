"""Capture running application code for a narrow Stock Check release."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/stock-check-20261014'
EVIDENCE = SERVER / 'test-artifacts/stock-check'
CONTAINER = 'mbbs-operator-app-app-1'
SHARED = ['src/server.js', 'public/scm-menu.html', 'public/app-sidebar.js', 'package.json', 'package-lock.json', 'Dockerfile']

def docker(*args):
    return subprocess.run(['sudo', '-n', 'docker', *args], check=True, capture_output=True, timeout=120).stdout

def image():
    return docker('inspect', '--format', '{{.Image}}', CONTAINER).decode().strip()

def hashes(folder):
    return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in folder.rglob('*') if p.is_file()}

def main():
    manifest = RELEASE / 'capture.json'
    if manifest.exists():
        saved = json.loads(manifest.read_text())
        print(json.dumps({'already_captured': True, 'live_image_unchanged': image() == saved['image_id'], 'release': str(RELEASE)}))
        return
    RELEASE.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    before = RELEASE / 'before'
    before.mkdir()
    original_image = image()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        archive = docker('cp', f'{CONTAINER}:/app/{name}', '-')
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(before, filter='data')
    if image() != original_image:
        raise RuntimeError('The live application changed during source capture.')
    shutil.copy2(SERVER / 'Dockerfile', before / 'Dockerfile')
    shutil.copytree(before, RELEASE / 'candidate')
    comparisons = {}
    for name in SHARED:
        target = EVIDENCE / 'workspace-before' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, target)
        comparisons[name] = hashlib.sha256((SERVER / name).read_bytes()).hexdigest() == hashlib.sha256((before / name).read_bytes()).hexdigest()
    state = {'image_id': original_image, 'release': str(RELEASE), 'source_hashes': hashes(before), 'workspace_matches_live': comparisons}
    manifest.write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps({'captured': True, 'release': str(RELEASE), 'workspace_matches_live': comparisons}))

if __name__ == '__main__':
    main()

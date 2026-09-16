"""Prepare/apply a six-file image layer over the current deployment, with guards."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/split-address-20260915')
FILES = ['src/dispatch-delivery-group-repository.js', 'src/dispatch-repository.js',
         'src/delivery-repository.js', 'src/dispatch-planner-optimization.js',
         'public/dispatch.js', 'public/dispatch.html']
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'worker': 'mbbs-operator-app-webhook-worker-1'}
IMAGE = 'mbbs-operator-app:dispatch-split-address-20260915-v1'

def run(*args):
    return subprocess.check_output(args, text=True)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def metadata(container):
    return json.loads(run('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))

def hashes(container, files):
    output = run('docker', 'exec', container, 'sha256sum', *['/app/' + file for file in files])
    return {line.split()[1].removeprefix('/app/'): line.split()[0] for line in output.splitlines()}

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
stage = BACKUP / 'image'
manifest_path = BACKUP / 'manifest.json'
if not args.apply:
    stage.mkdir(parents=True, exist_ok=True)
    current = {role: metadata(container) for role, container in CONTAINERS.items()}
    assert current['app']['imageId'] == current['worker']['imageId'], 'Prepare separate layers if service base images differ.'
    before = {}
    for role, container in CONTAINERS.items():
        relevant = FILES if role == 'app' else FILES[:4]
        before[role] = {file: sha(BACKUP / 'runtime-before' / role / file) for file in relevant}
        assert hashes(container, relevant) == before[role], 'Runtime changed since backup; rebase first.'
    for file in FILES:
        target = stage / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'server' / file, target)
    (stage / 'Dockerfile').write_text('FROM ' + current['app']['image'] + '\n' +
        '\n'.join('COPY ' + file + ' /app/' + file for file in FILES) + '\n')
    after = {file: sha(stage / file) for file in FILES}
    manifest = {'before': before, 'after': after, 'services': current, 'image': IMAGE}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    (BACKUP / 'compose.override.yml').write_text('services:\n  app:\n    image: ' + IMAGE +
        '\n  webhook-worker:\n    image: ' + IMAGE + '\n')
    print(run('docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)))
    print(json.dumps({'prepared': IMAGE, 'files': after}))
else:
    manifest = json.loads(manifest_path.read_text())
    checks = json.loads((ROOT / 'server/test-artifacts/split-address/static.json').read_text())
    assert checks['hashes'] == manifest['after']
    assert {file: sha(ROOT / 'server' / file) for file in FILES} == manifest['after']
    subprocess.run(['python3', str(ROOT / 'server/tools/dispatch-split-address-evidence.py')], check=True)
    checks_log = (ROOT / 'server/test-artifacts/split-address/checks-final.log').read_text()
    assert '{"name":"lint-final","exitCode":0}' in checks_log
    browser_log = (ROOT / 'server/test-artifacts/split-address/browser-final.log').read_text()
    assert '# pass 2' in browser_log and '# fail 0' in browser_log
    for role, container in CONTAINERS.items():
        assert metadata(container) == manifest['services'][role], 'Deployment changed; rebase first.'
        assert hashes(container, list(manifest['before'][role])) == manifest['before'][role]
    command = ['docker', 'compose', '-p', 'mbbs-operator-app']
    for file in manifest['services']['app']['configFiles'].split(','):
        command += ['-f', file]
    command += ['-f', str(BACKUP / 'compose.override.yml'), 'up', '-d', '--no-build', '--no-deps', 'app', 'webhook-worker']
    subprocess.run(command, cwd=ROOT, check=True)
    health = None
    for attempt in range(40):
        try:
            with urlopen('http://127.0.0.1:3000/health', timeout=2) as response:
                assert response.status == 200
                health = json.load(response)
            break
        except Exception:
            time.sleep(0.5)
    assert health is not None, 'App health did not recover; use the saved prior compose/image metadata.'
    for container in CONTAINERS.values():
        assert hashes(container, FILES) == manifest['after']
    with urlopen('http://127.0.0.1:3000/dispatch.js?split-address=20260915-v1') as response:
        assert hashlib.sha256(response.read()).hexdigest() == manifest['after']['public/dispatch.js']
    result = {'image': IMAGE, 'health': health, 'installed': manifest['after']}
    (BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))

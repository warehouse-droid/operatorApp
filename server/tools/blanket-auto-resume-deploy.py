"""Deploy only the verified files over the current application image."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / 'server/test-artifacts/blanket-auto-resume'
BACKUP = Path('/home/ubuntu/operatorapp-deploy-backups/blanket-auto-resume-20260915')
IMAGE = 'mbbs-operator-app:blanket-auto-resume-20260915-v1'
FILES = ['src/smart-scm-planning-exclusion-repository.js', 'src/smart-scm-planning-repository.js',
         'src/smart-scm-blanket-repository.js', 'src/smart-scm-blanket-pool-repository.js',
         'src/dispatch-repository.js', 'src/order-sync-repository.js',
         'public/scm-smart-exclusions.js', 'public/scm-smart.html']
CONTAINERS = ['mbbs-operator-app-app-1', 'mbbs-operator-app-webhook-worker-1']

def run(*args):
    return subprocess.check_output(args, text=True)

def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def metadata(container):
    return json.loads(run('docker', 'inspect', '--format',
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"configFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}', container))

def hashes(container):
    output = run('docker', 'exec', container, 'sha256sum', *['/app/' + file for file in FILES])
    return {line.split()[1].removeprefix('/app/'): line.split()[0] for line in output.splitlines()}

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['prepare', 'apply'])
args = parser.parse_args()
manifest_file = BACKUP / 'manifest.json'
if args.mode == 'prepare':
    BACKUP.mkdir(parents=True, exist_ok=True)
    services = {container: metadata(container) for container in CONTAINERS}
    assert len({service['imageId'] for service in services.values()}) == 1
    baseline = {file: sha(ARTIFACT / 'baseline' / file) for file in FILES}
    for container in CONTAINERS:
        assert hashes(container) == baseline, 'Live files diverged from the tested baseline; rebase first.'
    for file in FILES:
        original = BACKUP / 'runtime-before' / file
        original.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['docker', 'cp', CONTAINERS[0] + ':/app/' + file, str(original)], check=True)
        staged = BACKUP / 'stage' / file
        staged.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'server' / file, staged)
    (BACKUP / 'stage/Dockerfile').write_text('FROM ' + services[CONTAINERS[0]]['image'] + '\n' +
        '\n'.join('COPY ' + file + ' /app/' + file for file in FILES) + '\n')
    after = {file: sha(BACKUP / 'stage' / file) for file in FILES}
    manifest_file.write_text(json.dumps({'services': services, 'before': baseline, 'after': after, 'image': IMAGE}, indent=2))
    (BACKUP / 'compose.override.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n  webhook-worker:\n    image: ' + IMAGE + '\n')
    print(run('docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(BACKUP / 'stage')))
else:
    manifest = json.loads(manifest_file.read_text())
    checks = json.loads((ARTIFACT / 'static.json').read_text())
    assert checks['hashes'] == manifest['after']
    assert {file: sha(ROOT / 'server' / file) for file in FILES} == manifest['after']
    assert all(row['killed'] for row in json.loads((ARTIFACT / 'mutations.json').read_text()))
    assert all(not row['missing'] for row in json.loads((ARTIFACT / 'changed-coverage.json').read_text()))
    assert not json.loads((ARTIFACT / 'types.json').read_text())['added']
    suite = [json.loads(line) for line in (ARTIFACT / 'suite.log').read_text().splitlines() if line.startswith('{')]
    assert len(suite) == 3 and all(row['matched'] for row in suite)
    for container in CONTAINERS:
        assert metadata(container) == manifest['services'][container], 'Deployment changed; rebase first.'
        assert hashes(container) == manifest['before'], 'Runtime files changed; rebase first.'
    # The existing deployment chain includes a root-owned, private override.
    command = ['sudo', '-n', 'docker', 'compose', '-p', 'mbbs-operator-app']
    for file in manifest['services'][CONTAINERS[0]]['configFiles'].split(','):
        command += ['-f', file]
    command += ['-f', str(BACKUP / 'compose.override.yml'), 'up', '-d', '--no-build', '--no-deps', 'app', 'webhook-worker']
    subprocess.run(command, cwd=ROOT, check=True)
    health = None
    for _ in range(60):
        try:
            with urlopen('http://127.0.0.1:3000/health', timeout=2) as response:
                assert response.status == 200
                health = json.load(response)
            break
        except Exception:
            time.sleep(0.5)
    assert health is not None, 'Health failed; restore the saved prior image.'
    for container in CONTAINERS:
        assert hashes(container) == manifest['after']
    with urlopen('http://127.0.0.1:3000/scm-smart-exclusions.js?v=20260915-blanket-auto-resume-v1') as response:
        assert hashlib.sha256(response.read()).hexdigest() == manifest['after']['public/scm-smart-exclusions.js']
    result = {'image': IMAGE, 'health': health, 'files': manifest['after']}
    (BACKUP / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))

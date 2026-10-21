"""Check the actual app and worker candidate images against disposable data."""
import json
from pathlib import Path
import signal
import subprocess

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-shared-orders-20261009'
RELEASE = SERVER / 'deployments/special-shared-orders-20261009'
PROJECT = 'mbbs-special-shared-images-20261009'
DOCKER = ['sudo', '-n', 'docker']
manifest = json.loads((RELEASE / 'manifest.json').read_text())
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
override = {'services': {
    'db': {'labels': labels},
    'migrate': {'image': 'sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9', 'pull_policy': 'never', 'labels': labels,
                'volumes': [f'{SERVER / "migrations"}:/app/migrations:ro']},
    'test': {'image': manifest['app']['candidateImage'], 'pull_policy': 'never', 'labels': labels,
             'volumes': [f'{SERVER / "tools/special-shared-orders-20261009/image-check.mjs"}:/tmp/shared-image-check.mjs:ro']}}}
config = OUT / 'compose.images.json'
config.write_text(json.dumps(override, indent=2))
compose = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(name, args):
    with (OUT / (name + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({'stage': name, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (name + '.log')).read_text()[-4000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Remove candidate-image tests and disposable database')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    assert run('images-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('images-migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    for service in ['app', 'webhook-worker']:
        override['services']['test']['image'] = manifest[service]['candidateImage']
        config.write_text(json.dumps(override, indent=2))
        assert run('image-' + service, compose + ['run', '--rm', '--no-deps', '-T', '-e',
                                                 'SHARED_IMAGE_HASHES=' + json.dumps(manifest[service]['hashes']),
                                                 'test', 'node', '/tmp/shared-image-check.mjs']) == 0
    (OUT / 'image-tests.json').write_text(json.dumps({'app': 'pass', 'webhook-worker': 'pass', 'actualCandidateImages': True}))
finally:
    teardown = run('images-teardown', compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(DOCKER + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}']).decode().split()
    if residual:
        records = json.loads(subprocess.check_output(DOCKER + ['inspect', *residual]))
        assert all(row['Config']['Labels'].get('com.mbbs.lifecycle') == 'disposable-test' for row in records)
        assert run('images-residual', DOCKER + ['rm', '-f', '-v', *residual]) == 0
        teardown = run('images-teardown-retry', compose + ['down', '--volumes', '--remove-orphans'])
    active = subprocess.check_output(DOCKER + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_containers = subprocess.check_output(DOCKER + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    tests = subprocess.check_output(DOCKER + ['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}']).decode().strip()
    task_tests = subprocess.check_output(DOCKER + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']).decode().strip()
    networks = subprocess.check_output(DOCKER + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(DOCKER + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = json.loads(subprocess.check_output(DOCKER + ['exec', 'mbbs-operator-app-app-1', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"]))
    (OUT / 'cleanup-images.json').write_text(json.dumps({'teardownExit': teardown, 'dockerPs': active, 'dockerPsA': all_containers,
        'testContainers': task_tests, 'otherActiveTestContainers': tests, 'networks': networks, 'volumes': volumes, 'productionHealthy': health.get('ok') is True}, indent=2))
    assert teardown == 0 and not task_tests and not networks and not volumes and health.get('ok') is True

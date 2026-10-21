"""Run checks using the repository's bounded, disposable Compose configuration."""
import json
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-stock-check-editing-20261009'
PROJECT = 'mbbs-special-stock-check-editing-20261009'
IMAGE = 'sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9'
MODE = sys.argv[1]
assert MODE in ['red', 'baseline', 'green', 'final']
OUT.mkdir(parents=True, exist_ok=True)
if MODE == 'final':
    for name in ['summary.json', 'static.json', 'changed-coverage.json']:
        (OUT / name).unlink(missing_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
environment = {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify',  # secret-scan: allow -- isolated disposable test credentials
               'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
               'XDG_CONFIG_HOME': '/tmp/stock-check-chromium-config', 'XDG_CACHE_HOME': '/tmp/stock-check-chromium-cache',
               'SPECIAL_BATCH_BROWSER_OUTPUT': '/app/test-artifacts/special-stock-check-editing-20261009/regression-browser'}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'test', 'tools', 'migrations']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js', 'eslint.mbt.config.js']]
override = {'services': {
    'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['mbbs-special-review-db']}}},
    'test': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'environment': environment, 'volumes': mounts},
    'migrate': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'environment': environment, 'volumes': mounts}}}
config = OUT / 'compose.test.json'
config.write_text(json.dumps(override, indent=2))
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-3500:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted: remove disposable containers and storage')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
# This finally is registered before the first test environment is created.
try:
    assert run('resource-policy-' + MODE, ['python3', 'docker/verify-memory-limits.py']) == 0
    assert run('start-db-' + MODE, compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('create-db-' + MODE, compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'CREATE DATABASE mbt_verify']) == 0
    assert run('migrate-' + MODE, compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    raise SystemExit(run(MODE + '-runner', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'tools/special-stock-check-editing-20261009/check.mjs', MODE]))
finally:
    teardown = run('teardown-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}']).decode().split()
    if residual:
        records = json.loads(subprocess.check_output(docker + ['inspect', *residual]))
        assert all(row['Config']['Labels'].get('com.mbbs.lifecycle') == 'disposable-test' for row in records)
        assert run('residual-' + MODE, docker + ['rm', '-f', '-v', *residual]) == 0
        teardown = run('teardown-retry-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    active = subprocess.check_output(docker + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_containers = subprocess.check_output(docker + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    tests = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}']).decode().strip()
    networks = subprocess.check_output(docker + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(docker + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = json.loads(subprocess.check_output(docker + ['exec', 'mbbs-operator-app-app-1', 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"]))
    (OUT / ('cleanup-' + MODE + '.json')).write_text(json.dumps({'teardownExit': teardown,
        'testContainers': tests, 'networks': networks, 'volumes': volumes, 'dockerPs': active,
        'dockerPsA': all_containers, 'productionHealthy': health.get('ok') is True}, indent=2))
    assert teardown == 0 and not tests and not networks and not volumes and health.get('ok') is True
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

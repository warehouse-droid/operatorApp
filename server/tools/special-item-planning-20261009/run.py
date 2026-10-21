"""Run the Special Item Save checks in a bounded, disposable Compose project."""
import json
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-item-planning-20261009'
MODE = sys.argv[1]
assert MODE in ['red', 'baseline', 'green', 'final']
PROJECT = 'mbbs-special-item-planning-20261009-' + MODE
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
environment = {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify',
               'XDG_CONFIG_HOME': '/tmp/special-planning-config', 'XDG_CACHE_HOME': '/tmp/special-planning-cache'}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'test', 'tools', 'migrations']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'eslint.mbt.config.js',
           'netsuite-smart-scm-picking-ticket-restlet.js']]
override = {'services': {
    'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['mbbs-special-review-db']}}},
    'test': {'image': 'sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9',
             'pull_policy': 'never', 'labels': labels, 'environment': environment, 'volumes': mounts},
    'migrate': {'image': 'sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9',
                'pull_policy': 'never', 'labels': labels, 'environment': environment, 'volumes': mounts}}}
config = OUT / ('compose.' + MODE + '.json')
config.write_text(json.dumps(override, indent=2) + '\n')
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-4500:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted: remove disposable test resources')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
# Register teardown before creating any disposable environment.
try:
    assert run('resource-policy-' + MODE, ['python3', 'docker/verify-memory-limits.py']) == 0
    assert run('start-db-' + MODE, compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('create-db-' + MODE, compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'CREATE DATABASE mbt_verify']) == 0
    assert run('migrate-' + MODE, compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    result = run(MODE + '-runner', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'tools/special-item-planning-20261009/check.mjs', MODE])
    if MODE == 'final' and result == 0:
        result = run('changed-coverage', ['python3', 'server/tools/special-item-planning-20261009/coverage.py'])
    raise SystemExit(result)
finally:
    teardown = run('teardown-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    remaining = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}']).decode().split()
    if remaining:
        records = json.loads(subprocess.check_output(docker + ['inspect', *remaining]))
        assert all(row['Config']['Labels'].get('com.mbbs.lifecycle') == 'disposable-test' for row in records)
        assert run('residual-' + MODE, docker + ['rm', '-f', '-v', *remaining]) == 0
        teardown = run('teardown-retry-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    active = subprocess.check_output(docker + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_containers = subprocess.check_output(docker + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    tests = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}']).decode().strip()
    networks = subprocess.check_output(docker + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(docker + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = json.loads(subprocess.check_output(docker + ['exec', 'mbbs-operator-app-app-1', 'node', '-e',
        "(async()=>{for(let attempt=0;attempt<20;attempt++){try{const response=await fetch('http://127.0.0.1:3000/health');const health=await response.json();if(response.ok&&health.ok===true){console.log(JSON.stringify(health));return;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}throw Error('Production health did not recover');})()"] ))
    (OUT / ('cleanup-' + MODE + '.json')).write_text(json.dumps({'teardownExit': teardown,
        'testContainers': tests, 'networks': networks, 'volumes': volumes, 'dockerPs': active,
        'dockerPsA': all_containers, 'productionHealthy': health.get('ok') is True}, indent=2) + '\n')
    assert teardown == 0 and not networks and not volumes and health.get('ok') is True
    if MODE == 'final':
        assert not tests, 'Disposable tests still active: ' + tests
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

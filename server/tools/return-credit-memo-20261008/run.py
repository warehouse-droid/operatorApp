"""Disposable, bounded runner for the direct return Credit Memo change."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import urllib.request

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
ARTIFACT_ROOT = Path(os.environ.get('RETURN_CM_ARTIFACT_ROOT', str(SERVER / 'test-artifacts')))
OUT = ARTIFACT_ROOT / 'return-credit-memo-20261008'
MODE = sys.argv[1]
PROJECT = 'mbbs-return-credit-memo-' + MODE
IMAGE = os.environ.get('RETURN_CM_TEST_IMAGE', 'mbbs-delivery-requests:final')
OUT.mkdir(parents=True, exist_ok=True)
source = OUT / 'baseline' if MODE == 'baseline' else Path(os.environ.get('RETURN_CM_RUNTIME_ROOT', str(SERVER)))
mounts = [f'{source / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
mounts += [f'{(source if MODE == "baseline" else SERVER) / "test"}:/app/test:ro']
mounts += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['tools', 'contracts']]
mounts += [f'{SERVER / file.name}:/app/{file.name}:ro' for file in SERVER.iterdir()
           if file.is_file() and (file.suffix in ['.json', '.js'] or file.name.startswith('Dockerfile'))]
mounts += [f'{source / name}:/app/{name}:ro' for name in ['package.json', 'package-lock.json'] if (source / name).exists()]
mounts += [f'{ARTIFACT_ROOT}:/app/test-artifacts']
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
override = {'services': {
    'db': {'labels': labels},
    'test': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'volumes': mounts,
             'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'}},
    'migrate': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'volumes': mounts}}}
override_path = OUT / ('compose-' + MODE + '.json')
override_path.write_text(json.dumps(override, indent=2))
compose = ['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(REPO),
           '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override_path)]

def run(label, args):
    with (OUT / (MODE + '-' + label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'mode': MODE, 'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (MODE + '-' + label + '.log')).read_text()[-4000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; removing disposable test environment')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    assert run('db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    command = sys.argv[2:] or ['npm', 'test']
    raise SystemExit(run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test', *command]))
finally:
    teardown = run('teardown', compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(['docker', 'ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT,
                                       '--format', '{{.ID}}']).decode().split()
    if residual:
        subprocess.run(['docker', 'rm', '-f', '-v', *residual], check=True)
        teardown = run('teardown-retry', compose + ['down', '--volumes', '--remove-orphans'])
    status = {}
    for key, args in {
        'dockerPs': ['ps'], 'dockerPsA': ['ps', '-a'],
        'containers': ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT],
        'networks': ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT],
        'volumes': ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT]
    }.items():
        status[key] = subprocess.check_output(['docker', *args, '--format', '{{json .}}']).decode()
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=15) as response:
        status['productionHealthy'] = json.load(response).get('ok') is True
    (OUT / (MODE + '-cleanup.json')).write_text(json.dumps(status, indent=2))
    assert teardown == 0 and not any(status[key] for key in ['containers', 'networks', 'volumes'])
    assert status['productionHealthy']
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

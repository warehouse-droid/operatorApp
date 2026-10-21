"""Run browser checks in the standard bounded disposable Compose service."""
from pathlib import Path
import json
import signal
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/stock-request-scroll-20261009'
PROJECT = 'mbbs-stock-request-scroll-20261009'
IMAGE = 'sha256:e0051d1aa1c279a31eaf8c958301fd9ee80e5be77564883b1c3c346983272fd9'
MODE = sys.argv[1]
assert MODE in ['probe', 'diagnose', 'gestures', 'font', 'engines', 'red', 'green', 'final', 'live']
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
public = SERVER / 'public'
if MODE == 'final':
    for name in ['summary.json', 'static.json']:
        (OUT / name).unlink(missing_ok=True)
    public = OUT / 'candidate-public'
    shutil.copytree(OUT / 'live-public', public, dirs_exist_ok=True)
    for file in json.loads((SERVER / 'tools/stock-request-scroll-20261009/files.json').read_text()):
        shutil.copy2(SERVER / file, public / Path(file).name)
aliases = {'regression-long': '/app/test-artifacts/special-request-editing-20261006/scroll',
           'regression-audit': '/app/test-artifacts/special-po-000041/scroll',
           'regression-view': '/app/test-artifacts/stock-request-view-20261006',
           'regression-view-coverage': '/app/test-artifacts/stocking-replies-20261006'}
for name in aliases:
    (OUT / name).mkdir(exist_ok=True)
config = OUT / 'compose.test.json'
config.write_text(json.dumps({'services': {'test': {'image': IMAGE, 'pull_policy': 'never',
    'labels': labels, 'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
        'XDG_CONFIG_HOME': '/tmp/request-scroll-config', 'XDG_CACHE_HOME': '/tmp/request-scroll-cache',
        'SCROLL_TEST_MODE': MODE},
    'volumes': [f'{public}:/app/public:ro'] + [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['tools', 'test']]
      + [f'{OUT / name}:{target}' for name, target in aliases.items()]}}}, indent=2))
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                   '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-6000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted: remove disposable test containers and storage')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
# Registered before creating even the test network.
try:
    assert run('resource-policy-' + MODE, ['python3', 'docker/verify-memory-limits.py']) == 0
    script = ['node', 'tools/stock-request-scroll-20261009/' + MODE + '.mjs'] if MODE in ['probe', 'diagnose', 'gestures', 'font', 'engines'] else ['node', 'tools/stock-request-scroll-20261009/check.mjs'] if MODE == 'final' else ['node', '--test', '--test-concurrency=1', 'test/mbt/integration/stock-request-scroll-20261009-browser.test.js']
    raise SystemExit(run(MODE, compose + ['run', '--rm', '--no-deps', '-T', 'test', *script]))
finally:
    teardown = run('teardown-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    ids = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}']).decode().split()
    if ids:
        rows = json.loads(subprocess.check_output(docker + ['inspect', *ids]))
        assert all(row['Config']['Labels'].get('com.mbbs.lifecycle') == 'disposable-test' for row in rows)
        subprocess.run(docker + ['rm', '-f', '-v', *ids], check=True)
        teardown = run('teardown-retry-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    active = subprocess.check_output(docker + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_rows = subprocess.check_output(docker + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    tests = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']).decode().strip()
    other_tests = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}} {{.Label "com.mbbs.task"}}']).decode().strip()
    networks = subprocess.check_output(docker + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(docker + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = json.loads(subprocess.check_output(docker + ['exec', 'mbbs-operator-app-app-1', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"]))
    result = {'teardownExit': teardown, 'dockerPs': active, 'dockerPsA': all_rows, 'testContainers': tests, 'observedDisposableTests': other_tests,
              'networks': networks, 'volumes': volumes, 'productionHealthy': health.get('ok') is True}
    (OUT / ('cleanup-' + MODE + '.json')).write_text(json.dumps(result, indent=2) + '\n')
    assert teardown == 0 and not tests and not networks and not volumes and health.get('ok') is True
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

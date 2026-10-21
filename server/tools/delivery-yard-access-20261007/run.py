"""Reproduce and validate Delivery fixes in bounded disposable Compose containers."""
import json
import signal
import subprocess
import sys
import urllib.request
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/delivery-yard-access-20261007'
OUT.mkdir(parents=True, exist_ok=True)
mode = sys.argv[1]
PROJECT = 'mbbs-delivery-yard-access-20261007-' + mode
assert mode in ['red', 'all-sales-red', 'component-baseline', 'gauntlet', 'focused', 'baseline', 'final', 'finish', 'coverage', 'selection-red', 'static', 'mutations']
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'test', 'tools', 'migrations']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json']]
if mode in ['baseline', 'component-baseline']:
    baseline = SERVER / 'tools/delivery-yard-access-20261007/baseline'
    mounts += [f'{file}:/app/{file.relative_to(baseline)}:ro' for file in baseline.rglob('*') if file.is_file()]
override = {'services': {
    'db': {'labels': labels},
    'test': {'image': 'mbbs-delivery-requests:final', 'pull_policy': 'never', 'labels': labels, 'volumes': mounts,
             'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright','XDG_CONFIG_HOME': '/tmp/mbbs-delivery-chromium-config','XDG_CACHE_HOME': '/tmp/mbbs-delivery-chromium-cache'}},
    'migrate': {'image': 'mbbs-delivery-requests:final', 'pull_policy': 'never', 'labels': labels, 'volumes': mounts}}}
override_file = OUT / ('compose.' + mode + '.test.json')
override_file.write_text(json.dumps(override, indent=2))
compose = ['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(REPO),
           '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override_file)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-3000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Removing disposable Delivery test environment')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
watchdog = None
# Register cleanup before starting any disposable workload.
try:
    assert run('resource-policy', ['python3', 'docker/verify-memory-limits.py']) == 0
    assert run('start-db-' + mode, compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('migrate-' + mode, compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    if mode in ['red', 'all-sales-red']:
        args = ['node', '--test', '--test-concurrency=1', 'test/mbt/unit/regular-stock-target-yard-access.test.js',
                'test/mbt/integration/regular-stock-target-yard-access.test.js', 'test/mbt/unit/regular-stock-150-sales.test.js']
    else:
        args = ['node', 'tools/delivery-yard-access-20261007/check.mjs', mode]
    if mode in ['baseline', 'final', 'component-baseline', 'gauntlet']:
        watchdog = subprocess.Popen(['python3', str(SERVER / 'tools/delivery-yard-access-20261007/watchdog.py'), PROJECT],
                                    stdout=(OUT / ('watchdog-' + mode + '.log')).open('w'), stderr=subprocess.STDOUT)
    raise SystemExit(run(mode + '-runner', compose + ['run', '--rm', '--no-deps', '-T', 'test', *args]))
finally:
    if watchdog:
        watchdog.terminate()
        watchdog.wait(timeout=15)
    teardown = run('teardown-' + mode, compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(['docker', 'ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.ID}}']).decode().split()
    if residual:
        records = json.loads(subprocess.check_output(['docker', 'inspect', *residual]))
        assert all(row['Config']['Labels'].get('com.mbbs.lifecycle') == 'disposable-test' for row in records)
        run('remove-residual-' + mode, ['docker', 'rm', '-f', '-v', *residual])
        teardown = run('teardown-after-residual-' + mode, compose + ['down', '--volumes', '--remove-orphans'])
    snapshots = {key: subprocess.check_output(args).decode().strip() for key, args in {
        'dockerPs': ['docker', 'ps', '--format', '{{.Names}}\t{{.Status}}'],
        'dockerPsA': ['docker', 'ps', '-a', '--format', '{{.Names}}\t{{.Status}}'],
        'taskContainers': ['docker', 'ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}'],
        'taskNetworks': ['docker', 'network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'],
        'taskVolumes': ['docker', 'volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']}.items()}
    (OUT / ('cleanup-' + mode + '.json')).write_text(json.dumps({'teardownExit': teardown, **snapshots}, indent=2))
    assert teardown == 0 and not any(snapshots[key] for key in ['taskContainers', 'taskNetworks', 'taskVolumes'])
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=15) as response:
        assert json.load(response)['ok'] is True
    print(json.dumps({'cleanup': 'complete', 'productionHealth': 'healthy'}), flush=True)

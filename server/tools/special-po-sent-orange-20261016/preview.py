"""Verify the exact candidate in the bounded disposable Compose project."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / 'server'
RELEASE = SERVER / 'deployments/special-po-sent-orange-20261016'
TREE = RELEASE / 'candidate'
OUT = SERVER / 'test-artifacts/special-po-sent-orange-20261016'
PROJECT = 'mbbs-special-po-sent-orange'
OUT.mkdir(parents=True, exist_ok=False)
os.chmod(OUT, 0o777)
FILES = ['public/special-stock-documents.css']
hashes = {name: hashlib.sha256((TREE / name).read_bytes()).hexdigest() for name in FILES}
(OUT / 'source.json').write_text(json.dumps(hashes, indent=2))
mounts = [f'{TREE / name}:/app/{name}:ro' for name in ('src', 'public', 'migrations', 'package.json')]
mounts += [f'{SERVER / name}:/app/{name}:ro' for name in ('test', 'tools', 'contracts', 'eslint.mbt.config.js')]
mounts += [f'{SERVER / "test-artifacts/delivery-enhancements-20261013/toolchain/node_modules"}:/app/node_modules:ro',
    f'{OUT}:/app/test-artifacts', f'{RELEASE}:/release:ro']
service = {'image': 'mbbs-operator-app:dispatch-editor-control-browser-test-20261015', 'pull_policy': 'never',
    'user': '1000:1000', 'working_dir': '/app', 'volumes': mounts,
    'labels': {'com.mbbs.lifecycle': 'disposable-test'},
    'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'XDG_CONFIG_HOME': '/tmp/config',
        'XDG_CACHE_HOME': '/tmp/cache', 'SPECIAL_VENDOR_BROWSER_OUTPUT': 'test-artifacts/browser'}}
override = OUT / 'compose.json'
override.write_text(json.dumps({'services': {'test': service, 'migrate': service,
    'db': {'labels': {'com.mbbs.lifecycle': 'disposable-test'}}}}))
compose = ['docker', 'compose', '--project-directory', str(ROOT), '-p', PROJECT,
    '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]


def run(name, args):
    with (OUT / (name + '.log')).open('wb') as log:
        result = subprocess.run(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=420)
    print(json.dumps({'layer': name, 'exitCode': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (name + '.log')).read_text()[-8000:], flush=True)
        raise RuntimeError(name + ' failed')


def stop(_signal, _frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    # Teardown is registered before the first test workload or resource starts.
    run('budget', ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--slice=mbbs-tests.slice',
        '-p', 'MemoryMax=128M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=25%', '-p', 'TasksMax=32',
        'python3', str(ROOT / 'docker/verify-memory-limits.py')])
    run('preview', compose + ['run', '--rm', '--no-deps', 'test', 'node', 'tools/special-po-sent-orange-20261016/preview.mjs'])
finally:
    with (OUT / 'teardown.log').open('wb') as log:
        subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], stdout=log, stderr=subprocess.STDOUT, check=True)
    for args, name in [(['ps'], 'docker-ps.log'), (['ps', '-a'], 'docker-ps-a.log')]:
        (OUT / name).write_bytes(subprocess.check_output(['docker', *args, '--format', '{{.Names}} {{.Status}}']))
    (OUT / 'production-health.json').write_bytes(subprocess.check_output(['docker', 'inspect',
        'mbbs-operator-app-app-1', '--format', '{{json .State.Health.Status}}']))
    leftovers = {}
    for resource, args in [('containers', ['ps', '-aq']), ('volumes', ['volume', 'ls', '-q']), ('networks', ['network', 'ls', '-q'])]:
        leftovers[resource] = subprocess.check_output(['docker', *args, '--filter', 'label=com.docker.compose.project=' + PROJECT]).decode().strip()
    leftovers['disposableContainers'] = subprocess.check_output(['docker', 'ps', '-aq', '--filter',
        'label=com.mbbs.lifecycle=disposable-test']).decode().strip()
    (OUT / 'cleanup.json').write_text(json.dumps(leftovers, indent=2))
    assert not any(leftovers.values()), 'Disposable resources remain'
    assert json.loads((OUT / 'production-health.json').read_text()) == 'healthy'
    assert hashes == {name: hashlib.sha256((TREE / name).read_bytes()).hexdigest() for name in FILES}, 'Candidate changed'
    print('Teardown complete; container listings and production health saved.', flush=True)

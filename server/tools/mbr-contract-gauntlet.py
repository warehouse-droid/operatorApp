#!/usr/bin/env python3
"""Reproduce MBR checks using the standard bounded, disposable Compose stack."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbr-contract'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
PROJECT = f'mbbs-mbr-contract-{MODE}-{os.getpid()}'
assert MODE in ('red', 'unit', 'integration', 'browser', 'all', 'mutation', 'baseline', 'static', 'regression', 'regression-baseline', 'inspect', 'coverage')
OUT.mkdir(parents=True, exist_ok=True)
docker = ['sudo', '-n', 'docker']
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SERVER / name}:/app/{name}:ro' for name in
          ('src', 'public', 'test', 'tools', 'migrations')]
mounts += [f'{SERVER / name}:/app/{name}:ro' for name in
           ('package.json', 'package-lock.json', 'tsconfig.mbt.json', 'eslint.mbt.config.js')]
mounts.append(f'{SERVER / "contracts"}:/app/contracts:ro')
mounts += [f'{filename}:/app/{filename.name}:ro' for filename in SERVER.glob('*.js')
           if filename.name != 'eslint.mbt.config.js']
if MODE == 'regression-baseline':
    preserved = OUT / 'baseline'
    for original in json.loads((preserved / 'manifest.json').read_text()):
        source = preserved / original
        destination = '/app/' + str(Path(original).relative_to('server'))
        mounts = [mount for mount in mounts if mount.split(':')[1] != destination]
        mounts.append(f'{source}:{destination}:ro')
toolchain = Path(os.environ.get('MBR_TEST_NODE_MODULES', str(OUT / 'toolchain/node_modules')))
if toolchain.exists():
    mounts.append(f'{toolchain}:/app/node_modules:ro')
browsers = OUT / 'playwright-browsers'
if browsers.exists():
    mounts.append(f'{browsers}:/ms-playwright:ro')
override = OUT / f'compose.{MODE}.json'
override.write_text(json.dumps({'services': {
    'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels,
           'mem_limit': '512m', 'memswap_limit': '512m'},
    'test': {'image': os.environ.get('MBR_TEST_IMAGE', 'mbbs-to-yard-test-browser:20261009'),
             'working_dir': '/app',
             'pull_policy': 'never', 'labels': labels, 'mem_limit': '1536m', 'memswap_limit': '1536m',
             'volumes': mounts, 'environment': {
                 'MBR_CONTRACTS_ENABLED': 'true', 'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
                 'XDG_CONFIG_HOME': '/tmp/mbr-chromium-config', 'XDG_CACHE_HOME': '/tmp/mbr-chromium-cache'}}
}}, indent=2))
compose = docker + ['compose', '--profile', 'tools', '--project-name', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def run(label, args, timeout=900):
    logpath = OUT / f'{MODE}-{label}.log'
    with logpath.open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print(logpath.read_text()[-5000:], flush=True)
    return result.returncode

def check(label, args, timeout=900):
    if run(label, args, timeout):
        raise SystemExit(1)

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; removing MBR disposable test environment')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
def bytes_size(value):
    text = str(value).lower()
    return int(text[:-1]) * {'k':1024, 'm':1024**2, 'g':1024**3}[text[-1]] if text[-1] in 'kmg' else int(text)

code = None
# Finally is in place before creating any containers or networks.
try:
    inspect = subprocess.check_output(compose + ['config', '--format', 'json'], text=True)
    config = json.loads(inspect)
    for name in ('db', 'test'):
        svc = config['services'][name]
        assert svc['cgroup_parent'] == 'mbbs-tests.slice' and svc['init']
        assert 0 < bytes_size(svc['mem_limit']) <= 2 * 1024**3 and svc['memswap_limit'] == svc['mem_limit']
        assert 0 < svc['pids_limit'] <= 512 and svc.get('cpus')
        assert all('size=' in item for item in svc.get('tmpfs', []))
    print(json.dumps({'resourcePolicy': 'bounded standard Compose, mbbs-tests.slice'}), flush=True)
    if MODE not in ('red', 'unit', 'static', 'inspect'):
        check('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
        check('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate'])
    args = ['node', 'tools/mbr-contract-check.mjs', MODE]
    code = run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test'] + args)
    raise SystemExit(code)
finally:
    teardown = run('teardown', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    residual = subprocess.check_output(docker + ['ps', '-a', '--filter', f'label=com.mbbs.task={PROJECT}',
                                                '--format', '{{.ID}}'], text=True).split()
    if residual:
        records = json.loads(subprocess.check_output(docker + ['inspect'] + residual))
        assert all(r['Config']['Labels'].get('com.mbbs.task') == PROJECT for r in records)
        check('remove-oneoffs', docker + ['rm', '-f', '-v'] + residual, timeout=120)
        teardown = run('teardown-final', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(args):
        return subprocess.check_output(docker + args, text=True).strip()
    status = {
        'teardownExit': teardown,
        'dockerPs': output(['ps', '--format', '{{.Names}}\t{{.Status}}']),
        'dockerPsA': output(['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']),
        'taskContainers': output(['ps', '-a', '--filter', f'label=com.mbbs.task={PROJECT}', '--format', '{{.Names}}']),
        'taskNetworks': output(['network', 'ls', '--filter', f'label=com.docker.compose.project={PROJECT}', '--format', '{{.Name}}']),
        'taskVolumes': output(['volume', 'ls', '--filter', f'label=com.docker.compose.project={PROJECT}', '--format', '{{.Name}}'])}
    with (OUT / f'{MODE}-cleanup.json').open('w') as f:
        json.dump(status, f, indent=2)
    assert teardown == 0 and not any(status[key] for key in ('taskContainers', 'taskNetworks', 'taskVolumes'))
    # Check live app health without changing production state or reading credentials.
    health = subprocess.run(['curl', '-fsS', '--max-time', '15', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
    (OUT / f'{MODE}-production-health.json').write_text(health.stdout or health.stderr)
    assert health.returncode == 0, 'Production health check failed after teardown'
    print(json.dumps({'cleanup': 'complete', 'productionHealth': 'passed'}), flush=True)
    if MODE == 'all' and code == 0:
        check('evidence', ['python3', str(SERVER / 'tools/mbr-contract-evidence.py')])

#!/usr/bin/env python3
"""Run MBR equipment checks in the standard bounded disposable test environment."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/mbr-nullable'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'all'
assert MODE in ('red', 'core', 'all', 'candidate')
PROJECT = 'mbbs-mbr-nullable-' + MODE + '-' + str(os.getpid())
OUT.mkdir(parents=True, exist_ok=True)
docker = ['sudo', '-n', 'docker']
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SERVER / name}:/app/{name}:ro' for name in ('test', 'tools', 'contracts')]
mounts += [f'{SERVER / name}:/app/{name}:ro' for name in ('eslint.mbt.config.js', 'tsconfig.mbt.json', '.env.example')]
toolchain = SERVER / 'test-artifacts/mbr-contract/toolchain/node_modules'
mounts += [f'{toolchain}:/test-toolchain/node_modules:ro',
           f'{SERVER / "test-artifacts/mbr-contract/playwright-browsers"}:/ms-playwright:ro']
if MODE != 'candidate':
    mounts += [f'{SERVER / name}:/app/{name}:ro' for name in ('src', 'public', 'migrations', 'package.json', 'package-lock.json')]
    mounts.append(f'{toolchain}:/app/node_modules:ro')
for path in SERVER.glob('*.js'):
    if path.name != 'eslint.mbt.config.js':
        mounts.append(f'{path}:/app/{path.name}:ro')
image = os.environ.get('MBR_NULLABLE_TEST_IMAGE', 'mbbs-to-yard-test-browser:20261009')
if MODE == 'candidate':
    image = json.loads((OUT / 'prepared.json').read_text())['testImage']
override = OUT / ('compose.' + MODE + '.json')
override.write_text(json.dumps({'services': {
    'db': {'image': 'postgres:18-alpine', 'pull_policy': 'never', 'labels': labels,
           'mem_limit': '512m', 'memswap_limit': '512m'},
    'test': {'image': image, 'pull_policy': 'never', 'user': '1000:1000', 'entrypoint': [],
             'working_dir': '/app', 'labels': labels, 'cpus': '1.0',
             'mem_limit': '1536m', 'memswap_limit': '1536m', 'volumes': mounts,
             'environment': {'MBR_CONTRACTS_ENABLED': 'true', 'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
                             'XDG_CONFIG_HOME': '/tmp/mbr-config', 'XDG_CACHE_HOME': '/tmp/mbr-cache'}}}}, indent=2))
compose = docker + ['compose', '--profile', 'tools', '-p', PROJECT, '--project-directory', str(REPO),
                    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def run(label, args, timeout=900):
    log = OUT / (MODE + '-' + label + '.log')
    with log.open('w') as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, cwd=REPO, timeout=timeout)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print(log.read_text()[-7000:], flush=True)
    return result.returncode

def check(label, args, timeout=900):
    if run(label, args, timeout):
        raise SystemExit(1)

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; removing disposable MBR equipment tests')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
passed = False
try:
    config = json.loads(subprocess.check_output(compose + ['config', '--format', 'json']))
    for name in ('db', 'test'):
        service = config['services'][name]
        assert service['cgroup_parent'] == 'mbbs-tests.slice' and service['init']
        assert 0 < int(service['mem_limit']) <= 2 * 1024**3 and service['memswap_limit'] == service['mem_limit']
        assert 0 < service['pids_limit'] <= 512 and service['cpus']
        assert service['labels']['com.mbbs.lifecycle'] == 'disposable-test'
        assert all('size=' in entry for entry in service['tmpfs'])
    check('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db'])
    check('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate'])
    code = run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'tools/mbr-nullable-check.mjs', MODE])
    passed = code == 0
finally:
    teardown = run('teardown', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    residual = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT,
                                                '--format', '{{.ID}}'], text=True).split()
    if residual:
        check('remove-oneoffs', docker + ['rm', '-f', '-v', *residual], timeout=120)
        teardown = run('teardown-final', compose + ['down', '--volumes', '--remove-orphans'], timeout=120)
    def output(args):
        return subprocess.check_output(docker + args, text=True).strip()
    status = {'teardownExit': teardown,
              'dockerPs': output(['ps', '--format', '{{.Names}} {{.Status}}']),
              'dockerPsA': output(['ps', '-a', '--format', '{{.Names}} {{.Status}}']),
              'containers': output(['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']),
              'networks': output(['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']),
              'volumes': output(['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'])}
    (OUT / ('cleanup.' + MODE + '.json')).write_text(json.dumps(status, indent=2))
    assert teardown == 0 and not any(status[key] for key in ('containers', 'networks', 'volumes'))
    health = subprocess.run(['curl', '-fsS', '--max-time', '15', 'http://127.0.0.1:3000/health'], capture_output=True, text=True)
    (OUT / ('production-health.' + MODE + '.json')).write_text(health.stdout or health.stderr)
    assert health.returncode == 0, 'Production health failed after test cleanup'
    if passed:
        roots = ['src/mbr', 'public/mbr', 'test/mbr']
        files = sorted({path for root in roots for path in (SERVER / root).rglob('*') if path.is_file()}
                       | set(SERVER.glob('tools/mbr-nullable-*'))
                       )
        hashes = {str(path.relative_to(SERVER)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
        (OUT / ('validation.' + MODE + '.json')).write_text(json.dumps({'passed': True, 'cleanupVerified': True,
            'image': image, 'sourceHashes': hashes}, indent=2))
    print(json.dumps({'cleanup': 'complete', 'productionHealth': 'passed', 'checksPassed': passed}), flush=True)
sys.exit(0 if passed else 1)

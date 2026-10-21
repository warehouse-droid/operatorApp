"""Run bounded, disposable planning regression checks against the captured live code."""
import json
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
TASK = Path(__file__).resolve().parent
OUT = SERVER / 'test-artifacts/unfinished-split-20261012'
MODE = sys.argv[1]
assert MODE in ['red', 'green', 'baseline', 'final']
PROJECT = 'mbbs-unfinished-split-20261012-' + MODE
OUT.mkdir(parents=True, exist_ok=True)
SOURCE = TASK / ('baseline' if MODE in ['red', 'baseline'] else 'candidate')
assert (SOURCE / 'src/server.js').is_file()
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SOURCE / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
mounts += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['test', 'tools', 'contracts']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'eslint.mbt.config.js',
    '.c8rc.json', 'tsconfig.mbt.json', 'netsuite-smart-scm-picking-ticket-restlet.js']]
mounts += [f'{SERVER / "test-artifacts/operator-to-yard-flow-tooling/node_modules"}:/app/node_modules:ro',
    f'{SERVER / "test-artifacts"}:/app/test-artifacts']
environment = {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
    'XDG_CONFIG_HOME': '/tmp/planning-config', 'XDG_CACHE_HOME': '/tmp/planning-cache'}
service = {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never',
    'labels': labels, 'working_dir': '/app', 'user': '1000:1000', 'environment': environment, 'volumes': mounts}
override = {'services': {'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['db']}}},
    'test': service, 'migrate': service}}
config = OUT / ('compose.' + MODE + '.json')
config.write_text(json.dumps(override, indent=2) + '\n')
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    path = OUT / (label + '.log')
    with path.open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print(path.read_text()[-3000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; disposable resources will be removed')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
# Register finally teardown before the first test resource exists.
try:
    effective = json.loads(subprocess.check_output(compose + ['--profile', 'tools', 'config', '--format', 'json']))
    for name in ['db', 'test', 'migrate']:
        item = effective['services'][name]
        assert item['cgroup_parent'] == 'mbbs-tests.slice' and item['init'] is True
        assert 0 < int(item['mem_limit']) <= 2 * 1024 ** 3
        assert item['memswap_limit'] == item['mem_limit']
        assert 0 < int(item['pids_limit']) <= 512 and float(item['cpus']) <= 2
        assert all('size=' in entry for entry in item['tmpfs'])
    assert subprocess.check_output(['systemctl', 'show', 'mbbs-tests.slice', '-p', 'MemoryMax', '--value']).decode().strip() == '4294967296'
    assert run(MODE + '-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
    assert run(MODE + '-migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'node', 'src/migrate.js']) == 0
    result = run(MODE + '-runner', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node',
        'tools/unfinished-split-20261012/check.mjs', MODE])
    if MODE == 'final' and result == 0:
        result = run('changed-coverage', ['python3', str(TASK / 'coverage.py')])
    raise SystemExit(result)
finally:
    teardown = run('teardown-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(docker + ['ps', '-aq', '--filter', 'label=com.mbbs.task=' + PROJECT]).decode().split()
    if residual:
        assert run('residual-' + MODE, docker + ['rm', '-f', '-v', *residual]) == 0
        teardown = run('teardown-retry-' + MODE, compose + ['down', '--volumes', '--remove-orphans'])
    active = subprocess.check_output(docker + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_containers = subprocess.check_output(docker + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    tests = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}']).decode().strip()
    networks = subprocess.check_output(docker + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(docker + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = json.loads(subprocess.check_output(docker + ['exec', 'mbbs-operator-app-app-1', 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(async r=>{const data=await r.json();if(!r.ok||!data.ok)throw Error('Health failed');console.log(JSON.stringify({ok:data.ok}));})"]))
    (OUT / ('cleanup-' + MODE + '.json')).write_text(json.dumps({'teardownExit': teardown,
        'testContainers': tests, 'networks': networks, 'volumes': volumes, 'dockerPs': active,
        'dockerPsA': all_containers, 'productionHealthy': health.get('ok') is True}, indent=2) + '\n')
    assert teardown == 0 and not tests and not networks and not volumes and health.get('ok') is True
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

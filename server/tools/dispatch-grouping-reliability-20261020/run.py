"""Run isolated checks and remove all task-owned resources even after failure."""
import json
from pathlib import Path
import signal
import subprocess
import sys

TASK = Path(__file__).resolve().parent
SERVER = TASK.parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/dispatch-grouping-reliability-20261020'
MODE = sys.argv[1]
assert MODE in ['red', 'unit-red', 'green', 'final', 'baseline', 'static', 'mutations', 'browser', 'browser-red', 'health', 'identity-red', 'red', 'api-red']
PROJECT = 'mbbs-grouping-' + MODE
SOURCE = TASK / ('baseline' if MODE in ['baseline', 'browser-red', 'identity-red', 'red', 'api-red'] else 'candidate')
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SOURCE / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
mounts += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['tools', 'contracts']]
mounts += [f'{TASK / "tests"}:/app/test:ro']
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'eslint.mbt.config.js', '.c8rc.json']]
mounts += [f'{SERVER / "test-artifacts/operator-to-yard-flow-tooling/node_modules"}:/app/node_modules:ro',
           f'{OUT}:/app/test-artifacts']
service = {'image': 'mbbs-operator-app:dispatch-editor-control-browser-test-20261015', 'pull_policy': 'never',
    'labels': labels, 'working_dir': '/app', 'user': '1000:1000',
    'environment': {'XDG_CONFIG_HOME': '/tmp/config', 'XDG_CACHE_HOME': '/tmp/cache',
                    'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright'}, 'volumes': mounts}
config = OUT / ('compose.' + MODE + '.json')
config.write_text(json.dumps({'services': {'db': {'labels': labels}, 'test': service, 'migrate': service}}, indent=2) + '\n')
docker = ['sudo', '-n', 'docker']
compose = docker + ['compose', '-p', PROJECT, '--project-directory', str(REPO),
    '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    path = OUT / (label + '.log')
    with path.open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print(path.read_text()[-4500:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; removing disposable resources')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    effective = json.loads(subprocess.check_output(compose + ['--profile', 'tools', 'config', '--format', 'json']))
    for name in ['db', 'test', 'migrate']:
        item = effective['services'][name]
        assert item['cgroup_parent'] == 'mbbs-tests.slice' and item['init']
        assert 0 < int(item['mem_limit']) <= 2 * 1024 ** 3
        assert item['memswap_limit'] == item['mem_limit']
        assert 0 < int(item['pids_limit']) <= 512 and float(item['cpus']) <= 2
        assert all('size=' in entry for entry in item['tmpfs'])
    assert subprocess.check_output(['systemctl', 'show', 'mbbs-tests.slice', '-p', 'MemoryMax', '--value']).decode().strip() == '4294967296'
    if MODE not in ['static', 'browser', 'browser-red', 'unit-red', 'identity-red']:
        assert run(MODE + '-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
        assert run(MODE + '-migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'node', 'src/migrate.js']) == 0
    entry = {'static': 'static.mjs', 'mutations': 'mutations.mjs', 'browser': 'browser.mjs', 'browser-red': 'browser.mjs', 'health': 'check.mjs'}.get(MODE, 'check.mjs')
    result = run(MODE + '-checks', compose + ['run', '--rm', '--no-deps', '-T', 'test',
        'node', 'tools/dispatch-grouping-reliability-20261020/' + entry, MODE])
    raise SystemExit(result)
finally:
    down = run(MODE + '-teardown', compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(docker + ['ps', '-aq', '--filter', 'label=com.mbbs.task=' + PROJECT]).decode().split()
    if residual:
        run(MODE + '-residual', docker + ['rm', '-f', '-v', *residual])
        down = run(MODE + '-teardown-retry', compose + ['down', '--volumes', '--remove-orphans'])
    ps = subprocess.check_output(docker + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    psa = subprocess.check_output(docker + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    own = subprocess.check_output(docker + ['ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT, '--format', '{{.Names}}']).decode().strip()
    networks = subprocess.check_output(docker + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(docker + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = subprocess.check_output(docker + ['exec', 'mbbs-operator-app-app-1', 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(async r=>{const d=await r.json();if(!r.ok||!d.ok)process.exit(1);console.log('healthy')}).catch(()=>process.exit(1))"]).decode().strip()
    (OUT / ('cleanup-' + MODE + '.json')).write_text(json.dumps({'teardownExit': down, 'dockerPs': ps,
        'dockerPsA': psa, 'ownTestContainers': own, 'networks': networks, 'volumes': volumes,
        'productionHealthy': health == 'healthy'}, indent=2) + '\n')
    assert down == 0 and not own and not networks and not volumes and health == 'healthy'
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

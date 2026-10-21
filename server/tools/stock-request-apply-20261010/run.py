"""Use standard bounded Compose services; always remove disposable resources."""
import json
from pathlib import Path
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
ART = ROOT / 'server/test-artifacts/stock-request-apply-20261010'
STATE = Path('/home/ubuntu/operatorapp-deploy-backups/stock-request-apply-20261010')
PROJECT = 'mbbs-stock-request-apply-20261010'
MODE = sys.argv[1]
assert MODE in ['browser', 'repository', 'live-browser']
PUBLIC = ART / 'deployed-public' if MODE == 'live-browser' else STATE / 'candidate/public'
DOCKER = ['sudo', '-n', 'docker']
config = ART / 'compose.test.json'
volumes = [f'{ROOT}/server/test-artifacts:/app/test-artifacts',
           f'{ROOT}/server/test-artifacts/operator-to-yard-flow-tooling/node_modules:/app/node_modules:ro',
           f'{PUBLIC}:/app/public:ro']
volumes += [f'{STATE}/candidate/{n}:/app/{n}:ro' for n in ['src', 'migrations', 'package.json', 'package-lock.json']]
volumes += [f'{ROOT}/server/{n}:/app/{n}:ro' for n in ['tools', 'test', 'contracts']]
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
config.write_text(json.dumps({'services': {'test': {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never', 'working_dir': '/app', 'user': '1000:1000',
    'labels': labels, 'environment': {'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright', 'XDG_CONFIG_HOME': '/tmp/request-apply-config',
        'XDG_CACHE_HOME': '/tmp/request-apply-cache', 'STOCK_APPLY_MODE': MODE}, 'volumes': volumes}, 'db': {'labels': labels}}}, indent=2))
COMPOSE = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(ROOT), '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(name, command):
    with (ART / (name + '.log')).open('w') as log:
        result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode: print((ART / (name + '.log')).read_text()[-6000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Interrupted; remove test resources')

signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
code = 1
try:
    assert run('resource-policy-' + MODE, ['python3', 'docker/verify-memory-limits.py']) == 0
    assert run('db-' + MODE, COMPOSE + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '60', 'db']) == 0
    assert run('migrate-' + MODE, COMPOSE + ['run', '--rm', '--no-deps', '-T', 'test', 'npm', 'run', 'migrate']) == 0
    script = ['node', '--test', '--test-concurrency=1', 'test/mbt/integration/stock-request-search-across-statuses.test.js', 'test/mbt/integration/stock-request-repository.test.js'] if MODE == 'repository' else ['node', 'tools/stock-request-apply-20261010/manual-browser.mjs']
    code = run(MODE, COMPOSE + ['run', '--rm', '--no-deps', '-T', 'test', *script])
finally:
    down = run('teardown-' + MODE, COMPOSE + ['down', '--volumes', '--remove-orphans'])
    def output(*args): return subprocess.check_output(DOCKER + list(args), text=True).strip()
    cleanup = {'downExit': down,
        'dockerPs': output('ps', '--format', '{{.Names}} {{.Status}}'),
        'dockerPsA': output('ps', '-a', '--format', '{{.Names}} {{.Status}}'),
        'containers': output('ps', '-a', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Names}}'),
        'volumes': output('volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'),
        'networks': output('network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'),
        'productionHealthy': json.loads(output('exec', 'mbbs-operator-app-app-1', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))")).get('ok') is True}
    cleanup['complete'] = down == 0 and not any(cleanup[n] for n in ['containers', 'volumes', 'networks']) and cleanup['productionHealthy']
    (ART / f'run-{MODE}.json').write_text(json.dumps({'exit': code, 'cleanup': cleanup}, indent=2) + '\n')
    assert cleanup['complete'], 'Test cleanup or production health failed'
    print(json.dumps({'mode': MODE, 'exit': code, 'cleanup': 'complete'}), flush=True)
raise SystemExit(code)

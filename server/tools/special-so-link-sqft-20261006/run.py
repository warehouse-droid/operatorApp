"""Run isolated checks; always remove test containers, volumes and networks."""
import json
from pathlib import Path
import signal
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[2]
ROOT = SERVER.parent
OUT = SERVER / 'test-artifacts/special-so-link-sqft-20261006'
RUNTIME = OUT / 'runtime'
PROJECT = 'mbbs-special-so-link-20261006'
IMAGE = 'mbbs-regular-v2:e2e'
mode = sys.argv[1]
files = ['src/special-stock-request-repository.js', 'src/special-stock-pricing-domain.js',
         'public/sales-special-stock-requests.js']
volumes = [f'{RUNTIME / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
volumes += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['test', 'tools']]
volumes += [f'{RUNTIME / filename}:/app/{filename}:ro' for filename in
            ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']]
volumes += [f'{OUT}:/app/test-artifacts/special-so-link-sqft-20261006']
if mode not in ['red', 'red-browser', 'baseline']:
    volumes += [f'{SERVER / filename}:/app/{filename}:ro' for filename in files]
override = OUT / ('compose-' + mode + '.json')
services = {service: {'image': IMAGE, 'pull_policy': 'never',
    'environment': {'XDG_CONFIG_HOME': '/tmp/browser-config', 'XDG_CACHE_HOME': '/tmp/browser-cache',
                    'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify'},
    'labels': {'com.mbbs.lifecycle': 'disposable-test'}, 'volumes': volumes}
    for service in ['migrate', 'test', 'e2e']}
services['db'] = {'environment': {'POSTGRES_DB': 'mbt_verify'}, 'networks': {'mbt_test_internal': {
    'aliases': ['mbbs-special-review-db', 'mbbs-special-updates-db-20261002']}}}
override.write_text(json.dumps({'services': services}))
compose = ['sudo', '-n', 'docker', 'compose', '-p', PROJECT, '-f', str(ROOT / 'docker-compose.mbt-test.yml'), '-f', str(override)]

def run(label, args, check=True):
    with (OUT / (mode + '-' + label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    print(json.dumps({'mode': mode, 'step': label, 'exitCode': result.returncode}), flush=True)
    if check and result.returncode:
        print((OUT / (mode + '-' + label + '.log')).read_text()[-6500:], flush=True)
        raise RuntimeError(label + ' failed')
    return result.returncode

def interrupted(signum, _frame):
    raise KeyboardInterrupt('Interrupted by signal ' + str(signum))

for sig in [signal.SIGTERM, signal.SIGINT]:
    signal.signal(sig, interrupted)

try:
    if mode != 'red-browser':
        run('db', compose + ['up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'db'])
        run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate', 'node', 'src/migrate.js'])
    command = ['node', 'tools/special-so-link-sqft-20261006/check.mjs', mode]
    run('checks', compose + ['run', '--rm', '--no-deps', '-T', 'test', *command])
finally:
    run('teardown', compose + ['down', '--volumes', '--remove-orphans'], check=False)
    remaining = subprocess.check_output(['sudo', '-n', 'docker', 'ps', '-aq', '--filter',
        'label=com.docker.compose.project=' + PROJECT]).decode().split()
    if remaining:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '--force', '--volumes', *remaining], check=True,
                       stdout=subprocess.DEVNULL)
        run('teardown-oneoffs', compose + ['down', '--volumes', '--remove-orphans'], check=False)
    for args, name in [(['ps'], 'docker-ps'), (['ps', '-a'], 'docker-ps-all')]:
        output = subprocess.check_output(['sudo', '-n', 'docker', *args, '--format', '{{.Names}} {{.Status}}']).decode()
        (OUT / (mode + '-' + name + '.log')).write_text(output)
        assert PROJECT not in output, 'A task test container remains'
        print(output, end='', flush=True)
    networks = subprocess.check_output(['sudo', '-n', 'docker', 'network', 'ls', '--filter',
        'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    assert not networks, 'A task test network remains'
    print(json.dumps({'cleanup': 'complete', 'mode': mode}), flush=True)

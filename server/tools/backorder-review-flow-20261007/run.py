"""Run task checks in the standard disposable Compose environment."""
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import urllib.request

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/backorder-review-flow-20261007'
PROJECT = 'mbbs-backorder-review-flow-20261007'
IMAGE = 'mbbs-delivery-requests:final'
OVERRIDE = OUT / 'compose.test.json'
env = {'STOCKING_CUSTOMER_BROWSER_OUTPUT':'/app/test-artifacts/backorder-review-flow-20261007/browser', 'BACKORDER_BROWSER_OUTPUT':'/app/test-artifacts/backorder-review-flow-20261007/browser', 'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
       'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
       'XDG_CONFIG_HOME': '/tmp/mbbs-chromium-config', 'XDG_CACHE_HOME': '/tmp/mbbs-chromium-cache',
       'SPECIAL_HEADER_NOTE_BROWSER_OUTPUT': '/app/test-artifacts/backorder-review-flow-20261007/browser',
       'SPECIAL_DELIVERY_FEE_BROWSER_OUTPUT': '/app/test-artifacts/backorder-review-flow-20261007/fee-browser',
       'SPECIAL_CUSTOM_PO_BROWSER_OUTPUT': '/app/test-artifacts/backorder-review-flow-20261007/custom-browser'}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'test', 'tools', 'migrations']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'netsuite-smart-scm-picking-ticket-restlet.js']]
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
override = {'services': {
    'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['db','mbbs-special-review-db','mbbs-special-updates-db-20261002']}}},
    'test': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'environment': env, 'volumes': mounts},
    'migrate': {'image': IMAGE, 'pull_policy': 'never', 'labels': labels, 'environment': env, 'volumes': mounts}}}
OUT.mkdir(parents=True, exist_ok=True)
OVERRIDE.write_text(json.dumps(override, indent=2))
compose = ['docker', 'compose', '--project-name', PROJECT, '--project-directory', str(REPO),
           '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(OVERRIDE)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'stage': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-2200:], flush=True)
    return result.returncode

mode = sys.argv[1]
assert mode in ['repair-fixture','reminder-red','preflight','quotation-red','resolution','status-red','queue-red','corrected-red','sequence-red','red','baseline','focused','all','static','browser','browser-red','migration','mutations','coverage','coverage-audit','regression','quick','worker-red','price-red','schema-red','alerts-red','uom-red','ui-contract','stage-mutation','approval-red','enhancement-red','finish']
def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Test task interrupted; removing its disposable environment')
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
# Teardown is registered before the first environment mutation.
try:
    assert run('resource-policy', ['python3', 'docker/verify-memory-limits.py']) == 0
    if mode not in ['static','coverage-audit','ui-contract']:
        assert run('start-db', compose + ['up', '-d', '--wait', '--no-build', '--pull', 'never', 'db']) == 0
        assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    code = run(mode + '-runner', compose + ['run', '--rm', '--no-deps', '-T', 'test',
                                           'node', 'tools/backorder-review-flow-20261007/check.mjs', mode])
    raise SystemExit(code)
finally:
    teardown = run('teardown-' + mode, compose + ['down', '--volumes', '--remove-orphans'])
    residual = subprocess.check_output(['docker','ps','-a','--filter','label=com.mbbs.task='+PROJECT,'--format','{{.ID}}']).decode().split()
    if residual:
        records=json.loads(subprocess.check_output(['docker','inspect',*residual]))
        assert all(row['Config']['Labels'].get('com.mbbs.lifecycle')=='disposable-test' and row['Config']['Labels'].get('com.mbbs.task')==PROJECT for row in records)
        assert run('remove-residual-oneoffs-'+mode,['docker','rm','-f','-v',*residual])==0
        teardown=run('teardown-after-oneoffs-'+mode,compose+['down','--volumes','--remove-orphans'])
    status = subprocess.check_output(['docker', 'ps', '-a', '--filter', 'label=com.mbbs.task=' + PROJECT,
                                      '--format', '{{.Names}}']).decode().strip()
    active = subprocess.check_output(['docker', 'ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_tests = subprocess.check_output(['docker', 'ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test',
                                         '--format', '{{.Names}}\t{{.Status}}']).decode()
    networks = subprocess.check_output(['docker', 'network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT,
                                        '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(['docker', 'volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT,
                                       '--format', '{{.Name}}']).decode().strip()
    (OUT / ('cleanup-' + mode + '.json')).write_text(json.dumps({'teardownExit': teardown,
        'taskContainers': status, 'taskNetworks': networks, 'taskVolumes': volumes, 'dockerPs': active, 'dockerPsA': subprocess.check_output(['docker','ps','-a','--format','{{.Names}}\t{{.Status}}']).decode(), 'disposableTests': all_tests}, indent=2))
    assert teardown == 0 and not status and not networks and not volumes, 'Disposable task environment was not removed'
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=15) as health_response: health=json.load(health_response)
    assert health.get('ok') is True
    print(json.dumps({'cleanup': 'complete', 'otherTestWorkloads': all_tests.strip(), 'productionHealth': health.get('ok')}), flush=True)

"""Run focused confirmation checks in bounded, disposable Compose containers."""
import json
from pathlib import Path
import re
import signal
import sys
import subprocess

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-local-adjustments-20261013'
PROJECT = 'mbbs-special-local-adjustments-20261013'
DOCKER = ['sudo', '-n', 'docker']
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'test', 'tools', 'migrations', 'contracts']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'eslint.mbt.config.js', 'netsuite-smart-scm-picking-ticket-restlet.js']]
mounts += [f'{SERVER / "test-artifacts/driver-upload-reliability/toolchain/node_modules"}:/app/node_modules:ro']
environment = {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
               'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
               'XDG_CONFIG_HOME': '/tmp/special-confirmation-config', 'XDG_CACHE_HOME': '/tmp/special-confirmation-cache',
               'SPECIAL_BROWSER_ARTIFACTS': '/app/test-artifacts/special-local-adjustments-20261013/browser'}
service = {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never',
           'working_dir': '/app', 'user': '1000:1000', 'labels': labels,
           'environment': environment, 'volumes': mounts}
override = {'services': {
    'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['mbbs-special-review-db', 'mbbs-special-updates-db-20261002']}}},
    'test': service, 'migrate': service}}
config = OUT / 'compose.test.json'
config.write_text(json.dumps(override, indent=2))
compose = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                   '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'check': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-6000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Remove disposable containers and storage')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
results = {}
# Register teardown before launching any test container or disposable database.
try:
    assert run('resource-policy', ['python3', 'docker/verify-memory-limits.py']) == 0
    if len(sys.argv)>1 and sys.argv[1]=='red':
        result=run('red',compose+['run','--rm','--no-deps','-T','test','node','--test','test/mbt/unit/special-local-adjustments.test.js'])
        assert result != 0, 'New acceptance tests must fail before implementation'
        sys.exit(0)
    assert run('start-db', compose + ['up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('create-db', compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'CREATE DATABASE mbt_verify']) == 0
    assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    assert run('migrate-status',compose+['run','--rm','--no-deps','-T','-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify','migrate']) == 0
    assert run('seed-item-master', compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c',
        "INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()),(1987,'Delivery Charge',NULL,'{}',now()) ON CONFLICT DO NOTHING"]) == 0
    if len(sys.argv)>1 and sys.argv[1]=='red-features':
        result=run('red-integration',compose+['run','--rm','--no-deps','-T','test','node','--test','test/mbt/integration/special-local-adjustments.test.js'])
        browser=run('red-browser',compose+['run','--rm','--no-deps','-T','test','node','--test','--test-name-pattern=local adjustment|SCM removal','test/mbt/integration/special-approval-browser.test.js'])
        baseline=run('baseline',compose+['run','--rm','--no-deps','-T','test','node','--test','--test-concurrency=1','test/mbt/unit/special-workflow-quantity-service.test.js','test/mbt/integration/special-workflow-pricing.test.js'])
        assert result != 0 and browser != 0
        sys.exit(baseline)
    if len(sys.argv)>1 and sys.argv[1]=='red-po':
        result=run('red-po',compose+['run','--rm','--no-deps','-T','test','node','--test','--test-name-pattern=local removal before PO|PO creation after a local request','test/mbt/integration/special-local-adjustments.test.js','test/mbt/unit/special-stock-request-service.red.test.js'])
        assert result != 0
        sys.exit(0)
    tests = ['test/mbt/unit/special-stock-request-service.red.test.js','test/mbt/unit/special-local-adjustments.test.js', 'test/mbt/unit/special-workflow-quantity-service.test.js',
      'test/mbt/unit/special-workflow-adjustments.test.js', 'test/mbt/unit/special-workflow-quantity-transition.test.js',
      'test/mbt/unit/special-workflow-quantity-adapter.test.js', 'test/mbt/unit/special-workflow-adjustment-adapter.test.js',
      'test/mbt/unit/special-workflow-adjustment-restlet.test.js', 'test/mbt/unit/special-customer-confirmation.test.js']
    results['unit'] = run('unit', compose + ['run', '--rm', '--no-deps', '-T', 'test',
      'node', '--test', '--test-concurrency=1', *tests])
    integration = ['test/mbt/integration/special-local-adjustments.test.js', 'test/mbt/integration/special-workflow-pricing.test.js',
      'test/mbt/integration/special-workflow-pricing-http.test.js']
    results['integration'] = run('integration', compose + ['run', '--rm', '--no-deps', '-T',
      '-e', 'DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
      'test', 'node', '--test', '--test-concurrency=1', *integration])
    results['status-integration'] = run('status-integration',compose+['run','--rm','--no-deps','-T','-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify','test','node','--test','test/mbt/integration/special-customer-confirmation.test.js'])
    results['browser'] = run('browser', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '--test',
      '--test-name-pattern=local adjustment|SCM removal|Confirmed request preserves', 'test/mbt/integration/special-approval-browser.test.js'])
    changed=['src/special-stock-local-adjustments.js','src/special-stock-quantity-service.js','src/special-stock-request-service.js','src/special-stock-request-repository.js',
      'public/sales-special-stock-requests.js','public/scm-special-stock-requests.js']
    results['ui-changed-coverage']=run('ui-changed-coverage',['python3',str(SERVER/'tools/special-local-adjustments-20261013/ui-coverage.py')])
    results['syntax']=run('syntax',compose+['run','--rm','--no-deps','-T','test','node','-e',
      "const{spawnSync}=require('node:child_process');for(const file of "+json.dumps(changed)+"){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status)process.exit(r.status)}"])
    results['types']=run('types',compose+['run','--rm','--no-deps','-T','test','node','node_modules/typescript/bin/tsc',
      '--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','src/special-stock-local-adjustments.js'])
    results['lint']=run('lint',compose+['run','--rm','--no-deps','-T','test','node','node_modules/eslint/bin/eslint.js',
      '--config','tools/special-local-adjustments-20261013/eslint.config.js','--max-warnings=0',*changed,
      'test/mbt/unit/special-local-adjustments.test.js','test/mbt/integration/special-local-adjustments.test.js'])
    results['coverage']=run('coverage',compose+['run','--rm','--no-deps','-T','test','node','node_modules/c8/bin/c8.js',
      '--include=src/special-stock-local-adjustments.js','--include=src/special-stock-quantity-service.js',
      '--include=src/special-stock-request-repository.js','--include=src/special-stock-request-service.js','--temp-directory=/tmp/special-local-coverage',
      '--report-dir=test-artifacts/special-local-adjustments-20261013/coverage','--reporter=json',
      'node','--test','--test-concurrency=1','test/mbt/unit/special-local-adjustments.test.js',
      'test/mbt/unit/special-workflow-quantity-service.test.js','test/mbt/unit/special-stock-request-service.red.test.js','test/mbt/integration/special-local-adjustments.test.js'])
    results['changed-coverage']=run('changed-coverage',['python3',str(SERVER/'tools/special-local-adjustments-20261013/coverage.py')])
    results['mutations']=run('mutations',['python3',str(SERVER/'tools/special-local-adjustments-20261013/mutate.py')])
    results['unit']=run('unit',compose+['run','--rm','--no-deps','-T','test','node','--test','--test-concurrency=1',*tests])
    # Deterministic opposite file order checks shared fixtures and review-state isolation.
    results['suite-order']=run('suite-order',compose+['run','--rm','--no-deps','-T','test','node','--test','--test-concurrency=1',
      'test/mbt/integration/special-local-adjustments.test.js','test/mbt/unit/special-local-adjustments.test.js'])
    (OUT / 'checks.json').write_text(json.dumps(results, indent=2) + '\n')
    assert all(code == 0 for name, code in results.items() if not name.startswith('known-')), 'See regression logs for failed checks'
finally:
    teardown = run('teardown', compose + ['--profile', '*', 'down', '--volumes', '--remove-orphans'])
    active = subprocess.check_output(DOCKER + ['ps', '--format', '{{.Names}}\t{{.Status}}']).decode()
    all_containers = subprocess.check_output(DOCKER + ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).decode()
    tests = subprocess.check_output(DOCKER + ['ps', '-a', '--filter', 'label=com.mbbs.lifecycle=disposable-test', '--format', '{{.Names}}']).decode().strip()
    networks = subprocess.check_output(DOCKER + ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    volumes = subprocess.check_output(DOCKER + ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']).decode().strip()
    health = json.loads(subprocess.check_output(DOCKER + ['exec', 'mbbs-operator-app-app-1', 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(h=>console.log(JSON.stringify({ok:h.ok})))"]))
    cleanup = {'teardownExit': teardown, 'testContainers': tests, 'testNetworks': networks,
               'testVolumes': volumes, 'dockerPs': active, 'dockerPsA': all_containers,
               'productionHealthy': health.get('ok') is True}
    (OUT / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
    own = subprocess.check_output(DOCKER + ['ps','-a','--filter','label=com.docker.compose.project='+PROJECT,'--format','{{.Names}}']).decode().strip()
    assert teardown == 0 and not own and not networks and not volumes and health.get('ok') is True
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

"""Run focused confirmation checks in bounded, disposable Compose containers."""
import json
from pathlib import Path
import re
import signal
import subprocess

SERVER = Path(__file__).resolve().parents[2]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-customer-confirmation-20261013'
PROJECT = 'mbbs-special-customer-confirmation-20261013'
DOCKER = ['sudo', '-n', 'docker']
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
mounts = [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'test', 'tools', 'migrations', 'contracts']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'eslint.mbt.config.js', 'netsuite-smart-scm-picking-ticket-restlet.js']]
mounts += [f'{SERVER / "test-artifacts/driver-upload-reliability/toolchain/node_modules"}:/app/node_modules:ro']
environment = {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_verify',
               'PLAYWRIGHT_BROWSERS_PATH': '/ms-playwright',
               'XDG_CONFIG_HOME': '/tmp/special-confirmation-config', 'XDG_CACHE_HOME': '/tmp/special-confirmation-cache',
               'SPECIAL_BROWSER_ARTIFACTS': '/app/test-artifacts/special-customer-confirmation-20261013/browser'}
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
    assert run('start-db', compose + ['up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('create-db', compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_test', '-c', 'CREATE DATABASE mbt_verify']) == 0
    assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    assert run('seed-item-master', compose + ['exec', '-T', 'db', 'psql', '-U', 'mbt_test', '-d', 'mbt_verify', '-c',
        "INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(2055,'MBBS-Special Order','PC','{}',now()),(1784,'PALLET','EACH','{}',now()),(1987,'Delivery Charge',NULL,'{}',now()) ON CONFLICT DO NOTHING"]) == 0
    # Reproduce two unrelated failures against the exact pre-task sources.
    baseline = OUT / 'compose.baseline.json'
    baseline_files = ['public/special-stock-workflow.js', 'public/special-stock-case-edits.js',
        'public/special-stock-case-status.js', 'public/scm-special-stock-requests.js', 'src/special-stock-request-repository.js',
        'test/mbt/integration/special-stock-request-workflow.red.test.js', 'test/mbt/integration/special-workflow-review.test.js',
        'test/mbt/integration/special-approval-browser.test.js']
    baseline.write_text(json.dumps({'services': {'test': {'volumes':
        [f'{OUT / "before" / name}:/app/{name}:ro' for name in baseline_files]}}}, indent=2))
    known_failures = 'multi-line case transitions|real order service persists'
    results['known-baseline'] = run('known-baseline', compose + ['-f', str(baseline), 'run', '--rm', '--no-deps', '-T', 'test',
        'node', '--test', '--test-concurrency=1', '--test-name-pattern=' + known_failures,
        'test/mbt/integration/special-stock-request-workflow.red.test.js', 'test/mbt/integration/special-workflow-review.test.js'])
    results['known-browser-baseline'] = run('known-browser-baseline', compose + ['-f', str(baseline), 'run', '--rm', '--no-deps', '-T', 'test',
        'node', '--test', '--test-name-pattern=approved PO exposes shared reference form', 'test/mbt/integration/special-approval-browser.test.js'])
    unit = ['special-customer-confirmation.test.js', 'special-stock-request-domain.red.test.js',
            'special-workflow-review.test.js', 'special-workflow-adapter.test.js',
            'special-approval-fulfillment.test.js', 'special-line-decline.test.js', 'special-stock-transfer.test.js', 'special-logistics-progress.test.js']
    integration = ['special-customer-confirmation.test.js', 'special-stock-request-workflow.red.test.js',
                   'special-approval-fulfillment.test.js', 'special-stock-transfer.test.js', 'special-batch-save.test.js',
                   'special-workflow-review.test.js', 'special-workflow-polish.test.js',
                   'special-stock-updates.test.js', 'special-sales-items-copy-http.test.js']
    for label, tests in [('unit', ['test/mbt/unit/' + name for name in unit]),
                         ('integration', ['test/mbt/integration/' + name for name in integration]),
                         ('browser', ['test/mbt/integration/special-approval-browser.test.js'])]:
        # Positive names avoid matching Node's file-level parent suite, which
        # would cause a negative pattern to include its excluded children.
        options = []
        if label in ['integration', 'browser']:
            names = [match.group(2) for path in tests for match in re.finditer(r"test\(\s*(['\"])(.*?)\1", (SERVER / path).read_text())]
            excluded = ['multi-line case transitions', 'real order service persists', 'approved PO exposes shared reference form']
            selected = [name for name in names if not any(name.startswith(prefix) for prefix in excluded)]
            options = ['--test-name-pattern=' + '|'.join(re.escape(name) for name in selected)]
        results[label] = run(label, compose + ['run', '--rm', '--no-deps', '-T', 'test',
            'node', '--test', '--test-concurrency=1', *options, *tests])
    results['decline-http'] = run('decline-http', compose + ['run', '--rm', '--no-deps', '-T',
        '-e', 'DATABASE_URL=postgres://mbt_test:mbt_test_password@mbbs-special-updates-db-20261002:5432/mbt_verify',
        'test', 'node', '--test', '--test-concurrency=1', 'test/mbt/integration/special-line-decline-http.test.js'])
    results['syntax'] = run('syntax', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '-e',
        "const {spawnSync}=require('node:child_process');for(const file of ['public/special-stock-workflow.js','public/special-stock-case-edits.js','public/special-stock-case-status.js','public/scm-special-stock-requests.js','src/special-stock-request-repository.js']){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status)process.exit(r.status)}"])
    results['lint'] = run('lint', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'node_modules/eslint/bin/eslint.js',
        '--config', 'eslint.mbt.config.js', '--max-warnings=0', 'test/mbt/unit/special-customer-confirmation.test.js',
        'test/mbt/integration/special-customer-confirmation.test.js'])
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
    assert teardown == 0 and not tests and not networks and not volumes and health.get('ok') is True
    print(json.dumps({'cleanup': 'complete', 'productionHealthy': True}), flush=True)

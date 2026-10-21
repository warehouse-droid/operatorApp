"""Validate PO-reference request stages in bounded, disposable test containers."""
import json
from pathlib import Path
import signal
import subprocess
import os

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-po-dispatch-stage-20261014'
PROJECT = 'mbbs-po-dispatch-stage-20261014'
DOCKER = ['sudo', '-n', 'docker']
OUT.mkdir(parents=True, exist_ok=True)
labels = {'com.mbbs.lifecycle': 'disposable-test', 'com.mbbs.task': PROJECT}
CODE = Path(os.environ.get('SPECIAL_DISPATCH_TEST_CODE', str(SERVER)))
mounts = [f'{CODE / folder}:/app/{folder}:ro' for folder in ['src', 'public', 'migrations']]
mounts += [f'{SERVER / folder}:/app/{folder}:ro' for folder in ['test', 'tools', 'contracts']]
mounts += [f'{SERVER / file}:/app/{file}:ro' for file in ['package.json', 'package-lock.json', 'eslint.mbt.config.js', 'netsuite-smart-scm-picking-ticket-restlet.js']]
mounts += [f'{SERVER / "test-artifacts/driver-upload-reliability/toolchain/node_modules"}:/app/node_modules:ro']
service = {'image': 'mbbs-to-yard-test-browser:20261009', 'pull_policy': 'never', 'working_dir': '/app', 'user': '1000:1000',
           'labels': labels, 'volumes': mounts, 'environment': {'DATABASE_URL': 'postgres://mbt_test:mbt_test_password@db:5432/mbt_test',
            'PLAYWRIGHT_BROWSERS_PATH':'/ms-playwright','BACKORDER_BROWSER_OUTPUT':'/app/test-artifacts/special-po-dispatch-stage-20261014/browser'}}
config = OUT / 'compose.test.json'
config.write_text(json.dumps({'services': {'db': {'labels': labels, 'networks': {'mbt_test_internal': {'aliases': ['mbbs-special-review-db']}}},
                                         'test': service, 'migrate': service}}, indent=2))
compose = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(REPO),
                   '-f', str(REPO / 'docker-compose.mbt-test.yml'), '-f', str(config)]

def run(label, args):
    with (OUT / (label + '.log')).open('w') as log:
        result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, cwd=REPO)
    print(json.dumps({'check': label, 'exit': result.returncode}), flush=True)
    if result.returncode:
        print((OUT / (label + '.log')).read_text()[-7000:], flush=True)
    return result.returncode

def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Remove disposable test containers and storage')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
focus = os.environ.get('SPECIAL_DISPATCH_FOCUS') == '1'
checks = json.loads((OUT / 'checks.json').read_text()) if focus else {}
try:
    assert run('resource-policy', ['python3', 'docker/verify-memory-limits.py']) == 0
    assert run('start-db', compose + ['up', '-d', '--wait', '--wait-timeout', '45', '--no-build', '--pull', 'never', 'db']) == 0
    assert run('migrate', compose + ['run', '--rm', '--no-deps', '-T', 'migrate']) == 0
    tests = ['test/mbt/unit/special-po-dispatch-stage.test.js', 'test/mbt/unit/backorder-workflow.test.js',
             'test/mbt/property/backorder-link-sequence.property.test.js',
             'test/mbt/unit/special-customer-confirmation.test.js', 'test/mbt/unit/special-workflow-review.test.js',
             'test/mbt/unit/special-stock-request-domain.red.test.js', 'test/mbt/integration/special-po-dispatch-stage.test.js',
             'test/mbt/integration/backorder-requests.test.js', 'test/mbt/integration/backorder-already-ordered.test.js']
    if focus:
        checks['focused-workflow'] = run('focused-workflow',compose+['run','--rm','--no-deps','-T','test','node','--test','--test-concurrency=1',
            '--test-name-pattern=PO linkage notifies|pending information after PO|information replies|Special and Backorder wait|reference changes',
            'test/mbt/integration/backorder-requests.test.js','test/mbt/integration/special-po-dispatch-stage.test.js'])
    else:
        checks['workflow'] = run('workflow', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '--test', '--test-concurrency=1', *tests])
        checks['special-completion'] = run('special-completion', compose + ['run', '--rm', '--no-deps', '-T',
            '-e', 'DATABASE_URL=postgres://mbt_test:mbt_test_password@mbbs-special-review-db:5432/mbt_test', 'test', 'node', '--test',
            'test/mbt/integration/special-customer-confirmation.test.js'])
    syntax = "const{spawnSync}=require('node:child_process');for(const file of " + json.dumps(['public/special-stock-workflow.js','public/backorder-workflow.js','public/backorder-stock-requests.js','src/special-stock-request-repository.js','src/backorder-request-service.js']) + "){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status)process.exit(r.status)}"
    checks['syntax'] = run('syntax', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', '-e', syntax])
    checks['types'] = run('types', compose + ['run', '--rm', '--no-deps', '-T', 'test', 'node', 'node_modules/typescript/bin/tsc',
        '--allowJs','--checkJs','--noEmit','--skipLibCheck','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023',
        'public/special-stock-workflow.js','public/backorder-workflow.js'])
    if not focus:
        checks['browser'] = run('browser', compose + ['run','--rm','--no-deps','-T','test','node','--test',
            'test/mbt/integration/backorder-browser.test.js'])
    (OUT / 'checks.json').write_text(json.dumps(checks, indent=2))
finally:
    down = run('teardown', compose + ['--profile', '*', 'down', '--volumes', '--remove-orphans'])
    evidence = {key: subprocess.check_output(DOCKER + args).decode() for key, args in {
        'dockerPs': ['ps', '--format', '{{.Names}} {{.Status}}'], 'dockerPsA': ['ps', '-a', '--format', '{{.Names}} {{.Status}}'],
        'containers': ['ps', '-a', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Names}}'],
        'networks': ['network', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}'],
        'volumes': ['volume', 'ls', '--filter', 'label=com.docker.compose.project=' + PROJECT, '--format', '{{.Name}}']}.items()}
    health = subprocess.run(['curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:3000/health'], capture_output=True)
    evidence['productionHealthy'] = health.returncode == 0 and json.loads(health.stdout).get('ok') is True
    (OUT / 'cleanup.json').write_text(json.dumps(evidence, indent=2))
    assert down == 0 and not any(evidence[key].strip() for key in ['containers', 'networks', 'volumes']) and evidence['productionHealthy']
assert checks and all(code == 0 for code in checks.values()), checks

#!/usr/bin/env python3
"""Release the SCM readiness selector and status persistence over the captured live app."""
import json
import os
import runpy
import shlex
import subprocess
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base, scope = release['base'], release['scope']
scope.update(
    OUT=base['SERVER'] / 'deployments/special-readiness-status-20261026',
    FILES=['src/special-stock-request-repository.js', 'public/scm-special-stock-requests.js', 'public/scm-stock-requests.html'],
    IMAGE='mbbs-operator-app:special-readiness-status-20261026',
    ROLLBACK='mbbs-operator-app:special-readiness-status-rollback-20261026',
)
TESTS = [
    'test/mbt/integration/special-readiness-status.test.js',
    'test/mbt/integration/special-stock-transfer.test.js',
    'test/mbt/integration/special-stock-check-editing-browser.test.js',
    'test/mbt/integration/special-transfer-eta-browser.test.js',
]
LOW_INVENTORY_TEST = 'test/mbt/integration/special-stock-updates-browser.test.js'


def prepare():
    release['prepare']()
    for folder in ['live-before', 'candidate']:
        root = scope['OUT'] / folder
        for path in [root, *root.rglob('*')]:
            path.chmod(0o755 if path.is_dir() else 0o644)


def validate():
    prepared = base['ensure_sources']()
    candidate = scope['OUT'] / 'candidate'
    env = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_RUNTIME=str(candidate),
               DISPATCH_SOURCE_MIGRATIONS=str(candidate / 'migrations'))
    commands = [shlex.join(['node', '--test', '--test-concurrency=1', *TESTS]),
                shlex.join(['node', '--test', '--test-name-pattern=SCM treats accepted Low inventory', LOW_INVENTORY_TEST])]
    subprocess.run(['sudo', '-n', 'env', *[key + '=' + env[key] for key in
                    ['DISPATCH_SOURCE_SKIP_BUILD', 'DISPATCH_SOURCE_RUNTIME', 'DISPATCH_SOURCE_MIGRATIONS']],
                    'bash', str(base['REPO'] / 'docker/run-dispatch-source-tests.sh'),
                    'sh', '-c', ' && '.join(commands)], check=True)
    assert base['ensure_sources']() == prepared
    base['save'](scope['OUT'] / 'validation.json', {
        'passed': True, 'sourceHashes': prepared['sourceHashes'], 'suites': TESTS,
        'additionalTest': {'file': LOW_INVENTORY_TEST, 'namePattern': 'SCM treats accepted Low inventory'},
        'testSourceHashes': {file: base['sha'](base['SERVER'] / file) for file in [*TESTS, LOW_INVENTORY_TEST]},
        'disposableRunnerCompleted': True,
    })


def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    results = []
    for route in ['/health', '/scm/stock-requests', '/scm-special-stock-requests.js?readinessStatus=20261026']:
        status = subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}',
                                          'http://127.0.0.1:3000' + route], text=True)
        assert status == '200', route + ': ' + status
        results.append({'path': route, 'status': int(status)})
    base['save'](scope['OUT'] / 'live-verification.json', {'sourceHashesVerified': True, 'http': results})
    print(json.dumps({'liveVerification': 'passed', 'files': len(prepared['sourceHashes'])}))


def deploy():
    active = base['db']("""BEGIN READ ONLY;
      SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))
        + (SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))
        + (SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')
        + (SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating'
             OR purchase_order_operation_status='creating');
      COMMIT;""")
    assert active == '0', 'Wait for in-flight application operations before restarting: ' + active
    base['deploy']()


scope['verify'] = verify
if __name__ == '__main__':
    {'prepare': prepare, 'validate': validate, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

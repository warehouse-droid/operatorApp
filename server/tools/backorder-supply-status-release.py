#!/usr/bin/env python3
"""Release the Backorder supply dropdown and stock evidence refresh controls."""
import hashlib
import json
import os
import re
import runpy
import subprocess
import sys
import urllib.request
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('regular-stock-quantity-release.py')))
base, scope = release['base'], release['scope']
scope.update(
    OUT=scope['SERVER'] / 'deployments/backorder-supply-status-20261028',
    FILES=['public/backorder-stock-requests.js', 'public/scm-stock-requests.js',
           'public/scm-stock-requests.html'],
    IMAGE='mbbs-operator-app:backorder-supply-status-20261028',
    ROLLBACK='mbbs-operator-app:backorder-supply-status-rollback-20261028')
release['prepare'].__globals__.update(
    NEW_FILES=[], reviewed_live={name: base['sha'](scope['OUT'] / 'workspace-before' / name)
                                for name in scope['FILES']})


def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run([sys.executable, str(scope['SERVER'].parent / 'docker/retention/retention.py'),
                        'run', '--root', '/tmp', '--', sys.executable, __file__, 'validate'], check=True)
        return
    prepared = base['ensure_sources']()
    artifacts = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    suites = ['stock-request-followups-browser', 'backorder-enhancements-browser',
              'backorder-already-ordered-browser', 'stock-request-followups',
              'stock-request-followups-guards']
    arguments = ['test/mbt/integration/' + name + '.test.js' for name in suites]
    arguments.append('test/mbt/unit/backorder-review-flow.test.js')
    environment = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1',
                       DISPATCH_SOURCE_RUNTIME=str(scope['OUT'] / 'candidate'),
                       DISPATCH_SOURCE_MIGRATIONS=str(scope['OUT'] / 'candidate/migrations'))
    command = ('node --check public/backorder-stock-requests.js && '
               'node --check public/scm-stock-requests.js && '
               'node tools/stock-request-followups-suites.mjs ' + ' '.join(arguments))
    log = artifacts / 'backorder-supply-status.log'
    with log.open('w') as output:
        result = subprocess.run(['bash', 'docker/run-dispatch-source-tests.sh', 'bash', '-c', command],
                                cwd=scope['SERVER'].parent, env=environment,
                                stdout=output, stderr=subprocess.STDOUT)
    text = log.read_text()
    if result.returncode:
        print(text[-18000:])
    assert result.returncode == 0, 'Backorder browser and workflow regressions failed'
    counts = {key: sum(map(int, re.findall(r'^ℹ ' + key + r' (\d+)$', text, re.M)))
              for key in ['pass', 'fail', 'skipped']}
    assert counts == {'pass': 29, 'fail': 0, 'skipped': 0}, counts
    assert base['ensure_sources']() == prepared
    base['save'](scope['OUT'] / 'validation.json', {
        'passed': True, 'sourceHashes': prepared['sourceHashes'], 'suites': arguments, **counts,
        'syntaxFiles': 2, 'isolatedRunner': 'docker/run-dispatch-source-tests.sh',
        'cleanupVerified': True})
    print(json.dumps({'validation': 'passed', **counts}), flush=True)


def verify():
    prepared = base['ensure_sources']()
    checks = []
    for name, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + name).split()[0] == expected
        path = '/scm/stock-requests' if name.endswith('.html') else '/' + Path(name).name
        request = urllib.request.Request('http://127.0.0.1:3000' + path + '?supplyStatus=20261028-v1',
                                         headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=15) as response:
            actual = hashlib.sha256(response.read()).hexdigest()
            assert response.status == 200 and actual == expected, name
            checks.append({'path': path, 'status': response.status, 'sha256': actual})
    assert base['health'](), 'Application health failed'
    base['save'](scope['OUT'] / 'live-verification.json', {
        'sourceHashesVerified': True, 'healthy': True, 'http': checks})
    print(json.dumps({'liveVerification': 'passed', 'files': len(checks)}))


scope['verify'] = verify
if __name__ == '__main__':
    {'prepare': release['prepare'], 'validate': validate, 'build': base['build'],
     'deploy': release['deploy'], 'verify': verify}[sys.argv[1]]()

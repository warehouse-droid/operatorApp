#!/usr/bin/env python3
"""Deploy the four regular-stock quantity assets over the current live image."""
import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base, scope = release['base'], release['scope']
scope.update(
    OUT=scope['SERVER'] / 'deployments/regular-stock-quantity-20261027',
    FILES=['public/regular-stock-quantity.js', 'public/sales-stock-requests.js',
           'public/sales-stock-requests.html', 'public/stock-requests.css'],
    IMAGE='mbbs-operator-app:regular-stock-quantity-20261027',
    ROLLBACK='mbbs-operator-app:regular-stock-quantity-rollback-20261027')

# These live files were compared with the tested workspace. Their only
# differences are the requested quantity inputs, synchronization and cache keys.
reviewed_live = {
    'public/sales-stock-requests.js': '999f8fae4e1d58e5d01c1ccd5a677c973710f5e139d2277fa344b97254980662',
    'public/sales-stock-requests.html': '8ea0ae1a046f4253827366585007ed43d234adee2f87adbf6c1919c2fb5a0959',
    'public/stock-requests.css': '9f0576ab138b8114e767c5907828364d9c1ee8757b50fbbdd506a74abc785d61'
}


def prepare():
    out = scope['OUT']
    capture = out / 'capture.json'
    if capture.exists():
        previous = json.loads(capture.read_text())
        current = {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
        if previous != current:
            assert not (out / 'deployment.json').exists(), 'Do not overwrite a completed release'
            base['save'](out / ('superseded-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '.json'), previous)
            for name in ['live-before', 'candidate', 'merge-inputs', 'image-context']:
                shutil.rmtree(out / name, ignore_errors=True)
            for name in ['capture.json', 'prepared.json', 'built.json', 'validation.json']:
                (out / name).unlink(missing_ok=True)
    release['prepare']()
    for copy in [out / 'live-before', out / 'candidate']:
        for path in [copy, *copy.rglob('*')]:
            path.chmod(0o755 if path.is_dir() else 0o644)
    for file, expected in reviewed_live.items():
        assert base['sha'](out / 'live-before' / file) == expected, 'Re-review changed live file: ' + file
    for name in globals().get('NEW_FILES', ['public/regular-stock-quantity.js']):
        assert not (out / 'live-before' / name).exists()
    prepared = base['ensure_sources']()
    assert prepared['sourceHashes'] == {name: base['sha'](scope['SERVER'] / name) for name in scope['FILES']}
    before = out / 'live-before'
    candidate = out / 'candidate'
    names = {str(path.relative_to(folder)) for folder in [before, candidate]
             for path in folder.rglob('*') if path.is_file()}
    changed = {name for name in names if not (before / name).exists()
               or base['sha'](before / name) != base['sha'](candidate / name)}
    assert changed == set(scope['FILES']), 'Unexpected candidate changes'
    base['save'](out / 'scope-review.json', {'reviewedLiveHashes': reviewed_live,
        'sourceHashes': prepared['sourceHashes'], 'changedFiles': sorted(changed), 'schemaChanges': False})


def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    assert base['health'](), 'Application health failed'
    checks = []
    for origin in ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']:
        for file, expected in prepared['sourceHashes'].items():
            path = '/sales/stock-requests' if file.endswith('.html') else '/' + Path(file).name
            request = urllib.request.Request(origin + path + '?' + globals().get('CACHE_QUERY', 'salesUom=20261027-v1'),
                headers={'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read()
                actual = hashlib.sha256(body).hexdigest()
                matched = actual == expected
                if file.endswith('.html') and origin.startswith('https:'):
                    # Cloudflare injects its analytics beacon into public HTML.
                    # Compare the full document after removing only that tag.
                    document = re.sub(r'''<script\b[^>]*\bsrc=["']https://static\.cloudflareinsights\.com/beacon\.min\.js[^"']*["'][^>]*></script>''', '', body.decode())
                    normalize = lambda text: re.sub(r'>\s+<', '><', text).strip()
                    matched = normalize(document) == normalize((scope['OUT'] / 'candidate' / file).read_text())
                assert response.status == 200 and matched, origin + path
                checks.append({'url': origin + path, 'status': response.status, 'sha256': actual,
                    'applicationContentMatched': matched})
    base['save'](scope['OUT'] / 'live-verification.json', {
        'sourceHashesVerified': True, 'healthy': True, 'http': checks})
    print(json.dumps({'liveVerification': 'passed', 'files': len(prepared['sourceHashes']), 'httpChecks': len(checks)}))


def validate():
    if not os.environ.get('MBBS_TEST_ARTIFACT_DIR'):
        subprocess.run([sys.executable, str(scope['SERVER'].parent / 'docker/retention/retention.py'),
            'run', '--root', '/tmp', '--', sys.executable, __file__, 'validate'], check=True)
        return
    prepared = base['ensure_sources']()
    artifacts = Path(os.environ['MBBS_TEST_ARTIFACT_DIR'])
    environment = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_NO_DB='1',
        DISPATCH_SOURCE_RUNTIME=str(scope['OUT'] / 'candidate'))
    suites = globals().get('VALIDATION_SUITES', [
        ('conversion-and-browser', ['--test-concurrency=1',
            'test/mbt/unit/regular-stock-quantity.test.js', 'test/mbt/unit/stock-request-domain.test.js',
            'test/mbt/property/stock-request-domain.property.test.js',
            'test/mbt/integration/regular-stock-quantity-browser.test.js'], 26),
        ('composer-regression', ['--test-name-pattern=Sales regular stock request cannot retain',
            'test/mbt/unit/stock-request-ui-contract.test.js'], 1)
    ])
    results = []
    for name, arguments, expected in suites:
        log = artifacts / (name + '.log')
        with log.open('w') as output:
            result = subprocess.run(['bash', 'docker/run-dispatch-source-tests.sh', 'node', '--test', *arguments],
                cwd=scope['SERVER'].parent, env=environment, stdout=output, stderr=subprocess.STDOUT)
        text = log.read_text()
        if result.returncode:
            print(text[-10000:])
        assert result.returncode == 0, name + ' failed'
        counts = {key: int(re.findall(r'^# ' + key + r' (\d+)$', text, re.M)[-1])
                  for key in ['pass', 'fail', 'skipped']}
        assert counts['pass'] == expected and counts['fail'] == 0, counts
        results.append({'suite': name, **counts})
        print(json.dumps(results[-1]), flush=True)
    assert base['ensure_sources']() == prepared
    base['save'](scope['OUT'] / 'validation.json', {
        'passed': True, 'sourceHashes': prepared['sourceHashes'], 'checks': results,
        'isolatedRunner': 'docker/run-dispatch-source-tests.sh', 'cleanupVerified': True})


def deploy():
    active = json.loads(base['db']("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'))"""))
    base['save'](scope['OUT'] / 'active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    base['deploy']()


scope['verify'] = verify
if __name__ == '__main__':
    {'prepare': prepare, 'validate': validate, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

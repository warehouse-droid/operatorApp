#!/usr/bin/env python3
"""Release Stock exchange over the captured live app, with exact-source checks."""
import difflib
import hashlib
import json
import os
import re
from pathlib import Path
import runpy
import shutil
import subprocess
import sys

base = runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope = base['prepare'].__globals__
FILES = [
    'src/stock-exchange-domain.js', 'src/stock-exchange-netsuite.js',
    'src/stock-exchange-proof.js', 'src/stock-exchange-service.js',
    'src/return-repository.js', 'src/operator-netsuite-posting-policy.js',
    'src/mbt/feature-gate-catalog.js', 'src/history-repository.js', 'src/server.js',
    'public/operator.js', 'public/control.js', 'public/sales.js', 'public/i18n.js',
    'migrations/323_stock_exchange.sql',
    'public/operator.html', 'public/control.html', 'public/admin.html', 'public/sales.html'
]
scope.update(OUT=scope['SERVER'] / 'deployments/stock-exchange-20261029', FILES=FILES,
    IMAGE='mbbs-operator-app:stock-exchange-20261029',
    ROLLBACK='mbbs-operator-app:stock-exchange-rollback-20261029')
OUT = scope['OUT']


def capture():
    OUT.mkdir(parents=True, exist_ok=True)
    state = {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
    if (OUT / 'capture.json').exists():
        assert json.loads((OUT / 'capture.json').read_text()) == state, 'Live changed; rebase the release'
        return
    before = OUT / 'live-before'
    before.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        subprocess.run(['sudo', '-n', 'docker', 'cp', base['APP'] + ':/app/' + name, str(before / name)], check=True)
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(before)], check=True)
    for path in [before, *before.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    assert state == {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
    base['save'](OUT / 'capture.json', state)
    print(json.dumps({'captured': True, 'baseImage': state['app']['imageRef'], 'files': len(FILES)}))


def replace_once(text, old, new=''):
    assert text.count(old) == 1, 'Release anchor changed: ' + old[:100]
    return text.replace(old, new, 1)


def repository_candidate(live, updated):
    # These pallet performance edits belong to another pending release.
    updated = replace_once(updated, 'import { resolvePalletItemFromNetSuite } from "./netsuite.js";\n')
    start = updated.index('/** @param {number} customerId */\nasync function customerPalletAuthorizationIds')
    end = updated.index('\nexport async function lookupReturnCustomerPalletBalance', start)
    live_start = live.index('async function customerPalletBalance(')
    live_end = live.index('\nexport async function lookupReturnCustomerPalletBalance', live_start)
    updated = updated[:start] + live[live_start:live_end] + updated[end:]
    start = updated.index('/** Record lookup duration without customer or credential data.')
    end = updated.index('export async function lookupReturnSalesOrder', start)
    updated = updated[:start] + updated[end:]
    updated = replace_once(updated, '  const lookupStartedAt = performance.now();\n')
    return replace_once(updated, '  logReturnOrderLookup(order.tranid, includeStockReturns, lookupStartedAt);\n')


def prepare():
    capture()
    assert not (OUT / 'deployment.json').exists(), 'Release already deployed'
    candidate = OUT / 'candidate'
    shutil.copytree(OUT / 'live-before', candidate, dirs_exist_ok=True)
    patch = []
    for file in FILES:
        previous = OUT / 'live-before' / file
        live = previous.read_text() if previous.exists() else ''
        if file.endswith('.html'):
            script = 'operator' if file == 'public/operator.html' else 'sales' if file == 'public/sales.html' else 'control'
            updated = live
            for asset in [script, 'i18n']:
                updated, count = re.subn(r'(/' + asset + r'\.js(?:\?[^"\n]*)?)(")',
                    lambda match: match[1] + ('&' if '?' in match[1] else '?') + 'stockExchange=20261029' + match[2], updated)
                assert count == 1, file + ': ' + asset
        elif file == 'src/server.js':
            updated = replace_once(live, '    ...mapped,\n    status: requestedStatus === "approved"',
                '    ...mapped,\n    ...(type === "exchange" ? { recordType: "exchange" } : {}),\n    status: requestedStatus === "approved"')
        else:
            updated = (scope['SERVER'] / file).read_text()
            if file == 'src/return-repository.js':
                updated = repository_candidate(live, updated)
        target = candidate / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(updated)
        patch.extend(difflib.unified_diff(live.splitlines(True), updated.splitlines(True),
            fromfile='live/' + file, tofile='candidate/' + file))
    for path in [candidate, *candidate.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    (OUT / 'release.patch').write_text(''.join(patch))
    state = json.loads((OUT / 'capture.json').read_text())
    base['save'](OUT / 'prepared.json', {'baseImage': state['app']['imageRef'], 'conflicts': [],
        'sourceHashes': {file: base['sha'](candidate / file) for file in FILES}})
    print(json.dumps({'prepared': True, 'files': len(FILES), 'unrelatedPalletEditsExcluded': True}))


def validate():
    prepared = base['ensure_sources']()
    env = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_RUNTIME=str(OUT / 'candidate'),
        DISPATCH_SOURCE_MIGRATIONS=str(OUT / 'candidate/migrations'))
    baseline = json.loads((OUT / 'baseline-validation.json').read_text())
    result = subprocess.run(['bash', str(scope['REPO'] / 'docker/run-dispatch-source-tests.sh'),
        'node', 'tools/stock-exchange-checks.mjs', '--return-baseline=' + json.dumps(baseline)],
        cwd=scope['REPO'], env=env, capture_output=True, text=True)
    print(result.stdout)
    if result.returncode:
        print(result.stderr)
    assert result.returncode == 0, 'Candidate validation failed'
    assert base['ensure_sources']() == prepared
    summary = next(json.loads(line) for line in result.stdout.splitlines()
        if line.startswith('{"node":') and 'sourceHash' in line)
    base['save'](OUT / 'validation.json', {'passed': True, 'sourceHashes': prepared['sourceHashes'], 'summary': summary})


def baseline():
    capture()
    file = 'test/mbt/integration/return-pallet-saved-search.test.js'
    env = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_RUNTIME=str(OUT / 'live-before'),
        DISPATCH_SOURCE_MIGRATIONS=str(OUT / 'live-before/migrations'))
    result = subprocess.run(['bash', str(scope['REPO'] / 'docker/run-dispatch-source-tests.sh'),
        'node', '--test', '--test-concurrency=1', file], cwd=scope['REPO'], env=env, capture_output=True, text=True)
    print(result.stdout)
    failures = re.findall(r'^not ok \d+ - (.+)$', result.stdout, re.MULTILINE)
    expected = ['P1 linked credits start while the fresh report is pending, preserving the final reservation',
        'O2 successful SO searches record reference, mode and elapsed time only']
    assert result.returncode == 1 and sorted(failures) == sorted(expected), result.stderr[-3000:]
    base['save'](OUT / 'baseline-validation.json', {'testFile': file,
        'testHash': hashlib.sha256((scope['SERVER'] / file).read_bytes()).hexdigest(),
        'failedTests': failures, 'reason': 'Pending pallet performance behavior is absent from the live app and this exchange-only release.'})


def apply_migration():
    name = '323_stock_exchange.sql'
    if base['db']("SELECT filename FROM schema_migrations WHERE filename='" + name + "';"):
        return {'filename': name, 'alreadyApplied': True}
    migration = OUT / 'candidate/migrations' / name
    base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n" + migration.read_text()
        + "\nINSERT INTO schema_migrations(filename) VALUES ('" + name + "'); COMMIT;")
    return {'filename': name, 'applied': True, 'sha256': base['sha'](migration)}


def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    http = []
    for route, expected in [('/health', 200), ('/operator', 200), ('/control.html', 200), ('/sales.html', 200),
        ('/admin/return-automation', 200), ('/operator.js?stockExchange=20261029', 200),
        ('/api/returns/operator/history?type=exchange', 401)]:
        status = int(subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}',
            'http://127.0.0.1:3000' + route], text=True))
        assert status == expected, (route, status)
        http.append({'path': route, 'status': status})
    assert base['db']("SELECT to_regclass('public.return_exchange_months') IS NOT NULL AND to_regclass('public.return_exchange_postings') IS NOT NULL;") == 't'
    gates = json.loads(base['db']("SELECT json_agg(f ORDER BY flag_key) FROM (SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_stock_exchange_it_%') f;"))
    assert {row['flag_key'] for row in gates} == {f'operator_netsuite_stock_exchange_it_{yard}' for yard in ['3445', '2967', '150']}
    base['save'](OUT / 'live-verification.json', {'sourceHashesVerified': True, 'http': http, 'exchangeGates': gates})
    print(json.dumps({'verifiedFiles': len(FILES), 'healthy': True, 'exchangeGates': gates}))


def deploy():
    active = base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');")
    assert active == '0', 'Wait for active operations: ' + active
    base['deploy']()


scope['apply_migration'], scope['verify'] = apply_migration, verify
if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'baseline': baseline, 'validate': validate, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

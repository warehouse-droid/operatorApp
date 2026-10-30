#!/usr/bin/env python3
"""Release the operator-return source delta over a captured, current live image."""
import json
import runpy
import subprocess
import sys
import re
import difflib
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base, scope = release['base'], release['scope']
scope.update(OUT=scope['SERVER'] / 'deployments/return-enhancements-20261028',
    FILES=json.loads((scope['SERVER'] / 'tools/return-enhancements-files.json').read_text()),
    IMAGE='mbbs-operator-app:return-enhancements-20261028',
    ROLLBACK='mbbs-operator-app:return-enhancements-rollback-20261028')

def prepare():
    release['prepare']()
    # Asset cache versions are independently edited by other releases. Keep the
    # captured live page and update only this feature's four assets.
    html = (scope['OUT'] / 'live-before/public/operator.html').read_text()
    for asset in ['operator.js', 'operator.css', 'return-notifications.js', 'operator-display-settings.js']:
        html, count = re.subn('/' + re.escape(asset) + r'\?v=[^" ]*',
            '/' + asset + '?v=20261028-return-enhancements', html)
        assert count == 1, asset
    (scope['OUT'] / 'candidate/public/operator.html').write_text(html)
    prepared = json.loads((scope['OUT'] / 'prepared.json').read_text())
    prepared['conflicts'] = [file for file in prepared['conflicts'] if file != 'public/operator.html']
    prepared['sourceHashes']['public/operator.html'] = base['sha'](scope['OUT'] / 'candidate/public/operator.html')
    base['save'](scope['OUT'] / 'prepared.json', prepared)
    patch = []
    for file in scope['FILES']:
        before = scope['OUT'] / 'live-before' / file
        old = before.read_text() if before.exists() else ''
        patch.extend(difflib.unified_diff(old.splitlines(True), (scope['OUT'] / 'candidate' / file).read_text().splitlines(True),
            fromfile='live/' + file, tofile='candidate/' + file))
    (scope['OUT'] / 'release.patch').write_text(''.join(patch))
    for directory in ['live-before', 'candidate']:
        root = scope['OUT'] / directory
        for path in [root, *root.rglob('*')]:
            if path.is_dir():
                path.chmod(0o755)
            elif path.is_file():
                path.chmod(0o644)
    print(json.dumps({'prepared': True, 'conflicts': prepared['conflicts'], 'files': len(scope['FILES'])}))

def apply_migration():
    name = '319_return_automatic_notifications.sql'
    if base['db']("SELECT filename FROM schema_migrations WHERE filename='" + name + "';"):
        return {'filename': name, 'alreadyApplied': True}
    migration = scope['OUT'] / 'candidate/migrations' / name
    base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n" + migration.read_text()
        + "\nINSERT INTO schema_migrations(filename) VALUES ('" + name + "'); COMMIT;")
    return {'filename': name, 'applied': True, 'sha256': base['sha'](migration)}

def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    results = []
    for route, expected in [('/health', 200), ('/operator', 200), ('/operator.js', 200),
        ('/return-notifications.js', 200), ('/api/admin/return-notifications', 401)]:
        actual = int(subprocess.check_output(['curl', '-sS', '--max-time', '10', '-o', '/dev/null',
            '-w', '%{http_code}', 'http://127.0.0.1:3000' + route], text=True))
        assert actual == expected, (route, actual)
        results.append({'path': route, 'status': actual})
    assert base['db']("SELECT to_regclass('public.return_automatic_notifications');") == 'return_automatic_notifications'
    base['save'](scope['OUT'] / 'live-verification.json', {'sourceHashesVerified': True, 'http': results})
    print(json.dumps({'liveVerification': 'passed', 'files': len(prepared['sourceHashes'])}))

def deploy():
    active = base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))"
        "+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))"
        "+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')"
        "+(SELECT count(*) FROM return_batch_authorizations WHERE attempted_at IS NOT NULL AND sync_status IN ('pending','posting'));")
    assert active == '0', 'Wait for active operations: ' + active
    base['deploy']()

scope['apply_migration'], scope['verify'] = apply_migration, verify
if __name__ == '__main__':
    {'prepare': prepare, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

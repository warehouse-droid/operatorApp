#!/usr/bin/env python3
"""Release only the stock-return card and review layout over the current live app."""
import difflib
import json
import re
import runpy
import shutil
import sys
import time
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base, scope = release['base'], release['scope']
scope.update(OUT=scope['SERVER'] / 'deployments/return-cards-20261028',
    FILES=['public/operator.js', 'public/operator.css', 'public/operator.html', 'public/operator-phone.css'],
    IMAGE='mbbs-operator-app:return-cards-20261028',
    ROLLBACK='mbbs-operator-app:return-cards-rollback-20261028')

def prepare():
    out = scope['OUT']
    capture = out / 'capture.json'
    if capture.exists() and json.loads(capture.read_text()) != {key: base['metadata'](name) for key, name in base['SERVICES'].items()}:
        assert not (out / 'deployment.json').exists(), 'Do not replace a completed release'
        archive = out / ('superseded-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
        archive.mkdir()
        for name in ['live-before', 'candidate', 'merge-inputs', 'image-context', 'capture.json',
                'prepared.json', 'built.json', 'validation.json', 'release.patch', 'build-audit.log',
                'compose.release.json', 'compose.rollback.json']:
            path = out / name
            if path.exists():
                shutil.move(str(path), str(archive / name))
    release['prepare']()
    html = (scope['OUT'] / 'live-before/public/operator.html').read_text()
    for asset in ['operator.js', 'operator.css', 'operator-phone.css']:
        html, count = re.subn('/' + re.escape(asset) + r'\?v=[^" ]*',
            '/' + asset + '?v=20261028-return-cards', html)
        assert count == 1, asset
    (scope['OUT'] / 'candidate/public/operator.html').write_text(html)
    prepared = json.loads((scope['OUT'] / 'prepared.json').read_text())
    prepared['conflicts'] = [file for file in prepared['conflicts'] if file != 'public/operator.html']
    prepared['sourceHashes']['public/operator.html'] = base['sha'](scope['OUT'] / 'candidate/public/operator.html')
    base['save'](scope['OUT'] / 'prepared.json', prepared)
    patch = []
    for file in scope['FILES']:
        old = (scope['OUT'] / 'live-before' / file).read_text()
        new = (scope['OUT'] / 'candidate' / file).read_text()
        patch.extend(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
            fromfile='live/' + file, tofile='candidate/' + file))
    (scope['OUT'] / 'release.patch').write_text(''.join(patch))
    for directory in ['live-before', 'candidate']:
        root = scope['OUT'] / directory
        for path in [root, *root.rglob('*')]:
            path.chmod(0o755 if path.is_dir() else 0o644)
    print(json.dumps({'prepared': True, 'conflicts': prepared['conflicts'], 'files': len(scope['FILES'])}))

def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    assert base['health']()
    base['save'](scope['OUT'] / 'live-verification.json', {'sourceHashesVerified': True, 'healthy': True})
    print(json.dumps({'liveVerification': 'passed', 'files': len(prepared['sourceHashes'])}))

def deploy():
    active = base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))"
        "+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))"
        "+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')"
        "+(SELECT count(*) FROM return_batch_authorizations WHERE attempted_at IS NOT NULL AND sync_status IN ('pending','posting'));")
    assert active == '0', 'Wait for active operations: ' + active
    base['deploy']()

scope['verify'] = verify
if __name__ == '__main__':
    {'prepare': prepare, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

#!/usr/bin/env python3
"""Release return/exchange layout parity over the captured live application."""
import difflib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys

base = runpy.run_path(str(Path(__file__).with_name('bin-selection-release.py')))
scope = base['prepare'].__globals__
FILES = ['public/operator.js', 'public/operator.css', 'public/operator-phone.css',
    'public/operator-display-settings.js', 'public/operator.html', 'public/i18n.js']
scope.update(OUT=scope['SERVER'] / 'deployments/return-exchange-layout-20261029', FILES=FILES,
    IMAGE='mbbs-operator-app:return-exchange-layout-20261029',
    ROLLBACK='mbbs-operator-app:return-exchange-layout-rollback-20261029')
OUT = scope['OUT']


def capture():
    OUT.mkdir(parents=True, exist_ok=True)
    state = {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
    if (OUT / 'capture.json').exists():
        assert json.loads((OUT / 'capture.json').read_text()) == state, 'Live changed; rebase first'
    for file in FILES:
        previous = OUT / 'live-before' / file
        if previous.exists():
            continue
        previous.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['sudo', '-n', 'docker', 'cp', base['APP'] + ':/app/' + file, str(previous)], check=True)
        workspace = OUT / 'workspace-before' / file
        workspace.parent.mkdir(parents=True, exist_ok=True)
        workspace.write_bytes((scope['SERVER'] / file).read_bytes())
    subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(OUT / 'live-before')], check=True)
    for path in (OUT / 'live-before').rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    assert state == {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
    base['save'](OUT / 'capture.json', state)
    print(json.dumps({'captured': True, 'baseImage': state['app']['imageRef'], 'files': len(FILES)}))


def prepare():
    assert not (OUT / 'deployment.json').exists(), 'Already deployed'
    state = json.loads((OUT / 'capture.json').read_text())
    assert state == {key: base['metadata'](name) for key, name in base['SERVICES'].items()}, 'Live changed; rebase first'
    patch, conflicts = [], []
    for file in FILES:
        live = (OUT / 'live-before' / file).read_bytes()
        if file.endswith('.html'):
            updated = live.decode()
            for asset in ['operator.js', 'operator.css', 'operator-phone.css', 'operator-display-settings.js', 'i18n.js']:
                updated, count = re.subn(r'(/' + re.escape(asset) + r'(?:\?[^"\n]*)?)(")',
                    lambda m: m[1] + ('&' if '?' in m[1] else '?') + 'returnExchangeLayout=20261029' + m[2], updated)
                assert count == 1, asset
            updated = updated.encode()
        else:
            updated = base['merge'](live, (OUT / 'workspace-before' / file).read_bytes(),
                (scope['SERVER'] / file).read_bytes(), file, 'layout')
        target = OUT / 'candidate' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(updated)
        if b'<<<<<<< ' in updated:
            conflicts.append(file)
        patch.extend(difflib.unified_diff(live.decode().splitlines(True), updated.decode().splitlines(True),
            fromfile='live/' + file, tofile='candidate/' + file))
    (OUT / 'release.patch').write_text(''.join(patch))
    base['save'](OUT / 'prepared.json', {'baseImage': state['app']['imageRef'], 'conflicts': conflicts,
        'sourceHashes': {file: base['sha'](OUT / 'candidate' / file) for file in FILES}})
    print(json.dumps({'prepared': True, 'files': len(FILES), 'conflicts': conflicts}))


def validate():
    prepared = base['ensure_sources']()
    env = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_NO_DB='1',
        DISPATCH_SOURCE_BASELINE=str(OUT / 'candidate'))
    result = subprocess.run(['bash', str(scope['REPO'] / 'docker/run-dispatch-source-tests.sh'),
        'node', 'tools/return-exchange-layout-checks.mjs', '/baseline-source'],
        cwd=scope['REPO'], env=env, capture_output=True, text=True)
    print(result.stdout)
    if result.returncode:
        print(result.stderr)
    assert result.returncode == 0, 'Exact-source layout validation failed'
    assert base['ensure_sources']() == prepared
    base['save'](OUT / 'validation.json', {'passed': True, 'sourceHashes': prepared['sourceHashes'],
        'browserCases': 54, 'widths': [320,390,768,1024,1365,1440]})


def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    assert base['health']()
    for route in ['/operator', '/operator.css?returnExchangeLayout=20261029', '/operator.js?returnExchangeLayout=20261029']:
        status = subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}',
            'http://127.0.0.1:3000' + route], text=True)
        assert status == '200', (route, status)
    base['save'](OUT / 'live-verification.json', {'sourceHashesVerified': True, 'healthy': True})
    print(json.dumps({'verifiedFiles': len(FILES), 'healthy': True}))


def deploy():
    active = base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');")
    assert active == '0', 'Wait for active operations: ' + active
    base['deploy']()


scope['apply_migration'] = lambda: {'required': False}
scope['verify'] = verify
if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'validate': validate, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

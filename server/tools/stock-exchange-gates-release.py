#!/usr/bin/env python3
"""Publish the missing exchange admin switches over the current live app."""
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
FILES = ['public/mbt-gates.js', 'public/mbt-gates.html']
scope.update(OUT=scope['SERVER'] / 'deployments/stock-exchange-gates-20261029', FILES=FILES,
    IMAGE='mbbs-operator-app:stock-exchange-gates-20261029',
    ROLLBACK='mbbs-operator-app:stock-exchange-gates-rollback-20261029')
OUT = scope['OUT']


def replace_once(text, old, new):
    assert text.count(old) == 1, 'Live anchor changed: ' + old[:100]
    return text.replace(old, new, 1)


def gates():
    return json.loads(base['db']("SELECT json_agg(f ORDER BY flag_key) FROM (SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key LIKE 'operator_netsuite_stock_exchange_it_%') f;"))


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    state = {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
    assert not (OUT / 'deployment.json').exists(), 'Already deployed'
    if (OUT / 'capture.json').exists():
        assert json.loads((OUT / 'capture.json').read_text()) == state, 'Live changed; rebase first'
    else:
        before = OUT / 'live-before/public'
        before.mkdir(parents=True)
        for file in FILES:
            subprocess.run(['sudo', '-n', 'docker', 'cp', base['APP'] + ':/app/' + file,
                str(OUT / 'live-before' / file)], check=True)
        subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(OUT / 'live-before')], check=True)
        for path in (OUT / 'live-before').rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
        assert state == {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
        base['save'](OUT / 'capture.json', state)
        base['save'](OUT / 'gates-before.json', gates())
    patch = []
    for file in FILES:
        live = (OUT / 'live-before' / file).read_text()
        if file.endswith('.html'):
            updated, count = re.subn(r'(/mbt-gates\.js(?:\?[^"\n]*)?)(")',
                lambda match: match[1] + ('&' if '?' in match[1] else '?') + 'stockExchangeControls=20261029' + match[2], live)
            assert count == 1
        else:
            updated = replace_once(live,
                '    { key: "pallet_return", label: "Pallet Return", type: "CM" }',
                '    { key: "pallet_return", label: "Pallet Return", type: "CM" },\n'
                '    { key: "stock_exchange", label: "Stock exchange", type: "IT", yards: ["3445", "2967", "150"] }')
            updated = replace_once(updated,
                '    for (const definition of functions) {\n      row.append(operatorGateCell',
                '    for (const definition of functions) {\n'
                '      if (definition.yards && !definition.yards.includes(yardCode)) {\n'
                '        const cell = document.createElement("td");\n'
                '        cell.className = "mbt-operator-gate-cell";\n'
                '        cell.textContent = "Not available";\n'
                '        row.append(cell);\n'
                '        continue;\n'
                '      }\n'
                '      row.append(operatorGateCell')
            updated = replace_once(updated,
                'Enable both at a yard for combined returns. Existing submissions retain their original transaction type.',
                'Enable both at a yard for combined returns. Enable Stock exchange → IT for monthly exchange Inventory Transfers. Enable posting before confirming new exchanges. Existing submissions retain their original transaction type.')
        target = OUT / 'candidate' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(updated)
        patch.extend(difflib.unified_diff(live.splitlines(True), updated.splitlines(True),
            fromfile='live/' + file, tofile='candidate/' + file))
    (OUT / 'release.patch').write_text(''.join(patch))
    base['save'](OUT / 'prepared.json', {'baseImage': state['app']['imageRef'], 'conflicts': [],
        'sourceHashes': {file: base['sha'](OUT / 'candidate' / file) for file in FILES}})
    print(json.dumps({'prepared': True, 'baseImage': state['app']['imageRef'], 'files': len(FILES)}))


def validate():
    prepared = base['ensure_sources']()
    env = dict(os.environ, DISPATCH_SOURCE_SKIP_BUILD='1', DISPATCH_SOURCE_NO_DB='1',
        DISPATCH_SOURCE_BASELINE=str(OUT / 'candidate'))
    result = subprocess.run(['bash', str(scope['REPO'] / 'docker/run-dispatch-source-tests.sh'),
        'node', 'tools/stock-exchange-gates-checks.mjs', '/baseline-source'],
        cwd=scope['REPO'], env=env, capture_output=True, text=True)
    print(result.stdout)
    if result.returncode:
        print(result.stderr)
    assert result.returncode == 0, 'Exact-source browser validation failed'
    assert base['ensure_sources']() == prepared
    summary = next(json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"passed":'))
    assert summary['sourceHash'] == prepared['sourceHashes']['public/mbt-gates.js']
    base['save'](OUT / 'validation.json', {'passed': True, 'sourceHashes': prepared['sourceHashes'],
        'summary': summary, 'viewports': [390, 1280]})


def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    http = []
    for route in ['/health', '/admin/mbt-gates', '/mbt-gates.js?stockExchangeControls=20261029']:
        status = int(subprocess.check_output(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}',
            'http://127.0.0.1:3000' + route], text=True))
        assert status == 200, (route, status)
        http.append({'path': route, 'status': status})
    current = gates()
    assert current == json.loads((OUT / 'gates-before.json').read_text()), 'Gate values changed during release'
    base['save'](OUT / 'live-verification.json', {'sourceHashesVerified': True, 'http': http,
        'exchangeGatesUnchanged': True, 'exchangeGates': current})
    print(json.dumps({'verifiedFiles': len(FILES), 'healthy': True, 'exchangeGates': current}))


def deploy():
    active = base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');")
    assert active == '0', 'Wait for active operations: ' + active
    base['deploy']()


scope['apply_migration'] = lambda: {'required': False}
scope['verify'] = verify
if __name__ == '__main__':
    {'prepare': prepare, 'validate': validate, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

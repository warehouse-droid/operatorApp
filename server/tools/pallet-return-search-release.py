#!/usr/bin/env python3
"""Release only pallet lookup and customer-result layout changes over live sources."""
import json
import difflib
import runpy
import sys
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base, scope = release['base'], release['scope']
scope.update(
    OUT=scope['SERVER'] / 'deployments/pallet-return-search-20261029',
    FILES=['src/return-repository.js', 'public/operator.css', 'public/operator.html'],
    IMAGE='mbbs-operator-app:pallet-return-search-20261029',
    ROLLBACK='mbbs-operator-app:pallet-return-search-rollback-20261029')


def prepare():
    release['prepare']()
    # Other work may edit this shared workspace during the task. Apply only
    # our lookup changes to the captured live repository, not unrelated edits.
    out = scope['OUT']
    name = 'src/return-repository.js'
    text = (out / 'live-before' / name).read_text()
    updated = (scope['SERVER'] / name).read_text()
    start = updated.index('/** @param {number} customerId */\nasync function customerPalletAuthorizationIds')
    end = updated.index('\nexport async function lookupReturnCustomerPalletBalance', start)
    old_start = text.index('async function customerPalletBalance(')
    old_end = text.index('\nexport async function lookupReturnCustomerPalletBalance', old_start)
    text = text[:old_start] + updated[start:end] + text[old_end:]
    start = updated.index('/** Record lookup duration without customer or credential data.')
    end = updated.index('export async function lookupReturnSalesOrder', start)
    text = text.replace('export async function lookupReturnSalesOrder', updated[start:end] + 'export async function lookupReturnSalesOrder', 1)
    replacements = [
        ('import crypto from "node:crypto";',
         'import crypto from "node:crypto";\nimport { resolvePalletItemFromNetSuite } from "./netsuite.js";'),
        ('  forcePalletBalance = true\n} = {}) {',
         '  forcePalletBalance = true\n} = {}) {\n  const lookupStartedAt = performance.now();'),
        ('    .filter((line) => Number(line.remainingReturnable) > QUANTITY_EPSILON);\n',
         '    .filter((line) => Number(line.remainingReturnable) > QUANTITY_EPSILON);\n'
         '  logReturnOrderLookup(order.tranid, includeStockReturns, lookupStartedAt);\n')]
    for before, after in replacements:
        assert text.count(before) == 1
        text = text.replace(before, after)
    (out / 'candidate' / name).write_text(text)
    prepared = json.loads((out / 'prepared.json').read_text())
    prepared['conflicts'] = [file for file in prepared['conflicts'] if file != name]
    prepared['sourceHashes'][name] = base['sha'](out / 'candidate' / name)
    base['save'](out / 'prepared.json', prepared)
    patch = []
    for file in scope['FILES']:
        patch.extend(difflib.unified_diff((out / 'live-before' / file).read_text().splitlines(True),
            (out / 'candidate' / file).read_text().splitlines(True), fromfile='live/' + file, tofile='candidate/' + file))
    (out / 'release.patch').write_text(''.join(patch))
    assert not prepared['conflicts'], prepared['conflicts']
    print(json.dumps({'prepared': True, 'files': len(scope['FILES']), 'conflicts': []}))


def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    assert base['health']()
    base['save'](scope['OUT'] / 'live-verification.json', {'sourceHashesVerified': True, 'healthy': True})
    print(json.dumps({'verifiedFiles': len(prepared['sourceHashes']), 'healthy': True}))


def rebase():
    """Replay the validated patch over the latest live app, preserving other releases."""
    out = scope['OUT']
    assert not (out / 'deployment.json').exists(), 'This release is already deployed'
    previous = base['ensure_sources']()
    state = {key: base['metadata'](name) for key, name in base['SERVICES'].items()}
    old_state = json.loads((out / 'capture.json').read_text())
    assert state != old_state, 'The captured live version is still current'
    patch = (out / 'release.patch').read_text()
    # The stylesheet cache key may have changed in the intervening release.
    # Replay the source/CSS hunks exactly and update only that key in live HTML.
    code_patch = patch.split('--- live/public/operator.html\n')[0]
    # New releases can prepend imports; retain those and insert our one import
    # explicitly instead of relying on the original start-of-file hunk.
    code_patch, import_hunks = re.subn(r'^@@ -1,5 \+1,6 @@\n.*?(?=^@@)', '', code_patch,
                                     count=1, flags=re.MULTILINE | re.DOTALL)
    assert import_hunks == 1
    stage = out / ('rebase-stage-' + str(time.time_ns()))
    stage.mkdir()
    try:
        before = stage / 'live-before'
        before.mkdir()
        for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            subprocess.run(['sudo', '-n', 'docker', 'cp', base['APP'] + ':/app/' + name,
                            str(before / name)], check=True)
        subprocess.run(['sudo', '-n', 'chown', '-R', f'{os.getuid()}:{os.getgid()}', str(before)], check=True)
        assert state == {key: base['metadata'](name) for key, name in base['SERVICES'].items()}, 'Live changed during capture'
        candidate = stage / 'candidate'
        shutil.copytree(before, candidate)
        args = ['patch', '--batch', '--forward', '--fuzz=0', '-p1']
        subprocess.run(args + ['--dry-run'], cwd=candidate, input=code_patch, text=True, check=True)
        subprocess.run(args, cwd=candidate, input=code_patch, text=True, check=True)
        repository = candidate / 'src/return-repository.js'
        content = repository.read_text()
        anchor = 'import crypto from "node:crypto";'
        assert content.count(anchor) == 1 and 'import { resolvePalletItemFromNetSuite }' not in content
        repository.write_text(content.replace(anchor, anchor + '\nimport { resolvePalletItemFromNetSuite } from "./netsuite.js";'))
        for backup in candidate.rglob('*.orig'):
            assert not (before / backup.relative_to(candidate)).exists()
            backup.unlink()
        html = candidate / 'public/operator.html'
        content, count = re.subn(r'/operator\.css\?v=[^"\s]+',
                                '/operator.css?v=20261029-pallet-search', html.read_text())
        assert count == 1
        html.write_text(content)
        archived = {'prepared': previous, 'capture': old_state, 'patch': patch}
        for name in ['validation', 'built']:
            if (out / (name + '.json')).exists():
                archived[name] = json.loads((out / (name + '.json')).read_text())
        base['save'](out / ('superseded-' + str(time.time_ns()) + '.json'), archived)
        for name in ['live-before', 'candidate', 'image-context', 'merge-inputs']:
            if (out / name).exists():
                shutil.rmtree(out / name)
        shutil.move(str(before), str(out / 'live-before'))
        shutil.move(str(candidate), str(out / 'candidate'))
        for name in ['validation.json', 'built.json', 'compose.release.json', 'compose.rollback.json']:
            (out / name).unlink(missing_ok=True)
        base['save'](out / 'capture.json', state)
        base['save'](out / 'prepared.json', {'baseImage': state['app']['imageRef'], 'conflicts': [],
                     'sourceHashes': {file: base['sha'](out / 'candidate' / file) for file in scope['FILES']}})
        rebased_patch = []
        for file in scope['FILES']:
            rebased_patch.extend(difflib.unified_diff((out / 'live-before' / file).read_text().splitlines(True),
                (out / 'candidate' / file).read_text().splitlines(True), fromfile='live/' + file, tofile='candidate/' + file))
        (out / 'release.patch').write_text(''.join(rebased_patch))
        print(json.dumps({'rebasedOn': state['app']['imageRef'], 'files': len(scope['FILES'])}))
    finally:
        shutil.rmtree(stage)


def deploy():
    active = base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');")
    assert active == '0', 'Wait for active operations: ' + active
    base['deploy']()


scope['verify'] = verify
if __name__ == '__main__':
    {'prepare': prepare, 'rebase': rebase, 'build': base['build'], 'deploy': deploy, 'verify': verify}[sys.argv[1]]()

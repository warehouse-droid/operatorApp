#!/usr/bin/env python3
"""Apply only the regular-stock Add item delta to the captured live application."""
import json
import runpy
import shutil
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope, base = release['scope'], release['base']
scope.update(OUT=scope['SERVER'] / 'deployments/regular-stock-add-items-20261027',
    FILES=json.loads((scope['SERVER'] / 'tools/regular-stock-add-items-files.json').read_text()),
    IMAGE='mbbs-operator-app:regular-stock-add-items-20261027',
    ROLLBACK='mbbs-operator-app:regular-stock-add-items-rollback-20261027')

def capture_workspace():
    for file in scope['FILES']:
        source = scope['SERVER'] / file
        target = scope['OUT'] / 'workspace-before' / file
        if source.exists():
            assert not target.exists(), 'Workspace baseline already exists'
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

def verify():
    prepared = base['ensure_sources']()
    for file, expected in prepared['sourceHashes'].items():
        assert base['docker']('exec', base['APP'], 'sha256sum', '/app/' + file).split()[0] == expected, file
    assert base['health'](), 'Production health failed'
    print(json.dumps({'sourceHashesVerified': len(prepared['sourceHashes']), 'healthy': True}))

scope['verify'] = verify
if __name__ == '__main__':
    {'capture-workspace': capture_workspace, 'prepare': release['prepare'],
     'build': base['build'], 'deploy': base['deploy'], 'verify': verify}[sys.argv[1]]()

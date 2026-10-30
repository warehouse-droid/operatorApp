#!/usr/bin/env python3
"""Release the saved Sales internal note in Backorder progress."""
import runpy
import sys
from pathlib import Path

checks = runpy.run_path(str(Path(__file__).with_name('backorder-supply-status-release.py')))
base, scope, release = checks['base'], checks['scope'], checks['release']
scope.update(
    OUT=scope['SERVER'] / 'deployments/backorder-sales-note-20261028',
    FILES=['public/backorder-stock-requests.js', 'public/sales-stock-requests.js',
           'public/sales-stock-requests.html'],
    IMAGE='mbbs-operator-app:backorder-sales-note-20261028',
    ROLLBACK='mbbs-operator-app:backorder-sales-note-rollback-20261028')
release['prepare'].__globals__.update(
    NEW_FILES=[], CACHE_QUERY='salesNote=20261028-v1',
    reviewed_live={name: base['sha'](scope['OUT'] / 'workspace-before' / name)
                   for name in scope['FILES']})
# Reuse the existing Backorder browser/workflow checks with this release's
# candidate and retention wrapper. Verify the Sales HTML and public assets.
checks['validate'].__globals__['__file__'] = __file__
scope['verify'] = release['verify']

if __name__ == '__main__':
    {'prepare': release['prepare'], 'validate': checks['validate'], 'build': base['build'],
     'deploy': release['deploy'], 'verify': release['verify']}[sys.argv[1]]()

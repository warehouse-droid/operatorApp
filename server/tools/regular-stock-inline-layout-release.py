#!/usr/bin/env python3
"""Release inline item quantities and Sales order previews over the live app."""
import runpy
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('regular-stock-quantity-release.py')))
base, scope = release['base'], release['scope']
scope.update(
    OUT=scope['SERVER'] / 'deployments/regular-stock-inline-layout-20261027',
    FILES=['public/sales-stock-requests.js', 'public/sales-stock-requests.html', 'public/stock-requests.css',
           'public/backorder-stock-requests.js', 'public/special-stock-case-status.js',
           'public/sales-special-stock-requests.js', 'public/special-stock-documents.css'],
    IMAGE='mbbs-operator-app:regular-stock-inline-layout-20261027',
    ROLLBACK='mbbs-operator-app:regular-stock-inline-layout-rollback-20261027')
release['prepare'].__globals__.update(
    __file__=__file__, NEW_FILES=[], CACHE_QUERY='inlineLayout=20261027-v1',
    reviewed_live={name: base['sha'](scope['OUT'] / 'workspace-before' / name) for name in scope['FILES']},
    VALIDATION_SUITES=[
        ('layout-and-conversion', ['--test-concurrency=1',
            'test/mbt/integration/regular-stock-quantity-browser.test.js',
            'test/mbt/unit/regular-stock-quantity.test.js'], 9),
        ('composer-regression', ['--test-name-pattern=Sales regular stock request cannot retain',
            'test/mbt/unit/stock-request-ui-contract.test.js'], 1)
    ])

if __name__ == '__main__':
    {'prepare': release['prepare'], 'validate': release['validate'], 'build': base['build'],
     'deploy': release['deploy'], 'verify': release['verify']}[sys.argv[1]]()

#!/usr/bin/env python3
"""Scoped Front Desk current-action rates and responsiveness release."""
import json
import runpy
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope, base = release['scope'], release['base']
scope.update(
    OUT=scope['SERVER'] / 'deployments/frontdesk-current-actions-20261026',
    FILES=json.loads((scope['SERVER'] / 'tools/frontdesk-current-actions-files.json').read_text()),
    IMAGE='mbbs-operator-app:frontdesk-current-actions-20261026',
    ROLLBACK='mbbs-operator-app:frontdesk-current-actions-rollback-20261026')

if __name__ == '__main__':
    {'prepare': release['prepare'], **{name: base[name] for name in ['build', 'deploy', 'verify']}}[sys.argv[1]]()

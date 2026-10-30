#!/usr/bin/env python3
"""Scoped MBT planning and draft quote release over the captured live app."""
import json
import runpy
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope, base = release['scope'], release['base']
scope.update(
    OUT=scope['SERVER'] / 'deployments/mbt-planning-repairs-20261026',
    FILES=json.loads((scope['SERVER'] / 'tools/mbt-planning-repairs-files.json').read_text()),
    IMAGE='mbbs-operator-app:mbt-planning-repairs-20261026',
    ROLLBACK='mbbs-operator-app:mbt-planning-repairs-rollback-20261026')

if __name__ == '__main__':
    {'prepare': release['prepare'], **{name: base[name] for name in ['build', 'deploy', 'verify']}}[sys.argv[1]]()

#!/usr/bin/env python3
"""Restore the pallet selector footer while preserving the compact return layout."""
import difflib
import json
from pathlib import Path
import re
import runpy
import sys

release = runpy.run_path(str(Path(__file__).with_name('return-exchange-layout-release.py')))
base, scope = release['base'], release['scope']
out = scope['SERVER'] / 'deployments/return-pallet-bottom-20261029'
scope.update(OUT=out, IMAGE='mbbs-operator-app:return-pallet-bottom-20261029',
    ROLLBACK='mbbs-operator-app:return-pallet-bottom-rollback-20261029')
release['capture'].__globals__['OUT'] = out


def prepare():
    release['prepare']()
    html = (out / 'live-before/public/operator.html').read_text()
    for asset in ['operator.js', 'operator.css']:
        html, count = re.subn(r'(/' + re.escape(asset) + r'(?:\?[^"\n]*)?)(")',
            lambda match: match[1] + ('&' if '?' in match[1] else '?') + 'palletBottom=20261029' + match[2], html)
        assert count == 1, asset
    (out / 'candidate/public/operator.html').write_text(html)
    prepared = json.loads((out / 'prepared.json').read_text())
    prepared['sourceHashes']['public/operator.html'] = base['sha'](out / 'candidate/public/operator.html')
    base['save'](out / 'prepared.json', prepared)
    patch = []
    for file in scope['FILES']:
        patch.extend(difflib.unified_diff((out / 'live-before' / file).read_text().splitlines(True),
            (out / 'candidate' / file).read_text().splitlines(True), fromfile='live/' + file, tofile='candidate/' + file))
    (out / 'release.patch').write_text(''.join(patch))


if __name__ == '__main__':
    {'capture': release['capture'], 'prepare': prepare, 'validate': release['validate'],
        'build': base['build'], 'deploy': release['deploy'], 'verify': release['verify']}[sys.argv[1]]()

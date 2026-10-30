#!/usr/bin/env python3
"""Release only the MBT order-pool layout and stylesheet cache key."""
import json, runpy, sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope = release['scope']
scope.update(
    OUT=scope['SERVER']/'deployments/bin-card-layout-20261023',
    FILES=json.loads((scope['SERVER']/'tools/bin-card-layout-files.json').read_text()),
    IMAGE='mbbs-operator-app:bin-card-layout-20261023',
    ROLLBACK='mbbs-operator-app:bin-card-layout-rollback-20261023',
)
if __name__ == '__main__':
    {'prepare': release['prepare'], **{name: release['base'][name] for name in ['build', 'deploy', 'verify']}}[sys.argv[1]]()

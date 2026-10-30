#!/usr/bin/env python3
"""Narrow advisory truck-weight release."""
import runpy,json,sys
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope=release['scope'];base=release['base']
scope.update(OUT=scope['SERVER']/'deployments/bin-weight-warning-20261024',
    FILES=json.loads((scope['SERVER']/'tools/bin-weight-warning-files.json').read_text()),
    IMAGE='mbbs-operator-app:bin-weight-warning-20261024',ROLLBACK='mbbs-operator-app:bin-weight-warning-rollback-20261024')
if __name__=='__main__':
    {'prepare':release['prepare'],'build':base['build'],'deploy':base['deploy'],'verify':base['verify']}[sys.argv[1]]()

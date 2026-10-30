#!/usr/bin/env python3
"""Narrow transport validation-message and weight-preview release."""
import runpy,json,sys
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope=release['scope'];base=release['base']
scope.update(OUT=scope['SERVER']/'deployments/transport-errors-20261024',
    FILES=json.loads((scope['SERVER']/'tools/transport-errors-files.json').read_text()),
    IMAGE='mbbs-operator-app:transport-errors-20261024',ROLLBACK='mbbs-operator-app:transport-errors-rollback-20261024')
if __name__=='__main__':
    {'prepare':release['prepare'],'build':base['build'],'deploy':base['deploy'],'verify':base['verify']}[sys.argv[1]]()

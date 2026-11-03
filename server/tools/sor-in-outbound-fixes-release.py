#!/usr/bin/env python3
"""Follow-up to sor-in-outbound-20261103: SOR deliveries at the NetSuite "Rental" location ship from
the 3445 rental yard (yard filters and yard scopes), and driver-only SORs show their ordered lines
(labelled, and item-searchable). Applied over the live first release; no migration.

Steps: prepare -> validate -> build -> deploy (verifies; rolls the app back on failure) -> verify.
"""
import runpy,sys
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('sor-in-outbound-release.py')))
scope=release['prepare'].__globals__
SERVER=scope['SERVER']
OUT=SERVER/'deployments/sor-in-outbound-fixes-20261103'
# validate() relaunches itself under the retention runner by script path.
scope['__file__']=str(Path(__file__).resolve())
scope.update(OUT=OUT,PREVIOUS=SERVER/'deployments/sor-in-outbound-20261103',
  PREVIOUS_TAG='sorRecords=20261103',TAG='sorRecords=20261103-2',
  MODULE_MARKERS=('quantity_basis',),
  I18N_ANCHOR='    "yard.sorReturn": "SOR 租赁退还",\n',
  I18N_LINES='    "yard.orderedQuantity": "订单数量 · 无堆场装车",\n')
scope['scope'].update(OUT=OUT,IMAGE='mbbs-operator-app:sor-in-outbound-fixes-20261103',
  ROLLBACK='mbbs-operator-app:sor-in-outbound-fixes-rollback-20261103')

if __name__=='__main__':
    {'prepare':scope['prepare'],'validate':scope['validate'],'build':scope['base']['build'],
     'deploy':scope['deploy'],'verify':scope['verify']}[sys.argv[1]]()

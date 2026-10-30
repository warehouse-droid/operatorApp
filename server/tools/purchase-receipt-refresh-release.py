#!/usr/bin/env python3
"""Scoped receipt refresh release; merge only this task's workspace delta."""
import json
import runpy
import sys
from pathlib import Path

release = runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
scope, base = release['scope'], release['base']
scope.update(
    OUT=scope['SERVER'] / 'deployments/backorder-po-receipts-20261027',
    FILES=json.loads((scope['SERVER'] / 'tools/purchase-receipt-refresh-files.json').read_text()),
    IMAGE='mbbs-operator-app:purchase-receipt-refresh-20261027',
    ROLLBACK='mbbs-operator-app:purchase-receipt-refresh-rollback-20261027')

def migrate():
    name='312_purchase_receipt_refresh.sql'
    if base['db']("SELECT filename FROM schema_migrations WHERE filename='"+name+"';"):
        return {'filename':name,'alreadyApplied':True}
    path=scope['OUT']/'candidate/migrations'/name
    base['db']("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';\n"+path.read_text()+
        "\nINSERT INTO schema_migrations(filename) VALUES ('"+name+"'); COMMIT;")
    return {'filename':name,'applied':True,'sha256':base['sha'](path)}

scope['apply_migration']=migrate
if __name__=='__main__':
    {'prepare':release['prepare'],**{name:base[name] for name in ['build','deploy','verify']}}[sys.argv[1]]()

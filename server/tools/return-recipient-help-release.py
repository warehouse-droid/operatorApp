#!/usr/bin/env python3
"""Release the recipient help text over the current app without changing settings."""
import json
import runpy
import sys
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
scope.update(OUT=scope['SERVER']/'deployments/return-recipient-help-20261026',
    FILES=json.loads((scope['SERVER']/'tools/return-recipient-help-files.json').read_text()),
    IMAGE='mbbs-operator-app:return-recipient-help-20261026',ROLLBACK='mbbs-operator-app:return-recipient-help-rollback-20261026')

def prepare():
    release['prepare']()
    out=scope['OUT']
    for copy in [out/'live-before',out/'candidate']:
        for path in [copy,*copy.rglob('*')]: path.chmod(0o755 if path.is_dir() else 0o644)
    name='public/operator.html';html=(out/'live-before'/name).read_text()
    assert html.count('/return-notifications.js?v=20261026-v1')==1
    (out/'candidate'/name).write_text(html.replace('/return-notifications.js?v=20261026-v1','/return-notifications.js?v=20261026-v2'))
    prepared=json.loads((out/'prepared.json').read_text());prepared['conflicts']=[f for f in prepared['conflicts'] if f!=name]
    prepared['sourceHashes'][name]=base['sha'](out/'candidate'/name);base['save'](out/'prepared.json',prepared)
    print(json.dumps({'prepared':True,'conflicts':prepared['conflicts']}))

def verify():
    prepared=base['ensure_sources']()
    for file,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',base['APP'],'sha256sum','/app/'+file).split()[0]==expected,file
    assert base['health']()
    base['save'](scope['OUT']/'live-verification.json',{'sourceHashesVerified':True,'healthy':True})
    print(json.dumps({'liveVerification':'passed','files':len(prepared['sourceHashes'])}))

def deploy():
    active=base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');")
    assert active=='0','Wait for active operations: '+active
    base['deploy']()

scope['verify']=verify
if __name__=='__main__': {'prepare':prepare,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()

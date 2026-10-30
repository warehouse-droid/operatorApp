#!/usr/bin/env python3
"""Release three-step pallet return flow over the captured running app."""
import json
import re
import runpy
import shutil
import sys
import time
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
scope.update(OUT=scope['SERVER']/'deployments/pallet-three-step-20261026',
    FILES=json.loads((scope['SERVER']/'tools/pallet-three-step-files.json').read_text()),
    IMAGE='mbbs-operator-app:pallet-three-step-20261026',ROLLBACK='mbbs-operator-app:pallet-three-step-rollback-20261026')

def prepare():
    out=scope['OUT'];capture=out/'capture.json'
    if capture.exists() and json.loads(capture.read_text()) != {k:base['metadata'](v) for k,v in base['SERVICES'].items()}:
        assert not (out/'deployment.json').exists(),'Do not overwrite a completed release'
        base['save'](out/('superseded-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'.json'),json.loads(capture.read_text()))
        for name in ['live-before','candidate','merge-inputs','image-context']: shutil.rmtree(out/name,ignore_errors=True)
        for name in ['capture.json','prepared.json','built.json','validation.json']: (out/name).unlink(missing_ok=True)
    release['prepare']()
    for copy in [out/'live-before',out/'candidate']:
        for path in [copy,*copy.rglob('*')]: path.chmod(0o755 if path.is_dir() else 0o644)
    name='public/operator.html';html=(out/'live-before'/name).read_text()
    html,count=re.subn(r'(/operator\.(?:js|css)\?[^"\n]+)(")',r'\1&palletSteps=20261026\2',html);assert count==2
    (out/'candidate'/name).write_text(html)
    prepared=json.loads((out/'prepared.json').read_text());prepared['conflicts']=[f for f in prepared['conflicts'] if f!=name]
    prepared['sourceHashes'][name]=base['sha'](out/'candidate'/name);base['save'](out/'prepared.json',prepared)
    import difflib
    patch=[]
    for name in scope['FILES']:
        patch.extend(difflib.unified_diff((out/'live-before'/name).read_text().splitlines(True), (out/'candidate'/name).read_text().splitlines(True),fromfile='live/'+name,tofile='candidate/'+name))
    (out/'release.patch').write_text(''.join(patch))
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

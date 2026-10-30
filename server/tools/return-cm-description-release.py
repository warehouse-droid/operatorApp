#!/usr/bin/env python3
"""Release NetSuite default CM descriptions and verified manual price adjustments."""
import json, runpy, sys, time, shutil
from pathlib import Path
release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
scope.update(OUT=scope['SERVER']/'deployments/return-cm-description-20261028',
 FILES=json.loads((scope['SERVER']/'tools/return-cm-description-files.json').read_text()),
 IMAGE='mbbs-operator-app:return-cm-description-20261028',ROLLBACK='mbbs-operator-app:return-cm-description-rollback-20261028')
def prepare():
 out=scope['OUT'];capture=out/'capture.json'
 if capture.exists() and json.loads(capture.read_text())!={k:base['metadata'](v) for k,v in base['SERVICES'].items()}:
  assert not (out/'deployment.json').exists()
  archive=out/('superseded-'+time.strftime('%Y%m%dT%H%M%SZ',time.gmtime()));archive.mkdir()
  for name in ['live-before','candidate','merge-inputs','image-context','capture.json','prepared.json','built.json','validation.json','release.patch','build-audit.log','compose.release.json','compose.rollback.json']:
   if (out/name).exists():shutil.move(str(out/name),str(archive/name))
 release['prepare']()
 for directory in ['live-before','candidate']:
  root=out/directory
  for path in [root,*root.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
def verify():
 prepared=base['ensure_sources']()
 for file,digest in prepared['sourceHashes'].items():
  assert base['docker']('exec',base['APP'],'sha256sum','/app/'+file).split()[0]==digest,file
 assert base['health']()
 base['save'](scope['OUT']/'live-verification.json',{'sourceHashesVerified':True,'healthy':True})
 print(json.dumps({'liveVerification':'passed','files':len(prepared['sourceHashes'])}))
def deploy():
 active=base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing')+(SELECT count(*) FROM return_batch_authorizations WHERE attempted_at IS NOT NULL AND sync_status IN ('pending','posting'));")
 assert active=='0','Wait for active operations: '+active
 base['deploy']()
scope['verify']=verify
if __name__=='__main__':{'prepare':prepare,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()

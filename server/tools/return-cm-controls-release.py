#!/usr/bin/env python3
"""Release only CM gate controls and retire the live RA fallback switches."""
import json
import re
import runpy
import shutil
import subprocess
import sys
import time
from pathlib import Path

release=runpy.run_path(str(Path(__file__).with_name('bin-final-collection-release.py')))
base,scope=release['base'],release['scope']
scope.update(OUT=scope['SERVER']/'deployments/return-cm-controls-20261026',
    FILES=json.loads((scope['SERVER']/'tools/return-cm-controls-files.json').read_text()),
    IMAGE='mbbs-operator-app:return-cm-controls-20261026',ROLLBACK='mbbs-operator-app:return-cm-controls-rollback-20261026')

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
    prepared=json.loads((out/'prepared.json').read_text())
    for name,asset in [('public/mbt-gates.html','mbt-gates'),('public/admin.html','control')]:
        html=(out/'live-before'/name).read_text()
        html,count=re.subn(r'(/'+asset+r'\.js\?[^"\n]+)(")',r'\1&returnCmOnly=1\2',html)
        assert count==1
        (out/'candidate'/name).write_text(html)
        prepared['conflicts']=[f for f in prepared['conflicts'] if f!=name]
        prepared['sourceHashes'][name]=base['sha'](out/'candidate'/name)
    base['save'](out/'prepared.json',prepared)
    print(json.dumps({'prepared':True,'conflicts':prepared['conflicts']}))

def retire_ra_gates():
    script="""import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from '/app/src/db.js';
import {updateMbtFeatureFlagState} from '/app/src/mbt/feature-flag-repository.js';
try {
 const changes=await withTransaction(async()=>{
  const before=(await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key ~ '^operator_netsuite_(stock|pallet)_return_(ra|cm)_(3445|2967|12441|150)$' ORDER BY flag_key FOR UPDATE")).rows;
  const ra=before.filter(r=>r.flag_key.includes('_ra_'));assert.equal(ra.length,8);
  const cm=before.filter(r=>r.flag_key.includes('_cm_'));assert.equal(cm.length,8);
  const changes=[];
  for(const row of ra){
   if(!row.enabled)continue;
   const id='return-cm-controls-20261026:'+row.flag_key;
   const result=await updateMbtFeatureFlagState({actor:{operatorId:'system:return-cm-controls-20261026',roles:['admin'],actorType:'system'},flagKey:row.flag_key,
    enabled:false,expectedRevision:Number(row.revision),reason:'User requested CM-only return settings and removal of RA options; retire hidden RA fallback.',idempotencyKey:id,correlationId:'return-cm-controls-20261026',requestId:id});
   changes.push({before:row,after:result.body.flag});
  }
  const after=(await query("SELECT flag_key,enabled,revision FROM mbt_feature_flags WHERE flag_key ~ '^operator_netsuite_(stock|pallet)_return_cm_(3445|2967|12441|150)$' ORDER BY flag_key")).rows;
  assert.deepEqual(after,cm);
  return changes;
 });
 console.log(JSON.stringify({raGatesDisabled:changes.length,cmGatesPreserved:true,changes}));
}finally{await closeDb();}
"""
    result=base['docker']('exec','-i',base['APP'],'node','--input-type=module',data=script.encode())
    return json.loads(result)

def verify():
    prepared=base['ensure_sources']()
    for file,expected in prepared['sourceHashes'].items():
        assert base['docker']('exec',base['APP'],'sha256sum','/app/'+file).split()[0]==expected,file
    results=[]
    for route,status in [('/health',200),('/mbt-gates.html',200),('/admin/return-automation',200),('/api/admin/return-notifications',401)]:
        actual=int(subprocess.check_output(['curl','-sS','--max-time','10','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:3000'+route],text=True))
        assert actual==status,(route,actual)
        results.append({'path':route,'status':actual})
    assert base['db']("SELECT count(*) FROM mbt_feature_flags WHERE flag_key ~ '^operator_netsuite_(stock|pallet)_return_ra_(3445|2967|12441|150)$' AND enabled;")=='0'
    base['save'](scope['OUT']/'live-verification.json',{'http':results,'sourceHashesVerified':True,'raFallbackDisabled':True})
    print(json.dumps({'liveVerification':'passed','files':len(prepared['sourceHashes'])}))

def deploy():
    active=base['db']("SELECT (SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing'))+(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running'))+(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing');")
    assert active=='0','Wait for active operations: '+active
    base['deploy']()

scope['apply_migration'],scope['verify']=retire_ra_gates,verify
if __name__=='__main__': {'prepare':prepare,'build':base['build'],'deploy':deploy,'verify':verify}[sys.argv[1]]()

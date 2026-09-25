"""Release scoped Operator responsiveness and paused SOR definition repairs."""
import importlib.util
import difflib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release_core',ROOT/'tools/operator-display-settings-deploy.py')
core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
core.RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/operator-responsiveness-20260924-v1')
core.BEFORE=ROOT/'test-artifacts/operator-responsiveness/before'
core.EXISTING=['public/operator.js','public/operator.html','public/service-worker.js','src/sor-rental-service.js','src/dispatch-delivery-group-repository.js']
core.MIGRATION='224_sor_return_definitions.sql'
core.ADDED=['migrations/'+core.MIGRATION];core.FILES=sorted(core.EXISTING+core.ADDED)
core.IMAGE='mbbs-operator-app:operator-responsiveness-20260924-v1'
core.ROLLBACK='mbbs-operator-app:rollback-operator-responsiveness-20260924-v1'
BASE='sha256:2b5096e3733237ccf0b93ae0b3fcc8899667637f6a02e3bf7725326988ef92a0'
VERSION='20260924-operator-responsiveness-v1'
ART=ROOT/'test-artifacts/operator-responsiveness'

def shell_assets(file,text):
 text,n=re.subn(r'/operator\.js\?v=[^"\s]+','/operator.js?v='+VERSION,text);assert n==1
 text,n=re.subn(r'/operator-delivery-refresh\.js\?v=[^"\s]+','/operator-delivery-refresh.js?v='+VERSION,text);assert n==1
 if file.endswith('.js'):
  text,n=re.subn(r'const CACHE_NAME = "[^"]+";', 'const CACHE_NAME = "mbbs-yard-operator-'+VERSION+'";',text);assert n==1
 return text
core.shell_assets=shell_assets

def prepare():
 assert core.metadata(core.APP)['imageId']==BASE
 core.RELEASE.mkdir(parents=True,exist_ok=False)
 state={'app':core.metadata(core.APP),'dependencies':[core.metadata(n) for n in core.DEPENDENCIES]}
 baseline=core.RELEASE/'baseline';baseline.mkdir()
 archive=core.docker('exec',core.APP,'tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json')
 with tarfile.open(fileobj=io.BytesIO(archive)) as captured:captured.extractall(baseline,filter='data')
 candidate=core.RELEASE/'candidate';shutil.copytree(baseline,candidate)
 patch=''
 for file in core.EXISTING:
  if file in ['public/operator.html','public/service-worker.js']:
   old=(baseline/file).read_text();new=shell_assets(file,old)
  else:old=(core.BEFORE/file).read_text();new=(ROOT/file).read_text()
  patch+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
 (core.RELEASE/'release.patch').write_text(patch)
 result=subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,capture_output=True)
 (core.RELEASE/'patch.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stdout
 for file in core.ADDED:shutil.copy2(ROOT/file,candidate/file)
 for path in candidate.rglob('*.orig'):path.unlink()
 before,after=core.files_at(baseline),core.files_at(candidate)
 changed=sorted(f for f in after if after[f]!=before.get(f));assert changed==core.FILES
 state.update({'image':core.IMAGE,'before':{f:before.get(f) for f in core.FILES},'after':{f:after[f] for f in core.FILES},'workspace':{f:core.digest((ROOT/f).read_bytes()) for f in core.FILES},'changedFiles':changed,'unchangedSources':{f:h for f,h in before.items() if f not in core.FILES}})
 for file in core.FILES:
  dest=core.RELEASE/'stage'/file;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(candidate/file,dest)
 (core.RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
 (core.RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+BASE+'\n')
 core.save('manifest.json',state);print(json.dumps({'prepared':True,'changed':changed}))

def validate():
 state=core.manifest();core.current(state)
 results=json.loads((ART/'checks.json').read_text());assert results['passed'];assert results['sourceHashes']==state['after']
 replay=json.loads((ROOT/'test-artifacts/sor-rentals/all-orders-replay.json').read_text());assert replay['passed'] and replay['orderCount']==137 and replay['lineCount']==365
 assert replay['sourceHashes']['src/sor-rental-service.js']==state['after']['src/sor-rental-service.js']
 assert replay['sourceHashes']['src/dispatch-delivery-group-repository.js']==state['after']['src/dispatch-delivery-group-repository.js']
 driver=json.loads((ROOT/'test-artifacts/sor-rentals/all-orders-driver.json').read_text());assert driver['passed'] and not driver.get('planOnly')
 assert len(driver['refs'])==21 and len(driver['journeys'])==16 and sum(sum(job['type'] in ['pickup','dropoff'] for job in row['completed']) for row in driver['journeys'])==88
 for file,sha in driver['sourceHashes'].items():assert core.digest((core.RELEASE/'candidate'/file).read_bytes())==sha,file
 completed=json.loads((ROOT/'test-artifacts/sor-rentals/completed-returns-replay.json').read_text())
 assert completed['passed'] and completed['processed']==137 and completed['completedReturnCount']==21 and completed['allCompletedRowsUnchanged'] and completed['pausedGateVerified']
 for file,sha in completed['sourceHashes'].items():assert core.digest((core.RELEASE/'candidate'/file).read_bytes())==sha,file
 assert 'SOR/catalog deadlock: production-mode workers did not finish' in (ROOT/'test-artifacts/sor-rentals/all-orders-before-lock-fix.log').read_text()
 core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sources':state['after']});print('Candidate verified')

def verify():
 state=core.manifest();core.ready(state['candidateImageId'])
 after=core.metadata(core.APP);assert after['configuration']==state['app']['configuration'];assert [core.metadata(n) for n in core.DEPENDENCIES]==state['dependencies']
 expected={**state['unchangedSources'],**state['after']}
 hashes=core.docker('exec',core.APP,'sha256sum',*['/app/'+f for f in expected]).decode().splitlines()
 assert {line.split()[1].removeprefix('/app/'):line.split()[0] for line in hashes}==expected
 assert core.database("SELECT enabled FROM mbt_feature_flags WHERE flag_key='sor_rental_workflow'").strip()=='f'
 assert core.database('SELECT returns_enabled FROM sor_signature_settings').strip()=='f'
 script="""import assert from 'node:assert/strict';import {createHash,randomUUID} from 'node:crypto';
const hashes=HASHES;const probes=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 for(const path of ['/api/auth/bootstrap-needed','/operator','/driver','/admin/sor-auto-returns']){const start=Date.now();const r=await fetch(base+path,{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);probes.push({base,path,status:r.status,ms:Date.now()-start});}
 const start=Date.now();const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'health-nonexistent-'+randomUUID(),password:'invalid-health-probe'}),signal:AbortSignal.timeout(5000)});assert.equal(login.status,401);probes.push({base,path:'/api/auth/login',status:401,ms:Date.now()-start,purpose:'Expected rejection through real login database path'});
 for(const [file,hash]of Object.entries(hashes)){const r=await fetch(base+'/'+file.slice(7),{signal:AbortSignal.timeout(5000),headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash);}
}console.log(JSON.stringify(probes));
""".replace('HASHES',json.dumps({f:h for f,h in state['after'].items() if f.startswith('public/')}))
 probes=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()))
 result={'deployed':True,'imageId':after['imageId'],'startedAt':after['startedAt'],'sorEnabled':False,'verifiedSources':len(expected),'configurationPreserved':True,'dependenciesUnchanged':True,'probes':probes}
 core.save('deployment-result.json',result);print(json.dumps(result));return result

def apply():
 state=core.manifest();core.current(state)
 verified=json.loads((core.RELEASE/'verified.json').read_text());assert verified['passed'] and verified['imageId']==state['candidateImageId']
 assert core.database("SELECT enabled FROM mbt_feature_flags WHERE flag_key='sor_rental_workflow'").strip()=='f'
 assert core.database("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'").strip()=='0','Driver fulfillment is active; retry when idle'
 before=core.database("SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM dispatch_custom_orders c WHERE order_kind='sor_rental_return'").strip()
 (core.RELEASE/'returns-before.json').write_text(before)
 if core.database("SELECT count(*) FROM schema_migrations WHERE filename='"+core.MIGRATION+"'").strip()=='0':
  (core.RELEASE/'definitions-before.json').write_text(core.database("SELECT jsonb_agg(to_jsonb(d) ORDER BY split_ref) FROM dispatch_global_order_splits d WHERE order_type='CUSTOM' AND split_ref ~ '^SOR[0-9]+(-S[0-9]+)?-Return$'"))
  sql=(core.RELEASE/'candidate/migrations'/core.MIGRATION).read_text()
  (core.RELEASE/'migration.log').write_text(core.database("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='15s';\n"+sql+"\nINSERT INTO schema_migrations(filename) VALUES('"+core.MIGRATION+"'); COMMIT;"))
 core.verify=verify;core.apply()
 assert core.database("SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM dispatch_custom_orders c WHERE order_kind='sor_rental_return'").strip()==before

if __name__=='__main__':
 os.umask(0o077)
 {'prepare':prepare,'build':core.build,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()

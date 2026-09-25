"""Release only the three browser files verified by isolated workflow checks."""
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('workflow_release_core',ROOT/'tools/operator-display-settings-deploy.py')
core=importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/driver-workflow-20260924-v1')
core.BEFORE=ROOT/'test-artifacts/driver-workflow/before'
core.FILES=sorted(['public/driver.js','public/driver.html','public/driver-service-worker.js'])
core.EXISTING=core.FILES
core.ADDED=[]
core.IMAGE='mbbs-operator-app:driver-workflow-20260924-v1'
core.ROLLBACK='mbbs-operator-app:rollback-driver-workflow-20260924-v1'
# Already installed. The shared cutover routine must not apply any migration.
core.MIGRATION='222_sor_rental_returns.sql'
BASE='sha256:e8ca312feea3c012da428cbf829b70f9b5c00aa1330e5391e6959b7c16eec1d3'
ART=ROOT/'test-artifacts/driver-workflow'

def prepare():
 core.RELEASE.mkdir(parents=True,exist_ok=False)
 state={'app':core.metadata(core.APP),'dependencies':[core.metadata(name) for name in core.DEPENDENCIES]}
 assert state['app']['imageId']==BASE,'Live release changed; review before staging'
 baseline=core.RELEASE/'baseline';baseline.mkdir()
 archive=core.docker('exec',core.APP,'tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json')
 with tarfile.open(fileobj=io.BytesIO(archive)) as captured:captured.extractall(baseline,filter='data')
 candidate=core.RELEASE/'candidate';shutil.copytree(baseline,candidate)
 for file in core.FILES:
  assert (baseline/file).read_bytes()==(core.BEFORE/file).read_bytes(),'Unexpected live source: '+file
  shutil.copy2(ROOT/file,candidate/file)
 before,after=core.files_at(baseline),core.files_at(candidate)
 changed=sorted(file for file in after if after[file]!=before.get(file))
 assert changed==core.FILES
 state.update({'image':core.IMAGE,'changedFiles':changed,'before':{file:before[file] for file in changed},
  'after':{file:after[file] for file in changed},'workspace':{file:core.digest((ROOT/file).read_bytes()) for file in changed},
  'unchangedSources':{file:value for file,value in before.items() if file not in changed}})
 for file in changed:
  target=core.RELEASE/'stage'/file;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(candidate/file,target)
 (core.RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
 (core.RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+BASE+'\n')
 core.save('manifest.json',state)
 core.current(state)
 print(json.dumps({'prepared':True,'files':changed}))

def validate():
 state=core.manifest();core.current(state)
 report=json.loads((ART/'result.json').read_text())
 assert report['passed'] and not report['pageErrors'] and not report['serverErrors']
 assert report['sourceHashes']==state['after']
 journeys=[entry for entry in report['scenarios'] if isinstance(entry,dict)]
 assert [(entry['mode'],len(entry['completed'])) for entry in journeys]==[('online',4),('offline',3)]
 assert all(entry['signatureCount']==1 for entry in journeys)
 focused=(ART/'focused.log').read_text()
 assert '# tests 9' in focused and '# pass 9' in focused and '# fail 0' in focused
 assert json.loads((ART/'static.json').read_text())['passed']
 core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sources':state['after'],'browserFinishedAt':report['finishedAt']})
 print(json.dumps({'verified':True,'journeys':2,'stops':7,'imageId':state['candidateImageId']}))

def restage():
 state=core.manifest()
 assert core.metadata(core.APP)==state['app']
 assert [core.metadata(name) for name in core.DEPENDENCIES]==state['dependencies']
 for file in core.FILES:
  for folder in ['candidate','stage']:shutil.copy2(ROOT/file,core.RELEASE/folder/file)
  state['after'][file]=state['workspace'][file]=core.digest((ROOT/file).read_bytes())
 core.save('manifest.json',state);core.current(state)

def verify():
 state=core.manifest();core.ready(state['candidateImageId'])
 after=core.metadata(core.APP)
 assert after['configuration']==state['app']['configuration']
 assert [core.metadata(name) for name in core.DEPENDENCIES]==state['dependencies']
 expected={**state['unchangedSources'],**state['after']}
 actual=core.docker('exec',core.APP,'sha256sum',*['/app/'+file for file in expected]).decode().splitlines()
 assert {line.split()[1].removeprefix('/app/'):line.split()[0] for line in actual}==expected
 script="""import assert from 'node:assert/strict';import crypto from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(FILES)){
  const response=await fetch(base+'/'+file.replace('public/',''),{headers:{'cache-control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),hash);
 }
 assert.equal((await fetch(base+'/api/driver/me')).status,401);
}
""".replace('FILES',json.dumps(state['after']))
 core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode())
 result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'imageId':after['imageId'],
  'filesChanged':3,'sourceHashesVerified':len(expected),'localHealth':200,'publicHealth':200,'driverAnonymous':401,
  'configurationPreserved':True,'dependenciesUnchanged':True,'databaseMigrationApplied':False}
 core.save('deployment-result.json',result);print(json.dumps(result));return result

def apply():
 assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='222_sor_rental_returns.sql'").strip()=='1'
 core.verify=verify
 core.apply()

if __name__=='__main__':
 os.umask(0o077)
 {'prepare':prepare,'restage':restage,'build':core.build,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()

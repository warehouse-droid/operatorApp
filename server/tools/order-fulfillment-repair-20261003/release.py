"""Narrow Operator browser release; derives from the captured running image."""
import datetime
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
SERVER=HERE.parents[1]
OUT=Path('/home/ubuntu/operatorapp-investigations/operator-review-navigation-20261003')
spec=importlib.util.spec_from_file_location('review_release_core',SERVER/'tools/operator-display-settings-deploy.py')
core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
core.RELEASE=OUT
FILES=sorted(['public/operator.html','public/operator.js','public/service-worker.js','src/operator-netsuite-posting-targets.js','src/operator-netsuite-posting-domain.js','src/operator-netsuite-posting-adapter.js','src/netsuite.js','src/netsuite-transaction-units.js'])
IMAGE='mbbs-operator-app:operator-review-navigation-20261003'
VERSION='20261003-operator-review-uom-v1'
WORKER='mbbs-operator-app-webhook-worker-1'
WORKER_FILES=['src/netsuite-transaction-units.js','src/netsuite.js']
WORKER_IMAGE='mbbs-operator-app:operator-uom-worker-20261003'
BASE_APP='mbbs-operator-app:review-uom-base-app-20261003'
BASE_WORKER='mbbs-operator-app:review-uom-base-worker-20261003'
def docker(*args,**kwargs): return subprocess.check_output(['docker',*args],**kwargs)
core.docker=docker
def hashes(folder):
 return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for d in ['src','public','migrations'] for p in (folder/d).rglob('*') if p.is_file()}
HASH_SCRIPT="""const fs=require('fs'),crypto=require('crypto'),out={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())out[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(out));"""
def save(name,data): (OUT/name).write_text(json.dumps(data,indent=2)+'\n')
def current(state):
 assert core.metadata(core.APP)==state['app'],'App changed; rebase required'
 assert [core.metadata(n) for n in core.DEPENDENCIES]==state['dependencies'],'Other service changed; review before release'
 assert json.loads(docker('exec',core.APP,'node','-e',HASH_SCRIPT))==state['allBefore'],'Live source changed'
 assert hashes(OUT/'candidate')==state['allAfter'],'Candidate changed'
 assert json.loads(docker('exec',WORKER,'node','-e',HASH_SCRIPT))==state['workerBefore'],'Worker source changed'
 assert hashes(OUT/'worker-candidate')==state['workerAfter'],'Worker candidate changed'
def prepare():
 state={'app':core.metadata(core.APP),'dependencies':[core.metadata(n) for n in core.DEPENDENCIES]}
 state['worker']=core.metadata(WORKER)
 state['workerBefore']=hashes(OUT/'worker-baseline');state['workerAfter']=hashes(OUT/'worker-candidate')
 assert json.loads(docker('exec',WORKER,'node','-e',HASH_SCRIPT))==state['workerBefore'],'Worker capture stale'
 assert sorted(f for f in state['workerAfter'] if state['workerAfter'][f]!=state['workerBefore'].get(f))==WORKER_FILES
 before=hashes(OUT/'baseline')
 assert json.loads(docker('exec',core.APP,'node','-e',HASH_SCRIPT))==before,'Captured runtime is stale'
 for file in ['public/operator.html','public/service-worker.js']:
  text=(OUT/'baseline'/file).read_text()
  text,n=re.subn(r'/operator\.js\?v=[^"\s]+','/operator.js?v='+VERSION,text);assert n==1
  if file.endswith('service-worker.js'):
   text,n=re.subn(r'const CACHE_NAME = "[^"]+";','const CACHE_NAME = "mbbs-yard-operator-'+VERSION+'";',text);assert n==1
  (OUT/'candidate'/file).write_text(text)
 after=hashes(OUT/'candidate');assert sorted(f for f in after if after[f]!=before.get(f))==FILES
 state.update({'allBefore':before,'allAfter':after,'files':FILES,'after':{f:after[f] for f in FILES},'image':IMAGE})
 patch=''.join(''.join(difflib.unified_diff(((OUT/'baseline'/f).read_text() if (OUT/'baseline'/f).exists() else '').splitlines(True),(OUT/'candidate'/f).read_text().splitlines(True),fromfile='a/'+f,tofile='b/'+f)) for f in FILES)
 (HERE/'operator-review.patch').write_text(patch)
 stage=OUT/'stage';stage.mkdir(exist_ok=True)
 for file in FILES:
  (stage/file).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(OUT/'candidate'/file,stage/file)
 docker('tag',state['app']['imageId'],BASE_APP)
 (stage/'Dockerfile').write_text('FROM '+BASE_APP+'\n'+''.join('COPY --chmod=0644 '+f+' /app/'+f+'\n' for f in FILES))
 workerStage=OUT/'worker-stage';workerStage.mkdir(exist_ok=True)
 for file in WORKER_FILES:
  (workerStage/file).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(OUT/'worker-candidate'/file,workerStage/file)
 docker('tag',state['worker']['imageId'],BASE_WORKER)
 (workerStage/'Dockerfile').write_text('FROM '+BASE_WORKER+'\n'+''.join('COPY --chmod=0644 '+f+' /app/'+f+'\n' for f in WORKER_FILES))
 (OUT/'compose.release.yml').write_text('services:\n  app:\n    image: '+IMAGE+'\n  webhook-worker:\n    image: '+WORKER_IMAGE+'\n')
 (OUT/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+state['app']['imageId']+'\n  webhook-worker:\n    image: '+state['worker']['imageId']+'\n')
 save('manifest.json',state);print(json.dumps({'prepared':True,'changedFiles':FILES,'runtimeFiles':len(after)}))
def build():
 state=json.loads((OUT/'manifest.json').read_text());current(state)
 assert docker('image','inspect','--format','{{.Id}}',BASE_APP).decode().strip()==state['app']['imageId']
 assert docker('image','inspect','--format','{{.Id}}',BASE_WORKER).decode().strip()==state['worker']['imageId']
 with (OUT/'build.log').open('wb') as log:subprocess.run(['docker','build','--network','none','--pull=false','-t',IMAGE,str(OUT/'stage')],stdout=log,stderr=subprocess.STDOUT,check=True)
 state['candidateImageId']=docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
 assert json.loads(docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'-e',HASH_SCRIPT))==state['allAfter']
 with (OUT/'worker-build.log').open('wb') as log:subprocess.run(['docker','build','--network','none','--pull=false','-t',WORKER_IMAGE,str(OUT/'worker-stage')],stdout=log,stderr=subprocess.STDOUT,check=True)
 state['workerImageId']=docker('image','inspect','--format','{{.Id}}',WORKER_IMAGE).decode().strip()
 assert json.loads(docker('run','--rm','--network','none','--entrypoint','node',WORKER_IMAGE,'-e',HASH_SCRIPT))==state['workerAfter']
 save('manifest.json',state);print(json.dumps({'built':True,'imageId':state['candidateImageId']}))
def compose(state,override,service='app'):
 args=['sudo','-n','docker','compose','-p','mbbs-operator-app']
 for file in state['app' if service=='app' else 'worker']['configFiles'].split(','):args+=['-f',file]
 return args+['-f',str(OUT/override)]
def ready(expected):
 for _ in range(50):
  row=json.loads(docker('inspect',core.APP))[0]
  if row['Image']==expected and row['State']['Running'] and row['RestartCount']==0:
   probe=subprocess.run(['docker','exec',core.APP,'node','-e',"fetch('http://127.0.0.1:3000/health').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"],capture_output=True)
   if probe.returncode==0:return
  time.sleep(.5)
 raise RuntimeError('App did not become ready')
def verify(state):
 ready(state['candidateImageId'])
 actual=core.metadata(core.APP);assert actual['configuration']==state['app']['configuration']
 assert [core.metadata(n) for n in core.DEPENDENCIES[1:]]==state['dependencies'][1:]
 worker=core.metadata(WORKER);assert worker['configuration']==state['worker']['configuration'];assert worker['imageId']==state['workerImageId']
 assert json.loads(docker('exec',WORKER,'node','-e',HASH_SCRIPT))==state['workerAfter']
 assert json.loads(docker('exec',core.APP,'node','-e',HASH_SCRIPT))==state['allAfter']
 code="""import assert from 'node:assert/strict';import crypto from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
for(const [file,hash] of Object.entries(FILES)){const r=await fetch(base+'/'+file.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);assert.equal(crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash);}}
console.log(JSON.stringify({health:200,servedAssetHashes:3}));""".replace('FILES',json.dumps({f:h for f,h in state['after'].items() if f.startswith('public/')}))
 result=json.loads(docker('exec','-i',core.APP,'node','--input-type=module',input=code.encode()))
 result.update({'deployed':True,'imageId':state['candidateImageId'],'files':FILES,'configurationPreserved':True,'databaseAndOllamaPreserved':True,'workerImageId':state['workerImageId'],'workerConfigurationPreserved':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 save('deployment.json',result);print(json.dumps(result))
def apply():
 state=json.loads((OUT/'manifest.json').read_text());current(state)
 assert json.loads((OUT/'candidate-regression.json').read_text())['exit']==0
 assert json.loads((OUT/'new-tests.json').read_text())['exit']==0
 assert json.loads((OUT/'review-rule.json').read_text())['exit']==0
 assert json.loads((OUT/'candidate-posting.json').read_text())['failures']==json.loads((OUT/'baseline-posting.json').read_text())['failures']
 assert json.loads((OUT/'review-browser.json').read_text())['exit']==0
 assert json.loads((OUT/'receiving-browser.json').read_text())['exit']==0
 assert json.loads((OUT/'mutations.json').read_text())['exit']==0
 static=json.loads((OUT/'static-comparison.json').read_text());assert all(not v['new'] for v in static.values())
 assert json.loads((OUT/'tested-hashes.json').read_text())==state['after'],'Candidate needs final checks'
 assert json.loads((OUT/'units.json').read_text())['exit']==0
 assert json.loads((OUT/'worker-units.json').read_text())['exit']==0
 assert json.loads((OUT/'db-regression.json').read_text())['exit']==0
 assert json.loads((OUT/'review-mutations.json').read_text())['exit']==0
 assert json.loads((OUT/'units-live.json').read_text())['verified']
 assert json.loads((OUT/'candidate-uom-regression.json').read_text())['failures']==json.loads((OUT/'baseline-uom-regression.json').read_text())['failures']
 for service,container,imageName in [('app',core.APP,IMAGE),('webhook-worker',WORKER,WORKER_IMAGE)]:
  resolved=json.loads(subprocess.check_output(compose(state,'compose.release.yml',service)+['config','--format','json'],cwd=core.ROOT))['services'][service]
  image=json.loads(docker('image','inspect',imageName))[0]['Config'];running=json.loads(docker('inspect',container))[0]['Config']
  expected=dict(x.split('=',1) for x in image['Env']);expected.update({k:str(v) for k,v in resolved.get('environment',{}).items()})
  assert expected==dict(x.split('=',1) for x in running['Env']),'Environment drift'
  for field,key in [('Cmd','command'),('Entrypoint','entrypoint'),('User','user'),('WorkingDir','working_dir')]:assert (image.get(field) if resolved.get(key) is None else resolved[key])==running.get(field),'Startup drift'
 sql="""SELECT json_build_object('webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='processing'),'posting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),'driver',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),'automaticIF',(SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting'),'stockTransfers',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),'regular',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),'scm',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'))"""
 active=json.loads(docker('exec','-i',core.DEPENDENCIES[1],'psql','-U','mbbs_app','-d','mbbs_yard','-X','-v','ON_ERROR_STOP=1','-At',input=sql.encode()))
 assert not any(active.values()),'Wait for current operations: '+json.dumps(active)
 current(state)
 try:
  with (OUT/'worker-cutover.log').open('wb') as log:subprocess.run(compose(state,'compose.release.yml','webhook-worker')+['up','-d','--no-build','--no-deps','--pull','never','webhook-worker'],cwd=core.ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
  with (OUT/'cutover.log').open('wb') as log:subprocess.run(compose(state,'compose.release.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=core.ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
  verify(state)
 except Exception:
  with (OUT/'worker-rollback.log').open('wb') as log:subprocess.run(compose(state,'compose.rollback.yml','webhook-worker')+['up','-d','--no-build','--no-deps','--pull','never','webhook-worker'],cwd=core.ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
  with (OUT/'rollback.log').open('wb') as log:subprocess.run(compose(state,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=core.ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
  ready(state['app']['imageId']);raise
if __name__=='__main__':
 os.umask(0o077)
 {'prepare':prepare,'build':build,'apply':apply,'verify':lambda:verify(json.loads((OUT/'manifest.json').read_text()))}[sys.argv[1]]()

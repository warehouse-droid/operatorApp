"""Scoped, verified release of the Control damage transfer editor."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('control_damage_release_core',SERVER/'tools/damage-description-fix-deploy.py')
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core=base.core
core.RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/control-damage-20260923-v1')
core.BEFORE=Path('/tmp/control-damage-before/server')
core.EXISTING=['src/server.js','src/netsuite.js','src/inventory-damage-service.js','src/inventory-damage-repository.js','src/operator-inventory-router.js',
 'public/control.js','public/control.html','public/app-sidebar.js','public/operator-inventory.js','public/operator.html','public/service-worker.js','public/i18n.js']
core.ADDED=['src/control-damage-domain.js','src/control-damage-netsuite.js','src/control-damage-service.js','src/control-damage-review.js','src/control-damage-router.js',
 'public/control-damage.js','public/control-damage.css','migrations/221_control_damage_adjustments.sql']
core.FILES=sorted(core.EXISTING+core.ADDED)
core.IMAGE='mbbs-operator-app:control-damage-20260923-v1'
core.ROLLBACK='mbbs-operator-app:rollback-control-damage-20260923-v1'
core.MIGRATION='221_control_damage_adjustments.sql'
CHECKS=SERVER/'test-artifacts/control-damage'

def shell_assets(file,text):
 for asset in ['operator-inventory.js','i18n.js']:
  text,count=re.subn(r'/'+re.escape(asset)+r'\?v=[^"\s]+','/'+asset+'?v=20260923-control-damage-v1',text)
  assert count==1
 if file.endswith('service-worker.js'):
  text,count=re.subn(r'const CACHE_NAME = "[^"]+";','const CACHE_NAME = "mbbs-yard-operator-20260923-control-damage-v1";',text)
  assert count==1
 return text
core.shell_assets=shell_assets
original_database=core.database

def database(sql):
 return original_database(sql.replace("to_regclass('public.operator_ui_preferences')","to_regclass('public.inventory_damage_adjustments')"))
core.database=database

def prepare():
 base.prepare()
 # Test-only npm scripts; this file is not in the production overlay.
 shutil.copy2(SERVER/'package.json',core.RELEASE/'candidate/package.json')

def validate():
 state=core.manifest();core.current(state)
 sources=json.loads((CHECKS/'sources.json').read_text())['sources']
 for file,sha in sources.items():
  target=core.RELEASE/'candidate'/file if file in core.FILES else SERVER/file
  assert core.digest(target.read_bytes())==sha,'Verified source changed: '+file
 for file in core.FILES: assert sources[file]==state['after'][file]
 assert json.loads((CHECKS/'comparison.json').read_text())['unexpected']==[]
 assert all(row['killed'] for row in json.loads((CHECKS/'mutations.json').read_text()))
 assert json.loads((CHECKS/'changed-coverage.json').read_text())['missed']==[]
 for path in [CHECKS/'focused.log',core.RELEASE/'candidate-tests.log']:
  log=path.read_text();assert '# fail 0' in log and re.search(r'# pass [1-9][0-9]',log),'Candidate checks required'
 core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sources':state['after']})
 print(json.dumps({'verified':True,'imageId':state['candidateImageId']}))

def verify():
 state=core.manifest();core.ready(state['candidateImageId'])
 actual=core.metadata(core.APP)
 assert actual['configuration']==state['app']['configuration']
 assert [core.metadata(name) for name in core.DEPENDENCIES]==state['dependencies']
 expected={**state['unchangedSources'],**state['after']}
 hashes=core.docker('exec',core.APP,'sha256sum',*['/app/'+name for name in expected]).decode().splitlines()
 assert {row.split()[1].removeprefix('/app/'):row.split()[0] for row in hashes}==expected
 assert database("SELECT count(*) FROM schema_migrations WHERE filename='221_control_damage_adjustments.sql';").strip()=='1'
 script="""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const files=FILES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 assert.equal((await fetch(base+'/control/damage-stock')).status,200);
 assert.equal((await fetch(base+'/api/control/damage/config')).status,401);
 for(const [file,sha] of Object.entries(files)) {
  const response=await fetch(base+'/'+file.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});assert.equal(response.status,200,file);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),sha,file);
 }
}console.log(JSON.stringify({health:200,controlPage:200,anonymousControlDamage:401,assetHashes:Object.keys(files).length}));""".replace('FILES',json.dumps({key:value for key,value in state['after'].items() if key.startswith('public/')}))
 probes=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()))
 result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'imageId':actual['imageId'],'verifiedFiles':len(expected),'configurationPreserved':True,'otherServicesUnchanged':True,**probes}
 core.save('deployment-result.json',result);print(json.dumps(result))

def apply():
 assert database("SELECT count(*) FROM inventory_damage_reports WHERE status='posting';").strip()=='0','Damage posting active'
 core.verify=verify
 core.apply()

if __name__=='__main__':
 os.umask(0o077)
 {'prepare':prepare,'build':core.build,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()

"""Deploy only the SOR pause gate; preserve live configuration and unrelated source."""
import difflib
import io
import shutil
import subprocess
import tarfile
import importlib.util
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('gate_release_core',ROOT/'tools/operator-display-settings-deploy.py')
core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
core.RELEASE=Path('/home/ubuntu/operatorapp-deploy-backups/sor-feature-gate-20260924-v1')
core.BEFORE=ROOT/'test-artifacts/sor-feature-gate/before'
core.EXISTING=['src/mbt/feature-gate-catalog.js','src/sor-rental-service.js','src/netsuite.js',
 'src/driver-repository.js','src/dispatch-repository.js','src/server.js','src/dispatch-order-catalog-repository.js',
 'src/sor-rental-routes.js','public/sor-admin.js','public/admin.html']
core.MIGRATION='223_sor_feature_gate.sql'
core.ADDED=['src/sor-feature-gate.js','migrations/'+core.MIGRATION]
core.FILES=sorted(core.EXISTING+core.ADDED)
core.IMAGE='mbbs-operator-app:sor-feature-gate-20260924-v1'
core.ROLLBACK='mbbs-operator-app:rollback-sor-feature-gate-20260924-v1'
BASE='sha256:9083537a13caa6cb21c24d5c441bbb5144d2e72e95fe746e820d7829b12cfdad'
ART=ROOT/'test-artifacts/sor-feature-gate'

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
  old=(core.BEFORE/file).read_text();new=(ROOT/file).read_text()
  patch+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file,n=1 if file=='src/dispatch-repository.js' else 3))
 (core.RELEASE/'release.patch').write_text(patch)
 result=subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,capture_output=True)
 (core.RELEASE/'patch.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stdout
 for file in core.ADDED:shutil.copy2(ROOT/file,candidate/file)
 for path in candidate.rglob('*.orig'):path.unlink()
 before,after=core.files_at(baseline),core.files_at(candidate)
 changed=sorted(f for f in after if after[f]!=before.get(f));assert changed==core.FILES
 state.update({'image':core.IMAGE,'before':{f:before.get(f) for f in core.FILES},'after':{f:after[f] for f in core.FILES},
  'workspace':{f:core.digest((ROOT/f).read_bytes()) for f in core.FILES},'changedFiles':changed})
 for file in core.FILES:
  dest=core.RELEASE/'stage'/file;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(candidate/file,dest)
 (core.RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
 (core.RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+BASE+'\n')
 state['unchangedSources']={f:h for f,h in core.files_at(core.RELEASE/'baseline').items() if f not in core.FILES}
 core.save('manifest.json',state)
 print(json.dumps({'prepared':True,'changed':changed}))

def validate():
 state=core.manifest();core.current(state)
 log=(ART/'gate-candidate.log').read_text()
 assert '# fail 0' in log and '# pass 0' not in log
 core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sources':state['after']})
 print('Gate candidate tests passed')

def verify():
 state=core.manifest();core.ready(state['candidateImageId'])
 actual=core.metadata(core.APP)
 assert actual['configuration']==state['app']['configuration']
 assert [core.metadata(n) for n in core.DEPENDENCIES]==state['dependencies']
 expected={**state['unchangedSources'],**state['after']}
 hashes=core.docker('exec',core.APP,'sha256sum',*['/app/'+f for f in expected]).decode().splitlines()
 assert {line.split()[1].removeprefix('/app/'):line.split()[0] for line in hashes}==expected
 assert core.database("SELECT enabled FROM mbt_feature_flags WHERE flag_key='sor_rental_workflow'").strip()=='f'
 assert core.database('SELECT returns_enabled FROM sor_signature_settings').strip()=='f'
 script="""import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for(const path of ['/health','/api/auth/bootstrap-needed','/admin/mbt-gates','/admin/sor-auto-returns','/driver']) {
  const start=Date.now();const r=await fetch(base+path,{signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,200);console.log(JSON.stringify({base,path,status:r.status,ms:Date.now()-start}));
 }
}
"""
 probe=core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()).decode()
 result={'deployed':True,'imageId':actual['imageId'],'startedAt':actual['startedAt'],'sorEnabled':False,
  'verifiedSources':len(expected),'configurationPreserved':True,'dependenciesUnchanged':True,'probes':probe}
 core.save('deployment-result.json',result);print(json.dumps(result));return result

def apply():
 state=core.manifest();core.current(state)
 checked=json.loads((core.RELEASE/'verified.json').read_text())
 assert checked['passed'] and checked['imageId']==state['candidateImageId']
 assert core.database('SELECT returns_enabled FROM sor_signature_settings').strip()=='f'
 core.save('sor-before.json',{'returnCount':core.database("SELECT count(*) FROM dispatch_custom_orders WHERE order_kind='sor_rental_return'").strip()})
 if core.database("SELECT count(*) FROM schema_migrations WHERE filename='223_sor_feature_gate.sql'").strip()=='0':
  sql=(core.RELEASE/'candidate/migrations'/core.MIGRATION).read_text()
  result=core.database("BEGIN; SET LOCAL lock_timeout='3s';\n"+sql+"\nINSERT INTO schema_migrations(filename) VALUES('223_sor_feature_gate.sql'); COMMIT;")
  (core.RELEASE/'migration.log').write_text(result)
 core.verify=verify;core.apply()
 assert core.database("SELECT count(*) FROM dispatch_custom_orders WHERE order_kind='sor_rental_return'").strip()==json.loads((core.RELEASE/'sor-before.json').read_text())['returnCount']

if __name__=='__main__':
 os.umask(0o077)
 {'prepare':prepare,'build':core.build,'validate':validate,'apply':apply,'verify':verify}[sys.argv[1]]()

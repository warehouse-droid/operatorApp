"""Stage only the SOR change on the captured live application, retaining rollback."""
import importlib.util
import difflib
import datetime
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sor_release_core', ROOT / 'tools/operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/sor-rentals-20260924-v1')
core.BEFORE = ROOT / 'test-artifacts/sor-rentals/before'
core.FILES = json.loads((ROOT / 'tools/sor-rentals-files.json').read_text())
core.EXISTING = [file for file in core.FILES if (core.BEFORE / file).exists()]
core.ADDED = [file for file in core.FILES if file not in core.EXISTING]
core.IMAGE = 'mbbs-operator-app:sor-rentals-20260924-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-sor-rentals-20260924-v1'
core.MIGRATION = '222_sor_rental_returns.sql'
ART = ROOT / 'test-artifacts/sor-rentals'

def prepare():
    os.umask(0o077)
    core.RELEASE.mkdir(parents=True, exist_ok=False)
    state={'app':core.metadata(core.APP),'dependencies':[core.metadata(name) for name in core.DEPENDENCIES]}
    baseline=core.RELEASE/'baseline'
    baseline.mkdir()
    archive=core.docker('exec',core.APP,'tar','-C','/app','-cf','-','src','public','migrations','package.json','package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as captured:
        captured.extractall(baseline,filter='data')
    assert core.metadata(core.APP)==state['app']
    core.save('capture.json',state)
    assemble()

def assemble():
    state=json.loads((core.RELEASE/'capture.json').read_text())
    assert core.metadata(core.APP)==state['app']
    baseline=core.RELEASE/'baseline'
    candidate=core.RELEASE/'candidate'
    if candidate.exists(): shutil.rmtree(candidate)
    shutil.copytree(baseline,candidate)
    patch=''
    sor_import='import { decorateSorOrders } from "./sor-rental-repository.js";\n'
    for file in core.EXISTING:
        old,new=(core.BEFORE/file).read_text(),(ROOT/file).read_text()
        if file=='public/dispatch.html':
            old=(baseline/file).read_text()
            new,count=re.subn(r'/dispatch\.js\?v=[^"\s]+','/dispatch.js?v=20260924-sor-v1',old)
            assert count==1
        if file=='src/dispatch-repository.js':
            assert new.startswith(sor_import)
            new=new[len(sor_import):]
        patch+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
    (core.RELEASE/'release.patch').write_text(patch)
    result=subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,capture_output=True)
    (core.RELEASE/'patch.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,'Patch needs review'
    repository=candidate/'src/dispatch-repository.js'
    assert repository.read_text().startswith('import { notifyDispatchPlanMaintenance }')
    repository.write_text(sor_import+repository.read_text())
    for file in core.ADDED:
        assert not (baseline/file).exists()
        shutil.copy2(ROOT/file,candidate/file)
    for path in candidate.rglob('*.orig'):
        if not (baseline/path.relative_to(candidate)).exists(): path.unlink()
    before,after=core.files_at(baseline),core.files_at(candidate)
    changed=sorted(file for file in before.keys()|after.keys() if before.get(file)!=after.get(file))
    assert changed==core.FILES
    state.update({'image':core.IMAGE,'changedFiles':changed,
        'before':{file:before.get(file) for file in changed},'after':{file:after[file] for file in changed},
        'workspace':{file:core.digest((ROOT/file).read_bytes()) for file in changed},
        'unchangedSources':{file:value for file,value in before.items() if file not in changed}})
    for file in changed:
        target=core.RELEASE/'stage'/file
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(candidate/file,target)
    (core.RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
    (core.RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+state['app']['imageId']+'\n')
    core.save('manifest.json',state)
    print(json.dumps({'prepared':True,'files':changed}))

def validate():
    state=core.manifest()
    core.current(state)
    checks=json.loads((ART/'verification.json').read_text())
    assert checks['passed'] and checks['workspace']==state['workspace'] and checks['candidateSources']==state['after']
    core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sources':state['after']})
    print(json.dumps({'verified':True,'imageId':state['candidateImageId']}))

def verify():
    state=core.manifest()
    core.ready(state['candidateImageId'])
    after=core.metadata(core.APP)
    assert after['configuration']==state['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES]==state['dependencies']
    expected={**state['unchangedSources'],**state['after']}
    hashes=core.docker('exec',core.APP,'sha256sum',*['/app/'+file for file in expected]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'):line.split()[0] for line in hashes}==expected
    assert core.database("SELECT count(*) FROM schema_migrations WHERE filename='"+core.MIGRATION+"';").strip()=='1'
    assets={file.removeprefix('public/'):value for file,value in state['after'].items() if file.startswith('public/')}
    script="""import assert from 'node:assert/strict';import crypto from 'node:crypto';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 for(const [file,expected] of Object.entries(ASSETS)){
  const response=await fetch(base+'/'+file,{headers:{'Cache-Control':'no-cache'}});
  assert.equal(response.status,200,file);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
 }
 const health=await fetch(base+'/health');assert.equal((await health.json()).ok,true);
 assert.equal((await fetch(base+'/api/admin/sor-auto-returns/settings')).status,401);
 assert.equal((await fetch(base+'/admin/sor-auto-returns')).status,200);
}
""".replace('ASSETS',json.dumps(assets))
    core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode())
    prior=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=(ROOT/'tools/split-group-pickup-live.mjs').read_bytes()))
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'imageId':after['imageId'],
        'verifiedFiles':len(expected),'publicAssetHashes':len(assets),'configurationPreserved':True,'dependenciesUnchanged':True,
        'publicHealth':200,'localHealth':200,'adminAnonymous':401,'previousSplitFix':prior}
    core.save('deployment-result.json',result)
    print(json.dumps(result))
    return result

def apply():
    # Retain the existing release procedure's configuration/idle/cutover guards.
    # Only its task-specific table assertion and final probe are replaced.
    state=core.manifest()
    core.current(state)
    backup_tables=['dispatch_custom_orders','dispatch_order_catalog_entries',
        'dispatch_order_catalog_state','dispatch_order_catalog_refresh_outbox','schema_migrations']
    with (core.RELEASE/'sor-operational-before.dump').open('wb') as target:
        subprocess.run(['sudo','-n','docker','exec',core.DEPENDENCIES[1],'pg_dump','-U','mbbs_app','-d','mbbs_yard',
            '--format=custom','--strict-names',*['--table=public.'+table for table in backup_tables]],stdout=target,check=True)
    with (core.RELEASE/'sor-operational-before.dump').open('rb') as source:
        toc=core.docker('exec','-i',core.DEPENDENCIES[1],'pg_restore','--list',stdin=source)
    assert all(('TABLE DATA public '+table+' ').encode() in toc for table in backup_tables)
    (core.RELEASE/'sor-operational-before.dump.toc').write_bytes(toc)
    original=core.database
    core.database=lambda sql:original(sql.replace("to_regclass('public.operator_ui_preferences')","to_regclass('public.sor_signature_settings')"))
    core.verify=verify
    core.apply()

def rollout(mode):
    assert mode in ('preview','activate','check')
    script=(ROOT/'tools/sor-rentals-rollout.mjs').read_text()
    script=script.replace('/* SOR_MODE */ "check"',json.dumps(mode))
    result=core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode())
    (core.RELEASE/f'rollout-{mode}.json').write_bytes(result)
    print(result.decode())

if __name__ == '__main__':
    os.umask(0o077)
    {'prepare':prepare,'assemble':assemble,'build':core.build,'validate':validate,'apply':apply,'verify':verify,
     'preview':lambda:rollout('preview'),'activate':lambda:rollout('activate'),'check':lambda:rollout('check')}[sys.argv[1]]()

"""Capture, test and release only the damage-photo changes over the live app."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER=Path(__file__).resolve().parents[1]
RELEASE=SERVER/'deployments/damage-posting-retry-20261001'
OUT=SERVER/'test-artifacts/damage-posting-retry-20261001'
FILES=json.loads((SERVER/'tools/damage-posting-retry-files.json').read_text())
IMAGE='mbbs-operator-app:damage-posting-retry-20261001'
RUNNER='mbbs-damage-posting-retry-test-runner'
REMOTE='/tmp/damage-posting-retry-candidate-20261001'
spec=importlib.util.spec_from_file_location('damage_photos_release',SERVER/'tools/scm-schedule-multi-sort-deploy.py')
parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
parent.RELEASE,parent.OUT,parent.FILES,parent.IMAGE=RELEASE,OUT,FILES,IMAGE
parent.core.RELEASE=RELEASE
APP,docker,metadata,digest=parent.APP,parent.docker,parent.metadata,parent.digest

def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before=metadata(APP)
    baseline=RELEASE/'before';baseline.mkdir()
    for name in ['src','public','migrations','package.json','package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp',APP+':/app/'+name,'-'))) as archive:
            archive.extractall(baseline,filter='data')
    assert metadata(APP)==before
    candidate=RELEASE/'candidate';shutil.copytree(baseline,candidate)
    patch=''
    for file in FILES:
        live=baseline/file
        if live.exists() and live.read_bytes()==(SERVER/file).read_bytes(): continue
        if live.exists():
            original=OUT/'before'/Path(file).name
            if not original.exists(): original=OUT/'baseline-source'/file
            patch+=''.join(difflib.unified_diff(original.read_text().splitlines(True),(SERVER/file).read_text().splitlines(True),
                                               fromfile='a/'+file,tofile='b/'+file))
        else:
            target=candidate/file;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(SERVER/file,target)
    (RELEASE/'changes.patch').write_text(patch)
    result=subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,capture_output=True)
    (RELEASE/'patch.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,'Damage-only patch does not apply to the live parent'
    for path in candidate.rglob('*.orig'): path.unlink()
    old_tree,new_tree=parent.core.files_at(baseline),parent.core.files_at(candidate)
    changed=sorted(file for file in new_tree if old_tree.get(file)!=new_tree[file])
    assert changed and set(changed)<=set(FILES), 'Unexpected or empty scoped release'
    parent.save('source-tree.json',new_tree)
    parent.save('manifest.json',{'services':{'app':{'before':before,'image':IMAGE}},
        'workspaceHashes':{file:digest((SERVER/file).read_bytes()) for file in FILES},
        'sourceHashes':{file:new_tree[file] for file in FILES},'changedFiles':changed,
        'untouched':{name:metadata(name) for name in parent.UNTOUCHED}})
    parent.current(parent.state())
    print(json.dumps({'captured':True,'parent':before['image'],'files':FILES}),flush=True)

def collect():
    target=OUT/'candidate';target.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(docker('exec',RUNNER,'tar','-cf','-','-C',REMOTE+'/test-artifacts/damage-posting-retry-20261001','.'))) as archive:
        archive.extractall(target,filter='data')

def validate_candidate():
    root=RELEASE/'validation'
    shutil.copytree(RELEASE/'candidate',root,dirs_exist_ok=True)
    for folder in ['test','tools','contracts']: shutil.copytree(SERVER/folder,root/folder,dirs_exist_ok=True)
    for file in ['eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']:
        shutil.copy2(SERVER/file,root/file)
    baseline=root/'test-artifacts/damage-posting-retry-20261001/baseline-source'
    shutil.copytree(RELEASE/'before',baseline,dirs_exist_ok=True)
    docker('exec',RUNNER,'node','-e',"const fs=require('fs'),p=process.argv[1];if(p!=='/tmp/damage-posting-retry-candidate-20261001')throw Error('Unexpected candidate path');fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)",REMOTE)
    payload=io.BytesIO()
    with tarfile.open(fileobj=payload,mode='w') as archive:
        for path in root.iterdir(): archive.add(path,arcname=path.name)
    docker('exec','-i',RUNNER,'tar','-xf','-','-C',REMOTE,input=payload.getvalue())
    docker('exec',RUNNER,'node','-e',"require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')",REMOTE)
    with (RELEASE/'candidate-checks.log').open('wb') as log:
        run=subprocess.run(['sudo','-n','docker','exec','-w',REMOTE,'-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@db:5432/mbt_focus',
                            RUNNER,'node','tools/damage-posting-retry-check.mjs'],stdout=log,stderr=subprocess.STDOUT,timeout=600)
    collect()
    assert run.returncode==0,'Candidate damage-photo checks failed'
    checks=json.loads((OUT/'candidate/checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes']==parent.state()['sourceHashes']

def finish_prepare():
    def validated():
        collect()
        checks=json.loads((OUT/'candidate/checks.json').read_text())
        assert checks['completed'] and checks['sourceHashes']==parent.state()['sourceHashes']
        assert checks['focused']['fail']==0 and checks['reordered']['fail']==0
        actual=json.loads(docker('exec','-w',REMOTE,RUNNER,'node','-e',parent.HASH))
        assert actual==json.loads((RELEASE/'source-tree.json').read_text())
    parent.validate_candidate=validated
    parent.prepare()

def verify():
    data=parent.state();parent.core.core.ready(data['services']['app']['candidateImageId'])
    actual=metadata(APP)
    assert actual['imageId']==data['services']['app']['candidateImageId']
    assert actual['configuration']==data['services']['app']['before']['configuration']
    assert {name:metadata(name) for name in parent.UNTOUCHED}==data['untouched']
    assert json.loads(docker('exec',APP,'node','-e',parent.HASH))==json.loads((RELEASE/'source-tree.json').read_text())
    script=r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(30000)});assert.equal(health.status,200);
 assert.equal((await fetch(base+'/api/control/damage/config')).status,401);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const path=file==='public/operator.html'?'/operator':file.endsWith('.html')?'/control/damage-stock':'/'+file.slice(7);
 const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);
 }
}console.log(JSON.stringify({health:200,anonymousDamageApi:401,publicAssetsVerified:true}));""".replace('HASHES',json.dumps(data['sourceHashes']))
    checks=json.loads(docker('exec','-i',APP,'node','--input-type=module',input=script.encode()))
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':IMAGE,'imageId':actual['imageId'],
        'files':FILES,'verifiedFiles':len(json.loads((RELEASE/'source-tree.json').read_text())),
        'configurationPreserved':True,'otherServicesUnchanged':True,'migrationApplied':False,**checks}
    parent.save('result.json',result);print(json.dumps(result),flush=True)

def apply():
    data=parent.state();parent.current(data);parent.core.config_check(data)
    checks=json.loads((OUT/'candidate/checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes']==data['sourceHashes']
    assert json.loads((OUT/'comparison.json').read_text())['newFailures']==[]
    assert json.loads((OUT/'candidate/changed-coverage.json').read_text())['missed']==[]
    active=json.loads(parent.database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'damagePosting',(SELECT count(*) FROM inventory_damage_reports WHERE status IN ('pending','posting')),
      'damageAdjustment',(SELECT count(*) FROM inventory_damage_adjustments WHERE status IN ('pending','posting')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"""))
    parent.save('active-before-release.json',active);assert not any(active.values()),'Wait for active operations: '+json.dumps(active)
    try:
        with (RELEASE/'publish.log').open('wb') as log:
            subprocess.run(parent.core.compose(data)+['up','-d','--no-build','--no-deps','--pull','never','app'],
                           cwd=SERVER.parent,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except Exception:
        with (RELEASE/'rollback.log').open('wb') as log:
            subprocess.run(parent.core.compose(data,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],
                           cwd=SERVER.parent,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        parent.core.core.ready(data['services']['app']['before']['imageId'])
        parent.save('rollback-result.json',{'rolledBack':True,'noSchemaChange':True})
        raise

parent.validate_candidate=validate_candidate
if __name__=='__main__':
    {'capture':capture,'prepare':parent.prepare,'finish-prepare':finish_prepare,'apply':apply,'verify':verify,'collect':collect}[sys.argv[1]]()

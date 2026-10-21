"""Prepare, build, verify and deploy the Android native camera capture release over the live image."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('packing_release', HERE/'operator-group-packing-deploy.py')
packing = importlib.util.module_from_spec(spec); spec.loader.exec_module(packing)
core = packing.core
R = core.RELEASE = packing.R = Path('/home/ubuntu/operatorapp-deploy-backups/operator-android-native-camera-20260930-v2')
core.IMAGE = 'mbbs-operator-app:operator-android-native-camera-20260930-v2'
core.ROLLBACK = 'mbbs-operator-app:rollback-android-native-camera-20260930-v2'
core.FILES = core.EXISTING = ['public/operator-inventory.js','public/operator.html','public/operator.js','public/service-worker.js']
core.ADDED = []
ART = core.SERVER/'test-artifacts/operator-android-camera-release'
UNIT = 'test/mbt/unit/operator-camera-rollback.test.js'
BROWSER = 'test/dispatch/frontend/operator-android-camera-release.browser.test.mjs'
verify_runtime = packing.verify

def prepare():
    os.umask(0o077); R.mkdir(parents=True,exist_ok=False)
    state = {'app':core.metadata(core.APP),'dependencies':[core.metadata(name) for name in core.DEPENDENCIES]}
    packing.extract(core.APP,'/app',['src','public','migrations'],R/'baseline')
    shutil.copytree(R/'baseline',R/'candidate')
    changed_lines={}; patch=''
    for file in core.FILES:
        assert (R/'baseline'/file).read_bytes()==(ART/'baseline'/Path(file).name).read_bytes(), 'Rebase changed live asset: '+file
        shutil.copyfile(core.SERVER/file,R/'candidate'/file)
        old,new=(R/'baseline'/file).read_text(),(R/'candidate'/file).read_text()
        patch+=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file))
        changed_lines[file]=[line+1 for tag,_,_,start,end in difflib.SequenceMatcher(None,old.splitlines(),new.splitlines()).get_opcodes()
                             if tag in ('insert','replace') for line in range(start,end)]
        target=R/'stage'/file; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(R/'candidate'/file,target);target.chmod(0o644)
    (R/'release.patch').write_text(patch)
    before,after=core.files_at(R/'baseline'),core.files_at(R/'candidate')
    assert sorted(file for file in after if after[file]!=before.get(file))==core.FILES
    assert after['src/delivery-repository.js']=='38ea8a47316bf163a829503b73918710920374144b7cc572f7bfb6ab0bd156aa','Packing fix must remain'
    state.update({'image':core.IMAGE,'before':{file:before[file] for file in core.FILES},'after':{file:after[file] for file in core.FILES},
                  'workspace':{file:core.digest((core.SERVER/file).read_bytes()) for file in core.FILES},'changedFiles':core.FILES,
                  'allBefore':before,'allAfter':after,'changedLines':changed_lines})
    (R/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
    (R/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+state['app']['imageId']+'\n')
    shutil.copytree(R/'candidate/public',R/'test-public')
    vendor=R/'test-public/vendor/quagga2';vendor.mkdir(parents=True,exist_ok=True)
    (vendor/'quagga.min.js').write_bytes(core.docker('exec',core.APP,'cat','/app/node_modules/@ericblade/quagga2/dist/quagga.min.js'))
    qr=R/'test-public/vendor/qr-scanner';qr.mkdir(parents=True,exist_ok=True)
    for name in ['qr-scanner.min.js','qr-scanner-worker.min.js']:
        (qr/name).write_bytes(core.docker('exec',core.APP,'cat','/app/node_modules/qr-scanner/'+name))
    (ART/'repro-live-manifest.json').write_text(json.dumps({'parentImage':state['app']['imageId'],'files':state['after']},indent=2))
    core.save('manifest.json',state);core.current(state)
    print(json.dumps({'prepared':True,'parent':state['app']['image'],'changedFiles':core.FILES,'packingFixPreserved':True}),flush=True)

def run(name,args,*,browser=False,env=None,baseline=False,expected=0):
    cmd=['sudo','-n','docker','run','--rm','--network','none','--ipc','private',
         '--mount',f'type=bind,src={R},dst=/release',
         '--mount',f'type=bind,src={R / ("baseline" if baseline else "candidate") / "public"},dst=/app/public,readonly',
         '--mount',f'type=bind,src={core.SERVER / "test"},dst=/app/test,readonly',
         '--mount',f'type=bind,src={core.SERVER / "tools"},dst=/app/tools,readonly',
         '--mount',f'type=bind,src={ART},dst=/app/test-artifacts/operator-android-camera-release']
    for key,value in (env or {}).items():cmd+=['-e',key+'='+value]
    cmd+=['--entrypoint','node','mbbs-regular-v2:'+('e2e' if browser else 'test'),*args]
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=180)
    output=result.stdout+result.stderr;(R/(name+'.log')).write_text(output)
    counts={key:int(value) for key,value in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$',output,re.M)}
    row={'name':name,'exit':result.returncode,**counts,'failures':re.findall(r'^not ok \d+ - (.+)$',output,re.M)}
    print(json.dumps(row),flush=True)
    assert result.returncode==expected, 'Unexpected result: '+name
    return row

def tests():
    state=core.manifest();core.current(state)
    for file in ART.glob('browser-coverage-candidate-*.json'):file.unlink()
    rows=[run('native-unit',['--test','test/mbt/unit/operator-native-camera.test.js',UNIT,
        'test/mbt/unit/operator-posting-responsiveness.test.js','test/mbt/unit/operator-delivery-reference.test.js'])]
    rows.append(run('native-browser',['--test',BROWSER],browser=True,env={'OPERATOR_ANDROID_PUBLIC':'/release/test-public'}))
    rows.append(run('windows-regression',['--test','--test-name-pattern=native camera is released|Windows mode',
        'test/dispatch/frontend/operator-camera-rollback.browser.test.mjs'],browser=True))
    for mutant in ['stale','hidden','discard','cleanup','duplicate','windows']:
        rows.append(run('mutant-'+mutant,['--test','test/mbt/unit/operator-native-camera.test.js'],env={'OPERATOR_NATIVE_MUTANT':mutant},expected=1))
    for mutant in ['stale','hidden','discard']:
        rows.append(run('property-mutant-'+mutant,['--test','--test-name-pattern=property:','test/mbt/unit/operator-native-camera.test.js'],env={'OPERATOR_NATIVE_MUTANT':mutant},expected=1))
    rows.append(run('installed-pwa',['tools/operator-native-camera-pwa.mjs','receipt'],browser=True,env={
        'OPERATOR_CAMERA_REPRO_ROOT':'/release/test-public','OPERATOR_CAMERA_REPRO_ARTIFACTS':'test-artifacts/operator-android-camera-release',
        'OPERATOR_CAMERA_REPRO_UA':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36'}))
    pwa=json.loads((ART/'repro-installed-pwa-receipt.json').read_text())
    assert not pwa.get('harnessError')
    assert pwa['runs'][0]['standalone']['standalone'] and pwa['runs'][0]['evidence']['requests']==[]
    rows.append(run('static' ,['tools/operator-android-camera-checks.mjs']))
    core.current(state)
    core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'results':rows,
        'sourceHashes':state['after'],'static':json.loads((R/'static.json').read_text())})
    print(json.dumps({'verified':True,'imageId':state['candidateImageId'],'files':core.FILES}),flush=True)

def verify():
    verify_runtime()
    state=core.manifest()
    script='''import assert from 'node:assert/strict';import crypto from 'node:crypto';
const files=FILES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 for(const [file,expected] of Object.entries(files)){
  const response=await fetch(base+'/'+file.replace(/^public\\//,'')+'?v=20260930-android-native-camera-v2',{cache:'no-store'});
  assert.equal(response.status,200,file);
  assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expected,file);
 }
}console.log(JSON.stringify({localAndPublicAssetHashesVerified:Object.keys(files).length}));'''.replace('FILES',json.dumps(state['after']))
    checks=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()))
    result=json.loads((R/'deployment-result.json').read_text());result.update(checks)
    result['packingFixPreserved']=True;result['cameraVersion']='20260930-android-native-camera-v2'
    core.save('deployment-result.json',result);print(json.dumps(result),flush=True)

packing.verify=verify

def apply():
    try: packing.apply()
    except Exception:
        if (R/'deployment-result.json').exists():
            failed=json.loads((R/'deployment-result.json').read_text());failed['deployed']=False
            failed['rollbackAttempted']=(R/'rollback.log').exists();core.save('deployment-result.json',failed)
        raise

if __name__=='__main__':
    {'prepare':prepare,'build':core.build,'test':tests,'apply':apply,'verify':verify}[sys.argv[1]]()

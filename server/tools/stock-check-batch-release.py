"""Release bounded multi-line matching inputs while retaining the current model configuration."""
import difflib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time

SERVER=pathlib.Path(__file__).resolve().parents[1]
ROOT=SERVER.parent
RELEASE=SERVER/'deployments/stock-check-batch-20261015'
OUT=SERVER/'test-artifacts/stock-check-batch'
APP='mbbs-operator-app-app-1'
DEPS=['mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']
IMAGE='mbbs-operator-app:stock-check-batch-20261015'
FILES=['src/stock-check/ollama-matching.js']
spec=importlib.util.spec_from_file_location('release_helpers',SERVER/'tools/mbr-equipment-release.py')
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
spec=importlib.util.spec_from_file_location('activity_helpers',SERVER/'tools/stock-check-release.py')
activity=importlib.util.module_from_spec(spec);spec.loader.exec_module(activity)

def docker(*args,data=None):
    return subprocess.check_output(['sudo','-n','docker',*args],input=data)

def save(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2)+'\n')

def hashes(folder):
    return {str(path.relative_to(folder)):hashlib.sha256(path.read_bytes()).hexdigest()
            for path in folder.rglob('*') if path.is_file()}

def live_hashes():
    code="""const fs=require('fs'),path=require('path'),crypto=require('crypto'),hashes={};
    function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else if(e.isFile())hashes[q.replace('/app/','')]=crypto.createHash('sha256').update(fs.readFileSync(q)).digest('hex')}}
    for(const p of ['src','public','migrations'])walk('/app/'+p);for(const p of ['package.json','package-lock.json'])hashes[p]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex');console.log(JSON.stringify(hashes));"""
    return json.loads(docker('exec',APP,'node','-e',code))

def prepare():
    os.umask(0o077);RELEASE.mkdir(parents=True,exist_ok=True);OUT.mkdir(parents=True,exist_ok=True)
    state_path=RELEASE/'state.json'
    if state_path.exists():
        state=json.loads(state_path.read_text())
        current=helpers.metadata(APP)
        if current!=state['app']:
            published=json.loads((OUT/'deployment.json').read_text())
            assert current['imageId']==published['imageId'],'Production changed; recapture before preparing.'
            previous=json.loads((RELEASE/'prepared.json').read_text())
            assert live_hashes() in [json.loads((RELEASE/'candidate-source.json').read_text()),previous['liveSourceHashes']]
    else:
        state={'app':helpers.metadata(APP),'dependencies':{name:helpers.metadata(name) for name in DEPS}}
        before=RELEASE/'before';before.mkdir()
        for name in ['src','public','migrations','package.json','package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp',APP+':/app/'+name,'-'))) as archive:
                archive.extractall(before,filter='data')
        assert helpers.metadata(APP)==state['app'],'Production changed during capture.'
        state['sourceHashes']=hashes(before);assert state['sourceHashes']==live_hashes()
        save(state_path,state)
    candidate=RELEASE/'candidate'
    if not candidate.exists():shutil.copytree(RELEASE/'before',candidate)
    context=RELEASE/'context';context.mkdir(exist_ok=True);patch=[]
    for name in FILES:
        target=candidate/name
        shutil.copy2(SERVER/name,target)
        destination=context/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,destination)
        patch.extend(difflib.unified_diff(((RELEASE/'before'/name).read_text() if (RELEASE/'before'/name).exists() else '').splitlines(True),target.read_text().splitlines(True),fromfile='production/'+name,tofile='candidate/'+name))
    candidate_hashes=hashes(candidate)
    changed=sorted(name for name,value in candidate_hashes.items() if state['sourceHashes'].get(name)!=value)
    assert changed==sorted(FILES),changed
    save(RELEASE/'candidate-source.json',candidate_hashes);(OUT/'production.patch').write_text(''.join(patch))
    (context/'Dockerfile').write_text('FROM '+state['app']['imageId']+'\n'+''.join('COPY --chown=node:node '+name+' /app/'+name+'\n' for name in FILES))
    with (OUT/'build.log').open('w') as log:
        subprocess.run(['sudo','-n','env','DOCKER_BUILDKIT=0','docker','build','--network=none',
                        '--cgroup-parent=mbbs-tests.slice','--memory=2g','--memory-swap=2g',
                        '--cpu-period=100000','--cpu-quota=100000','--rm','--force-rm',
                        '-t',IMAGE,str(context)],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
    image_id=docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
    save(RELEASE/'prepared.json',{'imageId':image_id,'changed':changed,'baseline':helpers.metadata(APP),'liveSourceHashes':live_hashes()})
    save(RELEASE/'compose.release.json',{'services':{'app':{'image':IMAGE}}})
    rollback='mbbs-operator-app:stock-check-batch-rollback-20261015'
    docker('tag',helpers.metadata(APP)['imageId'],rollback)
    save(RELEASE/'compose.rollback.json',{'services':{'app':{'image':rollback}}})
    print(json.dumps({'prepared':True,'imageId':image_id,'changed':changed}))

def model_contract(path):
    source=path.read_text()
    return {'instructions':re.search(r'const instructions=`(.*?)`;',source,re.S).group(1),
            'options':re.search(r'options:(\{[^}]+\})',source).group(1),
            'defaults':re.search(r'export function createOllamaMatcher\((.*?)\) \{',source,re.S).group(1)}

def deploy():
    state=json.loads((RELEASE/'state.json').read_text());prepared=json.loads((RELEASE/'prepared.json').read_text())
    assert helpers.metadata(APP)==prepared['baseline'] and live_hashes()==prepared['liveSourceHashes'],'Production changed; rebase this release.'
    assert {name:helpers.metadata(name) for name in DEPS}==state['dependencies']
    assert hashes(RELEASE/'candidate')==json.loads((RELEASE/'candidate-source.json').read_text())
    assert docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()==prepared['imageId']
    assert 'Isolated Stock Check run passed:' in (OUT/'final-batch.log').read_text()
    assert (OUT/'final-batch-cleanup.log').exists()
    assert 'Healthy' in (OUT/'boot-batch.log').read_text()
    validation=json.loads((OUT/'validation.json').read_text());assert validation['passed'] and validation['imageId']==prepared['imageId']
    history=json.loads((OUT/'history-assessment.json').read_text());assert history['total']>=2 and history['incorrectAuto']==0 and history['combinedBatchPassed']
    assert model_contract(RELEASE/'candidate/src/stock-check/ollama-matching.js')==model_contract(RELEASE/'before/src/stock-check/ollama-matching.js'),'Model, instructions and inference settings must remain unchanged.'
    assert 'error' not in (OUT/'static-batch-final.log').read_text().lower()
    assert 'error TS' not in (OUT/'static-batch-final-types.log').read_text()
    assert 'Secret scan passed' in (OUT/'static-batch-final-secrets.log').read_text()
    current_activity=activity.active();save(OUT/'active-before.json',current_activity)
    assert not any(current_activity.values()),'Wait for active business operations before replacing the app.'
    try:
        with (OUT/'publish.log').open('w') as log:
            subprocess.run(helpers.compose(state,RELEASE/'compose.release.json')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        assert helpers.health(),'Application health failed.'
        assert helpers.metadata(APP)['imageId']==prepared['imageId']
        assert helpers.metadata(APP)['configurationHash']==state['app']['configurationHash']
        assert live_hashes()==json.loads((RELEASE/'candidate-source.json').read_text())
        assert {name:helpers.metadata(name) for name in DEPS}==state['dependencies']
    except BaseException:
        with (OUT/'rollback.log').open('w') as log:
            subprocess.run(helpers.compose(state,RELEASE/'compose.rollback.json')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        assert helpers.health(),'Rollback did not recover application health.'
        raise
    result={'deployed':True,'healthy':True,'onlyAppChanged':True,'changed':prepared['changed'],'imageId':prepared['imageId'],'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    save(OUT/'deployment.json',result);print(json.dumps(result))

if __name__=='__main__':
    {'prepare':prepare,'deploy':deploy}[sys.argv[1]]()

"""Release only the verified local closure path over the current app image."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

SERVER=Path(__file__).resolve().parents[1]
ROOT=SERVER.parent
OUT=SERVER/'test-artifacts/special-local-closure'
RELEASE=SERVER/'deployments/special-local-closure-20260930'
APP='mbbs-operator-app-app-1'
FILES=['src/special-stock-closed-orders.js','src/special-stock-closure-service.js','src/special-stock-request-repository.js']
IMAGE='mbbs-operator-app:special-local-closure-20260930'
DEPENDENCIES=['mbbs-operator-app-db-1','mbbs-operator-app-ollama-1','mbbs-operator-app-webhook-worker-1']
spec=importlib.util.spec_from_file_location('release_core',SERVER/'tools/regular-stock-v2-deploy.py')
release=importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE,release.CONTAINERS,release.DEPENDENCIES=RELEASE,{'app':APP},DEPENDENCIES
docker,digest,metadata=release.docker,release.digest,release.metadata
HASH_SCRIPT="""const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
 if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

def save(name,value):
    (RELEASE/name).write_text(json.dumps(value,indent=2)+'\n')

def state():
    return json.loads((RELEASE/'manifest.json').read_text())

def evidence():
    summary=json.loads((OUT/'summary.json').read_text())
    assert summary['completed'] and summary['newFailures']==0
    assert summary['tests']==summary['passed']+len(summary['baselineFailures'])
    hashes=json.loads((OUT/'source-manifest.json').read_text())
    assert all(digest((OUT/'candidate'/file).read_bytes())==hashes[file] for file in FILES),'Tested closure candidate changed'
    return {file:hashes[file] for file in FILES}

def current(data):
    assert metadata(APP)==data['services']['app']['before'],'App changed during preparation'
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies'],'Dependency changed'
    assert evidence()==data['sourceHashes']
    for file,sha in data['beforeHashes'].items():
        assert digest(docker('exec',APP,'cat','/app/'+file))==sha,'Closure source changed: '+file

def prepare():
    hashes=evidence()
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before=metadata(APP)
    previous={}
    for file in FILES:
        baseline=OUT/'baseline'/file
        if baseline.exists():
            previous[file]=digest(baseline.read_bytes())
            assert digest(docker('exec',APP,'cat','/app/'+file))==previous[file],'Live closure baseline changed: '+file
        else:
            docker('exec',APP,'test','!','-e','/app/'+file)
    data={'services':{'app':{'before':before,'image':IMAGE}},'sourceHashes':hashes,'beforeHashes':previous,
          'dependencies':{name:metadata(name) for name in DEPENDENCIES}}
    current(data)
    shutil.copytree(OUT/'baseline',RELEASE/'before')
    stage=RELEASE/'stage'
    for file in FILES:
        (stage/'overlay'/file).parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(OUT/'candidate'/file,stage/'overlay'/file)
    base=IMAGE+'-base'
    docker('tag',before['imageId'],base)
    assert docker('image','inspect','--format','{{.Id}}',base).decode().strip()==before['imageId']
    (stage/'Dockerfile').write_text('FROM '+base+'\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE/'build.log').open('wb') as log:
        subprocess.run(['sudo','-n','docker','build','--network','none','--pull=false','-t',IMAGE,str(stage)],
                       stdout=log,stderr=subprocess.STDOUT,check=True)
    data['services']['app']['candidateImageId']=docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
    expected=json.loads(docker('exec',APP,'node','-e',HASH_SCRIPT))
    expected.update(hashes)
    actual=json.loads(docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'-e',HASH_SCRIPT))
    assert actual==expected,'Unexpected source change in image'
    save('source-tree.json',expected)
    docker('run','--rm','--network','none','-e','MBBS_ENV_FILE=/nonexistent','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e','NETSUITE_MIRROR_ROLE=disabled','--entrypoint','node',IMAGE,'--input-type=module','-e',
           "await import('./src/server.js');process.exit(0)")
    (RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+IMAGE+'\n')
    (RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+before['imageId']+'\n')
    release.config_check(data)
    current(data)
    save('manifest.json',data)
    print(json.dumps({'prepared':True,'files':FILES,'verifiedImageFiles':len(expected)}),flush=True)

def verify():
    data=state()
    release.core.ready(data['services']['app']['candidateImageId'])
    after=metadata(APP)
    assert after['imageId']==data['services']['app']['candidateImageId']
    assert after['configuration']==data['services']['app']['before']['configuration']
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies']
    assert json.loads(docker('exec',APP,'node','-e',HASH_SCRIPT))==json.loads((RELEASE/'source-tree.json').read_text())
    public={}
    for origin in ['http://127.0.0.1:3000','https://test.mbbsoperation.com']:
        request=urllib.request.Request(origin+'/health',headers={'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(request,timeout=30) as response:
            assert response.status==200 and json.loads(response.read())['ok'] is True
            public[origin]=200
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'imageId':after['imageId'],
            'configurationPreserved':True,'workerAndDependenciesUnchanged':True,'schemaChanged':False,
            'files':FILES,'health':public}
    save('result.json',result)
    print(json.dumps(result),flush=True)

def apply():
    data=state()
    current(data)
    release.config_check(data)
    active=json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'closureApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE closure_review->>'status'='applying'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json',active)
    assert not any(active.values()),'Wait for active operations: '+json.dumps(active)
    current(data)
    try:
        with (RELEASE/'publish.log').open('wb') as log:
            subprocess.run(release.compose(data)+['up','-d','--no-build','--no-deps','--pull','never','app'],
                           cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except Exception:
        with (RELEASE/'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],
                           cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json',{'rolledBack':True})
        raise

if __name__=='__main__':
    {'prepare':prepare,'apply':apply,'verify':verify}[sys.argv[1]]()

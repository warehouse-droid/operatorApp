"""Publish the verified confirmed SO routing and precise quantity errors as a scoped app overlay."""
import datetime
import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
SERVER=ROOT/'server'
OUT=SERVER/'test-artifacts/regular-stock-confirmation'
RELEASE=SERVER/'deployments/regular-stock-confirmation-v2-20260929'
FILES=json.loads((SERVER/'tools/regular-stock-confirmation-files.json').read_text())
IMAGE='mbbs-operator-app:regular-stock-confirmation-v2-20260929'
APP='mbbs-operator-app-app-1'
DEPENDENCIES=['mbbs-operator-app-db-1','mbbs-operator-app-ollama-1','mbbs-operator-app-webhook-worker-1']
spec=importlib.util.spec_from_file_location('regular_release',SERVER/'tools/regular-stock-v2-deploy.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
release.RELEASE=RELEASE;release.CONTAINERS={'app':APP};release.DEPENDENCIES=DEPENDENCIES
docker,digest,metadata=release.docker,release.digest,release.metadata

def save(name,value): (RELEASE/name).write_text(json.dumps(value,indent=2)+'\n')
def state(): return json.loads((RELEASE/'manifest.json').read_text())

HASH_SCRIPT="""const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
 if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""

def current(data):
    assert metadata(APP)==data['services']['app']['before'],'Live application changed'
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies'],'Dependency changed'
    for file,sha in data['beforeHashes'].items():
        assert digest(docker('exec',APP,'cat','/app/'+file))==sha,'Live source changed: '+file
    assert {file:digest((SERVER/file).read_bytes()) for file in FILES}==data['sourceHashes'],'Verified source changed'

def prepare():
    os.umask(0o077)
    checks=json.loads((OUT/'checks.json').read_text())
    assert checks['sourceHashes']=={file:digest((SERVER/file).read_bytes()) for file in FILES}
    assert checks['tests']==checks['passed'] and all(row['exitCode']==0 for row in checks['layers'])
    assert all(row['exitCode']==0 for row in json.loads((OUT/'gauntlet.json').read_text()))
    assert json.loads((OUT/'changed-lines.json').read_text())['complete']
    assert all(not row['newFailures'] for row in json.loads((OUT/'regular-stock-v2/tests-results.json').read_text()))
    RELEASE.mkdir(exist_ok=False)
    baseline=json.loads((SERVER/'tools/regular-stock-confirmation-baseline.json').read_text())
    before=metadata(APP)
    data={'services':{'app':{'before':before,'image':IMAGE}},'sourceHashes':checks['sourceHashes'],
          'beforeHashes':baseline['files'],'dependencies':{name:metadata(name) for name in DEPENDENCIES}}
    current(data)
    shutil.copytree(OUT/'before',RELEASE/'before')
    shutil.copy2(SERVER/'test/regular-stock-confirmation.changes.patch',RELEASE/'release.patch')
    directory=RELEASE/'stage'
    for file in FILES:
        (directory/file).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(SERVER/file,directory/file)
    base_image='mbbs-operator-app:regular-stock-line-routing-20260929'
    assert docker('image','inspect','--format','{{.Id}}',base_image).decode().strip()==before['imageId']
    (directory/'Dockerfile').write_text('FROM '+base_image+'\n'+''.join('COPY --chown=node:node '+file+' /app/'+file+'\n' for file in FILES))
    with (RELEASE/'build.log').open('wb') as log:
        subprocess.run(['sudo','-n','docker','build','--network','none','--pull=false','-t',IMAGE,str(directory)],stdout=log,stderr=subprocess.STDOUT,check=True)
    data['services']['app']['candidateImageId']=docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
    expected=json.loads(docker('exec',APP,'node','-e',HASH_SCRIPT));expected.update(data['sourceHashes'])
    actual=json.loads(docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'-e',HASH_SCRIPT))
    assert actual==expected,'Image includes an unexpected source change'
    save('source-tree.json',expected)
    for file in FILES:
        if file.endswith('.js'):docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'--check',file)
    docker('run','--rm','--network','none','-e','MBBS_ENV_FILE=/nonexistent','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false',
        '-e','NETSUITE_MIRROR_ROLE=disabled','--entrypoint','node',IMAGE,'--input-type=module','-e',"await import('./src/server.js');process.exit(0)")
    (RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+IMAGE+'\n')
    (RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+before['imageId']+'\n')
    release.config_check(data);current(data);save('manifest.json',data)
    print(json.dumps({'prepared':True,'image':IMAGE,'sourceFilesChanged':len(FILES),'sourceTreeFilesVerified':len(expected)}),flush=True)

def probe(reference):
    result=json.loads(docker('exec','-i',APP,'node','--input-type=module','-',reference,
        input=(SERVER/'tools/regular-stock-header-live.mjs').read_bytes()))
    save('live-'+reference+'.json',result)
    return result['result']


def verify():
    data=state();row=data['services']['app'];release.core.ready(row['candidateImageId'])
    after=metadata(APP)
    assert after['imageId']==row['candidateImageId'] and after['configuration']==row['before']['configuration']
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies']
    assert json.loads(docker('exec',APP,'node','-e',HASH_SCRIPT))==json.loads((RELEASE/'source-tree.json').read_text())
    import urllib.request
    public={}
    for file in ['health','public/sales-stock-requests.html','public/sales-stock-requests.js','public/regular-stock-ui.js']:
        path='/sales/stock-requests' if file.endswith('.html') else '/'+file.removeprefix('public/')
        request=urllib.request.Request('https://test.mbbsoperation.com'+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
        with urllib.request.urlopen(request,timeout=30) as response:
            body=response.read();assert response.status==200
            if file=='health':assert json.loads(body)['ok'] is True
            if file.endswith('.html'):
                body=re.sub(rb'<script type="module" src="https://static\.cloudflareinsights\.com/beacon\.min\.js/[^>]+></script>\n',b'',body)
            if file in FILES:assert digest(body)==data['sourceHashes'][file],file
            public[path]={'status':response.status,'sha256':digest(body)}
    save('public-check.json',public)
    order=probe('SOB121631');assert order['ok'],order
    snapshot=json.loads((RELEASE/'live-SOB121631.json').read_text())['routingOrder']
    script='globalThis.regularVerifiedOrder='+json.dumps(snapshot)+';\n'+(SERVER/'tools/regular-stock-confirmation-live.mjs').read_text()
    preview=json.loads(docker('exec','-i',APP,'node','--input-type=module',input=script.encode()))
    save('preview.json',preview)
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':IMAGE,'imageId':after['imageId'],
        'configurationPreserved':True,'workerAndDependenciesUnchanged':True,'schemaChanged':False,'sourceFilesChanged':len(FILES),
        'reportedOrder':order,'preview':preview,'netSuiteOrderWrites':0}
    save('result.json',result);print(json.dumps(result),flush=True)


def rebase_after_rollback():
    data=state();before=metadata(APP);previous=data['services']['app']['before']
    assert before['imageId']==previous['imageId'] and before['configuration']==previous['configuration']
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies']
    data.setdefault('priorCutoverOrigins',[]).append(previous)
    data['services']['app']['before']=before;current(data);save('manifest.json',data)
    print(json.dumps({'rebasedAfterRollback':True,'runtimeChangesSinceValidation':False}),flush=True)

def apply():
    data=state();current(data);release.config_check(data)
    active=json.loads(release.database("""SELECT json_build_object(
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json',active);assert not any(active.values()),'Wait for active operations: '+json.dumps(active)
    try:
        with (RELEASE/'publish.log').open('wb') as log:
            subprocess.run(release.compose(data)+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except Exception:
        with (RELEASE/'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json',{'rolledBack':True})
        raise

if __name__=='__main__': {'prepare':prepare,'apply':apply,'verify':verify,'rebase-after-rollback':rebase_after_rollback}[sys.argv[1]]()

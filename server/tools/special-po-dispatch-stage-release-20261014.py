"""Release only the tested PO-reference stage changes, with view and image rollback."""
import difflib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
REPO = SERVER.parent
OUT = SERVER / 'test-artifacts/special-po-dispatch-stage-20261014'
RELEASE = SERVER / 'deployments/special-po-dispatch-stage-20261014'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:special-po-dispatch-stage-20261014'
BASE = 'mbbs-operator-app:special-po-dispatch-stage-rollback-20261014'
MIGRATION = '289_special_po_dispatch_stage.sql'
FILES = ['public/special-stock-workflow.js','public/backorder-workflow.js','public/backorder-stock-requests.js',
         'src/special-stock-request-repository.js','src/backorder-request-service.js']
spec = importlib.util.spec_from_file_location('release_helpers', SERVER / 'tools/mbr-equipment-release.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

def save(name,value):
    (RELEASE / name).write_text(json.dumps(value,indent=2)+'\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def current(state):
    assert helpers.metadata(APP) == state['app'], 'Live app changed; prepare and validate its current image'
    assert {name:helpers.metadata(name) for name in DEPENDENCIES} == state['dependencies']

def prepare():
    RELEASE.mkdir(parents=True,exist_ok=True)
    state={'app':helpers.metadata(APP),'dependencies':{name:helpers.metadata(name) for name in DEPENDENCIES}}
    save('state.json',state)
    archive=subprocess.check_output(['sudo','-n','docker','exec',APP,'tar','-C','/app','-cf','-',
        'src','public','migrations','package.json','package-lock.json','netsuite-smart-scm-picking-ticket-restlet.js'])
    code=RELEASE/'candidate-code'
    if code.exists():shutil.rmtree(code)
    code.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(code,filter='data')
    context=RELEASE/'context'
    if context.exists():shutil.rmtree(context)
    context.mkdir()
    patch=[]
    for filename in FILES:
        baseline=OUT/'before'/filename
        live=code/filename
        # Exact equality makes this a narrow overlay, preserving unrelated live work.
        assert sha(live)==sha(baseline), 'Rebase this file before publishing: '+filename
        patch.extend(difflib.unified_diff(live.read_text().splitlines(True),(SERVER/filename).read_text().splitlines(True),
            fromfile='a/'+filename,tofile='b/'+filename))
        shutil.copyfile(SERVER/filename,live)
        target=context/filename;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(live,target)
    target=context/'migrations'/MIGRATION;target.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(SERVER/'migrations'/MIGRATION,target);shutil.copyfile(target,code/'migrations'/MIGRATION)
    (RELEASE/'release.patch').write_text(''.join(patch))
    rollback=''
    for view in ['special_stock_completion_evidence','special_stock_workflow_stages']:
        rollback+='CREATE OR REPLACE VIEW '+view+' AS\n'+helpers.db("SELECT pg_get_viewdef('"+view+"'::regclass,true)")+'\n'
    rollback+='DROP VIEW IF EXISTS special_stock_purchase_dispatch_state;\n'
    (RELEASE/'views.rollback.sql').write_text(rollback)
    current(state)
    helpers.docker('tag',state['app']['imageId'],BASE)
    (context/'Dockerfile').write_text('FROM '+BASE+'\nCOPY --chown=node:node public/ /app/public/\nCOPY --chown=node:node src/ /app/src/\nCOPY --chown=node:node migrations/ /app/migrations/\n')
    with (OUT/'candidate-build.log').open('w') as log:
        subprocess.run(['sudo','-n','docker','build','--network=none','--pull=false','-t',IMAGE,str(context)],stdout=log,stderr=subprocess.STDOUT,check=True)
    hashes={name:sha(context/name) for name in FILES+['migrations/'+MIGRATION]}
    save('manifest.json',{'imageId':helpers.docker('image','inspect','--format','{{.Id}}',IMAGE),'baseImageId':state['app']['imageId'],'hashes':hashes})
    save('compose.release.json',{'services':{'app':{'image':IMAGE,'pull_policy':'never'}}})
    save('compose.rollback.json',{'services':{'app':{'image':BASE,'pull_policy':'never'}}})
    current(state)
    print(json.dumps({'prepared':True,'files':list(hashes),'candidateCode':str(code)}),flush=True)

def verify():
    state=json.loads((RELEASE/'state.json').read_text());manifest=json.loads((RELEASE/'manifest.json').read_text())
    assert helpers.health()
    app=helpers.metadata(APP)
    assert app['imageId']==manifest['imageId'] and app['configurationHash']==state['app']['configurationHash']
    assert {name:helpers.metadata(name) for name in DEPENDENCIES}==state['dependencies']
    for name,value in manifest['hashes'].items():assert helpers.docker('exec',APP,'sha256sum','/app/'+name).split()[0]==value,name
    script="""import {query,closeDb} from './src/db.js';import {getSpecialStockCase,listSpecialStockCases} from './src/special-stock-request-repository.js';
    try{const rows=(await query("SELECT id,request_ref FROM sales_stock_requests WHERE request_ref ~ 'SPREQ-0*(51|52)$' ORDER BY id")).rows;
    const results=[];for(const row of rows){const d=await getSpecialStockCase(row.id,{audience:'scm'});
      const sql=(await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[row.id])).rows[0].stage;
      const found=(await listSpecialStockCases({audience:'scm',stages:['confirmed'],search:d.requestRef})).some(r=>r.id===d.id);
      results.push({requestRef:d.requestRef,stage:d.stage,sqlStage:sql,confirmedFilter:found,purchaseOrderReference:d.purchaseOrderReference,purchaseOrderDispatchStatus:d.purchaseOrderDispatchStatus});}
    console.log(JSON.stringify(results));}finally{await closeDb()}"""
    result=json.loads(helpers.docker('exec','-i',APP,'node','--input-type=module',data=script.encode()))
    assert len(result)==2 and all(r['stage']==r['sqlStage']=='confirmed' and r['confirmedFilter'] and not r['purchaseOrderReference'] for r in result),result
    (OUT/'live-verification.json').write_text(json.dumps({'healthy':True,'configurationPreserved':True,'otherServicesPreserved':True,'requests':result},indent=2)+'\n')
    print(json.dumps({'deployed':True,'healthy':True,'requests':result}),flush=True)

def deploy():
    state=json.loads((RELEASE/'state.json').read_text());manifest=json.loads((RELEASE/'manifest.json').read_text())
    assert all(value==0 for value in json.loads((OUT/'checks.json').read_text()).values())
    cleanup=json.loads((OUT/'cleanup.json').read_text())
    assert cleanup['productionHealthy'] and not any(cleanup[key].strip() for key in ['containers','networks','volumes'])
    for filename in manifest['hashes']:
        assert sha(RELEASE/'candidate-code'/filename)==sha(SERVER/filename)==manifest['hashes'][filename]
    assert helpers.docker('image','inspect','--format','{{.Id}}',IMAGE)==manifest['imageId']
    current(state)
    active=helpers.db("SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating' OR quantity_review->>'status'='applying'")
    assert active=='0','Wait for active request operations before switching the app'
    migrated=False
    try:
        sql='BEGIN; SET LOCAL lock_timeout=\'5s\'; SET LOCAL statement_timeout=\'30s\';\n'+(RELEASE/'context/migrations'/MIGRATION).read_text()
        sql+="\nINSERT INTO schema_migrations(filename) VALUES('"+MIGRATION+"'); COMMIT;"
        helpers.db(sql);migrated=True
        with (OUT/'production-publish.log').open('w') as log:
            subprocess.run(helpers.compose(state,RELEASE/'compose.release.json')+['up','-d','--no-deps','--no-build','--pull','never','app'],cwd=REPO,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except BaseException:
        if migrated:
            helpers.db('BEGIN;\n'+(RELEASE/'views.rollback.sql').read_text()+"\nDELETE FROM schema_migrations WHERE filename='"+MIGRATION+"'; COMMIT;")
        with (OUT/'production-rollback.log').open('w') as log:
            subprocess.run(helpers.compose(state,RELEASE/'compose.rollback.json')+['up','-d','--no-deps','--no-build','--pull','never','app'],cwd=REPO,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        assert helpers.health();raise

if __name__=='__main__':{'prepare':prepare,'deploy':deploy,'verify':verify}[sys.argv[1]]()

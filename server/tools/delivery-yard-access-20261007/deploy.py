"""Publish only the verified Delivery overlay and preserve a rollback image."""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

SERVER = Path(__file__).resolve().parents[2]
OUT = SERVER / 'test-artifacts/delivery-yard-access-20261007'
RELEASE = Path('/home/ubuntu/operatorapp-investigations/delivery-yard-access-20261007/release')
APP = 'mbbs-operator-app-app-1'
OTHERS = ['mbbs-operator-app-db-1','mbbs-operator-app-webhook-worker-1','mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:delivery-yard-lines-20261007'
BASE = 'mbbs-operator-app:delivery-yard-lines-20261007-rollback'

def sha(value):
    return hashlib.sha256(value).hexdigest()

def docker(*args, input=None):
    return subprocess.check_output(['docker', *args], input=input, stderr=subprocess.PIPE)

def metadata(name):
    row=json.loads(docker('inspect',name))[0]
    config={'Env':sorted(row['Config']['Env']),'Cmd':row['Config']['Cmd'],'Entrypoint':row['Config']['Entrypoint'],
            'HostConfig':row['HostConfig'],'Mounts':sorted(row['Mounts'],key=lambda mount:mount['Destination'])}
    config['HostConfig']['Binds']=sorted(config['HostConfig'].get('Binds') or [])
    return {'image':row['Image'],'configHash':sha(json.dumps(config,sort_keys=True).encode())}

def compose(state,override):
    labels=state['compose']
    args=['docker','compose','--project-name',labels['com.docker.compose.project'],
          '--project-directory',labels['com.docker.compose.project.working_dir']]
    if labels.get('com.docker.compose.project.environment_file'):
        args+=['--env-file',labels['com.docker.compose.project.environment_file']]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        args+=['-f',file]
    return args+['-f',str(override)]

def packaged_probe():
    name='mbbs-delivery-yard-lines-package'
    script="""import assert from 'node:assert/strict';
import {app} from './src/server.js';import {closeDb} from './src/db.js';
import {assertDeliveryStockRequestDestinationAccess,canSalesAccessDeliveryRequest} from './src/regular-stock-delivery-access.js';
import {deliveryMaterials} from './src/regular-stock-delivery-domain.js';
assert.equal(typeof app,'function');for(const authorized of [[],[15],[26],[1],[28]]) for(const [source,destination] of [[1,28],[28,1]]) assert.equal(assertDeliveryStockRequestDestinationAccess(source,destination,authorized),destination);
assert.equal(canSalesAccessDeliveryRequest({requestType:'regular',workflowVersion:2,destinationLocationId:1,regular:{deliveryMethod:'delivery',deliveryVersion:1,sourceLocationId:28}},[28]),true);
const a={remoteLineId:1,itemId:100,locationId:1,quantity:100,backorderedQuantity:10,uom:'EA',open:true};
assert.deepEqual(deliveryMaterials({id:1,ref:'synthetic-package',lines:[a,{...a,remoteLineId:2}]},1,[2]).map(line=>line.remoteLineId),[2]);
await closeDb();console.log(JSON.stringify({packagedImports:true,pairedTargetAccess:true,checkedLinesOnly:true}));"""
    args=['docker','run','--rm','--name',name,'--init','--network=none','--read-only','--cgroup-parent=mbbs-tests.slice',
          '--memory=512m','--memory-swap=512m','--pids-limit=128','--cpus=1',
          '--tmpfs','/tmp:uid=1000,gid=1000,size=64m','--tmpfs','/app/data:uid=1000,gid=1000,size=16m',
          '--label','com.mbbs.lifecycle=disposable-test','--label','com.mbbs.task='+name,
          '-e','NODE_ENV=test','-e','MBBS_ENV_FILE=.env.mbt-test-does-not-exist',
          '-e','DATABASE_URL=postgres://mbt_test:mbt_test_password@127.0.0.1:9/mbt_test',
          '-e','NETSUITE_DIRECT_ACCESS_ENABLED=false','-e','MBT_NETSUITE_WRITES_ENABLED=false',
          '--entrypoint','node',IMAGE,'--input-type=module','-e',script]
    try:
        with (OUT/'packaged-probe.log').open('wb') as log:
            subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=45)
    finally:
        ids=docker('ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}').decode().split()
        if ids:docker('rm','-f','-v',*ids)
        status={key:docker('ps',*extra,'--filter','label=com.mbbs.task='+name,'--format','{{.Names}}').decode().strip()
                for key,extra in [('dockerPs',()),('dockerPsA',('-a',))]}
        (OUT/'packaged-cleanup.json').write_text(json.dumps(status,indent=2));assert not any(status.values())

def prepare():
    evidence=json.loads((OUT/'evidence.json').read_text())
    assert evidence['newFailures']==[] and evidence['focused']['fail']==0 and evidence['focused']['tests']>0
    assert evidence['types']==evidence['lint']==evidence['secrets']=='pass'
    assert all(value['killed'] for value in evidence['mutations'])
    assert evidence['changedLines']['covered']==evidence['changedLines']['total']
    original=json.loads(docker('inspect',APP))[0]
    state={**metadata(APP),'compose':{key:value for key,value in original['Config']['Labels'].items() if key.startswith('com.docker.compose.project')}}
    RELEASE.mkdir(parents=True,exist_ok=True)
    (RELEASE/'state.json').write_text(json.dumps(state,indent=2))
    for file,expected in evidence['manifest'].items():
        candidate=(SERVER/file).read_bytes();assert sha(candidate)==expected,'Tested source changed '+file
        baseline=SERVER/'tools/delivery-yard-access-20261007/baseline'/file
        assert baseline.read_bytes()==docker('exec',APP,'cat','/app/'+file),'Live baseline changed '+file
        target=RELEASE/'overlay'/file;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(candidate)
    assert metadata(APP)=={key:state[key] for key in ['image','configHash']}
    docker('tag',state['image'],BASE)
    (RELEASE/'Dockerfile').write_text('FROM '+BASE+'\n'+''.join('COPY --chown=node:node overlay/'+file+' /app/'+file+'\n' for file in evidence['manifest']))
    (RELEASE/'compose.release.yml').write_text('services:\n  app:\n    image: '+IMAGE+'\n    pull_policy: never\n')
    (RELEASE/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+BASE+'\n    pull_policy: never\n')
    with (OUT/'build.log').open('wb') as log:
        subprocess.run(['docker','build','--network=none','--pull=false','-t',IMAGE,str(RELEASE)],stdout=log,stderr=subprocess.STDOUT,check=True)
    packaged_probe()
    service=json.loads(subprocess.check_output(compose(state,RELEASE/'compose.release.yml')+['config','--format','json'],stderr=subprocess.PIPE))['services']['app']
    environment=dict(value.split('=',1) for value in original['Config']['Env'])
    assert all(environment.get(key)==str(value) for key,value in service.get('environment',{}).items()),'Environment drift'
    manifest={'candidateImage':docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip(),
              'baseImage':state['image'],'files':evidence['manifest'],'evidenceHash':sha((OUT/'evidence.json').read_bytes())}
    (RELEASE/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps({'prepared':True,'environmentPreserved':True,'files':len(manifest['files']),'image':manifest['candidateImage']}),flush=True)

def verify():
    state=json.loads((RELEASE/'state.json').read_text());manifest=json.loads((RELEASE/'manifest.json').read_text())
    assert metadata(APP)=={'image':manifest['candidateImage'],'configHash':state['configHash']}
    assert all(sha(docker('exec',APP,'cat','/app/'+file))==expected for file,expected in manifest['files'].items())
    probe=(SERVER/'tools/delivery-yard-access-20261007/verify-live.mjs').read_text().replace('../../src/','./src/')
    result=json.loads(docker('exec','-i','-w','/app',APP,'node','--input-type=module',input=probe.encode()))
    (OUT/'deployed.json').write_text(json.dumps({'image':manifest['candidateImage'],'configurationPreserved':True,**result},indent=2))
    print(json.dumps({'deployed':True,**result}),flush=True)

def apply():
    state=json.loads((RELEASE/'state.json').read_text())
    assert metadata(APP)=={key:state[key] for key in ['image','configHash']},'Production changed; prepare a new baseline'
    dependencies={name:metadata(name) for name in OTHERS}
    script="""import {query,closeDb} from './src/db.js';try{console.log(JSON.stringify((await query(`SELECT json_build_object(
'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
'stockingExecuting',(SELECT count(*) FROM sales_stock_requests WHERE regular_details->'pickupTransfer'->>'status'='executing'),
'deliveryExecuting',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
'webhooks',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running' AND lease_expires_at>now())) AS counts`)).rows[0].counts));}finally{await closeDb();}"""
    active=json.loads(docker('exec','-i','-w','/app',APP,'node','--input-type=module',input=script.encode()))
    (OUT/'active-before.json').write_text(json.dumps(active,indent=2));assert not any(active.values()),'Active work must finish '+json.dumps(active)
    try:
        with (OUT/'publish.log').open('wb') as log:
            subprocess.run(compose(state,RELEASE/'compose.release.yml')+['up','-d','--no-deps','--no-build','--pull','never','app'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        for _attempt in range(20):
            if docker('inspect','--format','{{.State.Health.Status}}',APP).decode().strip()=='healthy':break
            time.sleep(2)
        assert docker('inspect','--format','{{.State.Health.Status}}',APP).decode().strip()=='healthy'
        verify();assert dependencies=={name:metadata(name) for name in OTHERS},'Other production services changed'
    except BaseException:
        with (OUT/'rollback.log').open('wb') as log:
            subprocess.run(compose(state,RELEASE/'compose.rollback.yml')+['up','-d','--no-deps','--no-build','--pull','never','app'],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        raise

if __name__=='__main__':
    {'prepare':prepare,'apply':apply,'verify':verify}[sys.argv[1]]()

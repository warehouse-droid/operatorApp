"""Scoped direct-shipment posting release over the current live image."""
import difflib
import hashlib
import importlib.util
import io
import os
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

SERVER=Path(__file__).resolve().parents[1]
ROOT=SERVER.parent
OUT=SERVER/'test-artifacts/direct-ship-posting-20261001'
RELEASE=SERVER/'deployments/direct-ship-posting-20261001'
APP='mbbs-operator-app-app-1'
DEPENDENCIES=['mbbs-operator-app-webhook-worker-1','mbbs-operator-app-db-1','mbbs-operator-app-ollama-1']
IMAGE='mbbs-operator-app:direct-ship-posting-20261001'
EXISTING=['src/netsuite.js','src/receiving-repository.js','src/operator-netsuite-posting-domain.js',
 'src/operator-netsuite-posting-finalizer.js','src/operator-netsuite-posting-netsuite-adapter.js',
 'src/operator-netsuite-posting-targets.js','src/sales-order-auto-fulfillment-netsuite-adapter.js',
 'src/sales-order-auto-fulfillment-repository.js','src/sales-order-auto-fulfillment-runtime.js',
 'src/sales-order-auto-fulfillment-service.js']
ADDED=['src/netsuite-fulfillable-items.js','src/direct-po-auto-receipt-domain.js','src/direct-po-auto-receipt.js',
 'migrations/253_direct_ship_netsuite_posting.sql']
FILES=sorted(EXISTING+ADDED)
spec=importlib.util.spec_from_file_location('direct_ship_release_core',SERVER/'tools/operator-display-settings-deploy.py')
core=importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
docker,metadata=core.docker,core.metadata
TREE="""import {readdirSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const files={};function visit(path){for(const entry of readdirSync(path,{withFileTypes:true})){
const child=path+'/'+entry.name;if(entry.isDirectory())visit(child);else if(entry.isFile())files[child]=createHash('sha256').update(readFileSync(child)).digest('hex');}}
for(const directory of ['src','public','migrations'])visit(directory);for(const file of ['package.json','package-lock.json'])files[file]=createHash('sha256').update(readFileSync(file)).digest('hex');console.log(JSON.stringify(files));"""

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def save(name,value):(RELEASE/name).write_text(json.dumps(value,indent=2)+'\n')
def state():return json.loads((RELEASE/'manifest.json').read_text())
def current(data):
    assert metadata(APP)==data['before'],'Live image changed; recapture before proceeding'
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies'],'Dependency changed'
    assert {file:digest(SERVER/file) for file in FILES}==data['workspaceHashes'],'Workspace source changed'
    assert {file:digest(RELEASE/'candidate'/file) for file in FILES}==data['sourceHashes'],'Candidate source changed'

def capture():
    RELEASE.mkdir(exist_ok=False)
    data={'before':metadata(APP),'dependencies':{name:metadata(name) for name in DEPENDENCIES},'image':IMAGE,
      'workspaceHashes':{file:digest(SERVER/file) for file in FILES}}
    before=RELEASE/'before';before.mkdir()
    for file in ['src','public','migrations','package.json','package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp',APP+':/app/'+file,'-'))) as archive:
            archive.extractall(before,filter='data')
    data['treeBefore']=json.loads(docker('exec',APP,'node','--input-type=module','-e',TREE))
    candidate=RELEASE/'candidate';shutil.copytree(before,candidate)
    patch=''.join(''.join(difflib.unified_diff((OUT/'baseline'/file).read_text().splitlines(True),
       (SERVER/file).read_text().splitlines(True),fromfile='a/'+file,tofile='b/'+file)) for file in EXISTING)
    (RELEASE/'workspace.patch').write_text(patch)
    result=subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,capture_output=True)
    (RELEASE/'patch.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,'Scoped patch needs rebase; inspect patch.log'
    for file in ADDED:
        assert not (before/file).exists(),'Added file already live: '+file
        (candidate/file).parent.mkdir(parents=True,exist_ok=True);shutil.copy2(SERVER/file,candidate/file)
    for file in candidate.rglob('*.orig'):file.unlink()
    data['sourceHashes']={file:digest(candidate/file) for file in FILES}
    # Testing auxiliaries are never copied into the release image.
    for directory in ['test','tools','contracts']:shutil.copytree(SERVER/directory,candidate/directory)
    for file in ['eslint.mbt.config.js','tsconfig.mbt.json','.c8rc.json']:shutil.copy2(SERVER/file,candidate/file)
    save('manifest.json',data);current(data)
    print(json.dumps({'captured':True,'parent':data['before']['image'],'files':FILES}))

def prepare():
    data=state();current(data)
    checks=json.loads((OUT/'checks.json').read_text())
    assert checks['passed'] and checks['sourceHashes']==data['sourceHashes'],'Exact candidate checks required'
    stage=RELEASE/'stage'
    for file in FILES:
        target=stage/'overlay'/file;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(RELEASE/'candidate'/file,target)
    parent='mbbs-operator-app:direct-ship-parent-'+data['before']['imageId'].removeprefix('sha256:')
    docker('image','tag',data['before']['imageId'],parent);data['parentImage']=parent
    (stage/'Dockerfile').write_text('FROM '+parent+'\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE/'build.log').open('wb') as log:
        subprocess.run(['sudo','-n','docker','build','--network','none','--pull=false','-t',IMAGE,str(stage)],stdout=log,stderr=subprocess.STDOUT,check=True)
    data['imageId']=docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
    actual=json.loads(docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'--input-type=module','-e',TREE))
    assert actual=={**data['treeBefore'],**data['sourceHashes']},'Release changed unrelated files'
    docker('run','--rm','--network','none','-e','MBBS_ENV_FILE=/nonexistent','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false',
      '-e','NETSUITE_MIRROR_ROLE=disabled','--entrypoint','node',IMAGE,'--input-type=module','-e',
      "await import('./src/server.js'); await import('./src/direct-po-auto-receipt.js'); process.exit(0)")
    for kind,image in [('release',IMAGE),('rollback',data['before']['imageId'])]:
        (RELEASE/('compose.'+kind+'.yml')).write_text('services:\n  app:\n    image: '+image+'\n')
    save('manifest.json',data);current(data)
    print(json.dumps({'prepared':True,'image':IMAGE,'scopeVerified':True}))

def adopt_rollback():
    data=state();after=metadata(APP)
    assert after['imageId']==data['before']['imageId'] and after['configuration']==data['before']['configuration'],'Rollback must preserve the prior image and config'
    assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies'],'Dependency changed'
    assert json.loads(docker('exec',APP,'node','--input-type=module','-e',TREE))==data['treeBefore'],'Rollback source changed'
    data.setdefault('initialBefore',data['before']);data['before']=after
    save('manifest.json',data);current(data)
    print(json.dumps({'rollbackVerified':True,'healthyPriorSource':True}))

def migrate():
    data=state();current(data)
    sql=(SERVER/'migrations/253_direct_ship_netsuite_posting.sql').read_text()
    assert sql.startswith('BEGIN;') and sql.rstrip().endswith('COMMIT;')
    sql=sql.replace('BEGIN;','BEGIN;\nSET LOCAL lock_timeout=\'10s\';\nSET LOCAL statement_timeout=\'30s\';',1)
    sql=sql.rsplit('COMMIT;',1)[0]+"INSERT INTO schema_migrations(filename) VALUES('253_direct_ship_netsuite_posting.sql') ON CONFLICT(filename) DO NOTHING;\nCOMMIT;\n"
    output=docker('exec','-i','mbbs-operator-app-db-1','sh','-c',
      'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At -v ON_ERROR_STOP=1',input=sql.encode())
    save('migrated.json',{'applied':True,'migration':'253_direct_ship_netsuite_posting.sql','output':output.decode()})
    print(json.dumps({'migrationApplied':True,'onlyRequestedMigration':True}))

def publish():
    data=state();current(data)
    assert json.loads((OUT/'regression-comparison.json').read_text())['passed'],'No new full-suite regressions required'
    assert json.loads((OUT/'checks.json').read_text())['passed'],'Verified checks required'
    assert json.loads((RELEASE/'migrated.json').read_text())['applied'],'Apply the verified migration before starting the new runtime'
    args=['sudo','-n','docker','compose','--project-directory',str(ROOT),'--env-file',str(ROOT/'docker/env/.env')]
    for file in data['before']['configFiles'].split(','):args.extend(['-f',file])
    try:
        subprocess.run(args+['-f',str(RELEASE/'compose.release.yml'),'up','-d','--no-deps','--no-build','app'],check=True)
        core.ready(data['imageId'])
        after=metadata(APP)
        assert after['configuration']==data['before']['configuration'],'Configuration changed'
        assert {name:metadata(name) for name in DEPENDENCIES}==data['dependencies'],'Dependency changed'
        assert json.loads(docker('exec',APP,'node','--input-type=module','-e',TREE))=={**data['treeBefore'],**data['sourceHashes']}
        assert docker('exec',APP,'node','--input-type=module','-e',"import {query,closeDb} from './src/db.js'; const r=await query(\"SELECT to_regclass('dispatch_direct_po_ir_jobs') IS NOT NULL AS ready\"); console.log(r.rows[0].ready); await closeDb();").decode().strip()=='true'
        save('published.json',{'healthy':True,'scopeVerified':True,'configurationPreserved':True,'after':after})
        print(json.dumps({'published':True,'healthy':True,'image':IMAGE}))
    except Exception:
        subprocess.run(args+['-f',str(RELEASE/'compose.rollback.yml'),'up','-d','--no-deps','--no-build','app'],check=True)
        core.ready(data['before']['imageId']);save('rollback.json',{'rolledBack':True});raise

def preflight():
    data=state();current(data)
    inspected=json.loads(docker('inspect',APP))[0]
    network=next(iter(inspected['NetworkSettings']['Networks']))
    descriptor,name=tempfile.mkstemp(prefix='direct-ship-live-env-',suffix='.env')
    try:
        with os.fdopen(descriptor,'w') as envfile:
            envfile.write('\n'.join(inspected['Config']['Env'])+'\n')
        args=['sudo','-n','docker','run','--rm','-i','--network',network,'--memory=512m','--cpus=1',
          '--env-file',name,'-e','NETSUITE_MIRROR_ROLE=disabled']
        for mount in inspected['Mounts']:
            assert mount['Destination'] not in ['/app/src','/app/public','/app/migrations'],'Source overlays need explicit validation'
            source=mount['Name'] if mount['Type']=='volume' else mount['Source']
            args.extend(['--mount','type='+mount['Type']+',src='+source+',dst='+mount['Destination']+',readonly'])
        args.extend(['--entrypoint','node',IMAGE,'--input-type=module'])
        result=subprocess.run(args,input=(SERVER/'tools/direct-ship-posting-preflight.mjs').read_bytes(),capture_output=True)
        (OUT/'live-preflight.stderr.log').write_bytes(result.stderr)
        (OUT/'live-preflight.stdout.log').write_bytes(result.stdout)
        assert result.returncode==0,'Live candidate preflight failed; inspect evidence'
        records=[]
        for line in result.stdout.decode().splitlines():
            try:records.append(json.loads(line))
            except json.JSONDecodeError:pass
        probe=next(record for record in reversed(records) if record.get('readOnly') is True)
        assert probe['passed']
        (OUT/'live-preflight.json').write_text(json.dumps(probe,indent=2)+'\n')
        print(json.dumps({'passed':True,'readOnly':True,'POs':len(probe['receipts']),'SOs':len(probe['fulfillments'])}))
    finally:os.unlink(name)

if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='recapture':
        import time
        RELEASE.rename(RELEASE.with_name(RELEASE.name+'-capture-'+str(time.time_ns())))
        capture()
    else:{'capture':capture,'prepare':prepare,'adopt_rollback':adopt_rollback,'migrate':migrate,'preflight':preflight,'publish':publish}[mode]()

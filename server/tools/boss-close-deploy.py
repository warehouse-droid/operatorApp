"""Scoped BOSS native rejection / in-app closure confirmation release, over the current live app image only."""
import datetime,difflib,importlib.util,io,json,os,re,shutil,subprocess,sys,tarfile,time
from pathlib import Path
SERVER=Path(__file__).resolve().parents[1]
ROOT=SERVER.parent
RELEASE=SERVER/'deployments/boss-reject-close-20261003'
ARTIFACTS=SERVER/'test-artifacts/boss-reject-close-20261003'
APP='mbbs-operator-app-app-1'
DEPENDENCIES=['mbbs-operator-app-webhook-worker-1','mbbs-operator-app-db-1','mbbs-operator-app-ollama-1']
FILES=sorted(json.loads((SERVER/'tools/boss-close-files.json').read_text()))
IMAGE='mbbs-operator-app:boss-reject-close-20261003'
spec=importlib.util.spec_from_file_location('boss_release',SERVER/'tools/boss-deploy.py')
boss=importlib.util.module_from_spec(spec);spec.loader.exec_module(boss)
core=boss.core;core.RELEASE=RELEASE;core.CONTAINERS={'app':APP}
docker,metadata,digest=boss.docker,boss.metadata,boss.digest

def save(name,data): (RELEASE/name).write_text(json.dumps(data,indent=2)+'\n')
def state(): return json.loads((RELEASE/'manifest.json').read_text())
def database(sql): return boss.database(sql)
def trees(container): return json.loads(docker('exec',container,'node','-e',boss.TREE))
def current(data):
    assert metadata(APP)==data['services']['app']['before'],'Live app changed'
    assert {n:metadata(n) for n in DEPENDENCIES}==data['dependencies'],'Dependency changed'
    assert trees(APP)==data['services']['app']['beforeTree'],'Live source changed'
    assert {f:digest((SERVER/f).read_bytes()) for f in FILES}==data['workspaceHashes'],'Workspace changed'
    assert boss.tree(RELEASE/'candidate-app')==data['services']['app']['tree'],'Candidate changed'

def capture():
    os.umask(0o077);RELEASE.mkdir(exist_ok=False)
    tested=json.loads((ARTIFACTS/'source-hashes.json').read_text())
    assert all(digest((SERVER/f).read_bytes())==h for f,h in tested.items()),'Implementation changed since verification'
    data={'services':{},'dependencies':{n:metadata(n) for n in DEPENDENCIES},'workspaceHashes':{f:digest((SERVER/f).read_bytes()) for f in FILES}}
    before=metadata(APP);baseline=RELEASE/'before-app';baseline.mkdir()
    for folder in ['src','public','migrations','package.json','package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp',APP+':/app/'+folder,'-'))) as archive:archive.extractall(baseline,filter='data')
    candidate=RELEASE/'candidate-app';shutil.copytree(baseline,candidate)
    patch=''
    for file in FILES:
        target=candidate/file
        old=ARTIFACTS/'before'/file
        assert old.exists() and target.exists(),file
        patch+=''.join(difflib.unified_diff(old.read_text().splitlines(True),(SERVER/file).read_text().splitlines(True),fromfile='a/'+file,tofile='b/'+file))
    (RELEASE/'workspace.patch').write_text(patch)
    result=subprocess.run(['patch','--batch','--fuzz=0','-p1','-d',str(candidate)],input=patch,text=True,capture_output=True)
    (RELEASE/'patch.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,'Review scoped patch conflicts'
    for p in candidate.rglob('*.orig'):p.unlink()
    old,new=boss.tree(baseline),boss.tree(candidate);changed=sorted(f for f in new if old.get(f)!=new[f])
    assert changed==FILES,(changed,FILES)
    data['services']['app']={'before':before,'beforeTree':old,'tree':new,'changed':changed,'image':IMAGE,'sourceHashes':{f:new[f] for f in changed}}
    save('manifest.json',data);current(data)
    print(json.dumps({'captured':len(changed),'parent':before['image'],'workerPreserved':True}),flush=True)

def prepare():
    data=state();current(data);row=data['services']['app'];stage=RELEASE/'stage'
    for f in FILES:
        dest=stage/'overlay'/f;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(RELEASE/'candidate-app'/f,dest)
    parent='mbbs-operator-app:boss-close-parent-'+row['before']['imageId'].split(':')[1][:12];docker('tag',row['before']['imageId'],parent)
    (stage/'Dockerfile').write_text('FROM '+parent+'\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE/'build.log').open('wb') as log:subprocess.run(['sudo','-n','docker','build','--network','none','--pull=false','-t',IMAGE,str(stage)],stdout=log,stderr=subprocess.STDOUT,check=True)
    row['candidateImageId']=docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
    assert json.loads(docker('run','--rm','--network','none','--entrypoint','node',IMAGE,'-e',boss.TREE))==row['tree']
    for kind,image in [('release',IMAGE),('rollback',row['before']['imageId'])]: (RELEASE/('compose.'+kind+'.yml')).write_text('services:\n  app:\n    image: '+image+'\n')
    save('manifest.json',data);core.config_check(data);current(data);print(json.dumps({'prepared':row['candidateImageId']}),flush=True)

def checks():
    data=state();current(data)
    args=['sudo','-n','docker','run','--rm','--network','mbbs-boss-test','--read-only','--tmpfs','/tmp:mode=1777','--tmpfs','/app/data:mode=1777','--tmpfs','/app/test-artifacts:mode=1777']
    for name in ['src','public','migrations','package.json']:args+=['-v',str(RELEASE/'candidate-app'/name)+':/app/'+name+':ro']
    for name in ['test','tools']:args+=['-v',str(SERVER/name)+':/app/'+name+':ro']
    args+=['-v',str(SERVER)+':/workspace:ro']
    for item in ['NODE_ENV=test','MBT_TEST_ISOLATED=1','MBBS_ENV_FILE=/nonexistent','DATABASE_URL=postgres://mbt_test:boss_test_only@db:5432/mbt_test','NETSUITE_DIRECT_ACCESS_ENABLED=false','NETSUITE_MIRROR_ROLE=disabled','SAMSARA_WRITES_ENABLED=false','MBT_NETSUITE_WRITES_ENABLED=false','SMART_SCM_LIVE_EXECUTION_ENABLED=false','SALES_PUBLIC_ACCESS_ENABLED=false','PLAYWRIGHT_BROWSERS_PATH=/ms-playwright']:args+=['-e',item]
    runner="import {tests} from './tools/boss-close-suites.mjs';import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,['--test','--test-concurrency=1',...tests],{stdio:'inherit'});process.exit(r.status??1);"
    with (RELEASE/'candidate-tests.log').open('wb') as log:result=subprocess.run(args+['mbbs-regular-v2:e2e','node','--input-type=module','-e',runner],stdout=log,stderr=subprocess.STDOUT)
    assert result.returncode==0,'Candidate test failures'
    docker('run','--rm','--network','none','-e','MBBS_ENV_FILE=/nonexistent','-e','NETSUITE_DIRECT_ACCESS_ENABLED=false','-e','NETSUITE_MIRROR_ROLE=disabled','--entrypoint','node',IMAGE,'--input-type=module','-e',"await import('./src/server.js');await import('nodemailer');process.exit(0)")
    save('candidate-checks.json',{'passed':True,'image':data['services']['app']['candidateImageId']});current(data);print(json.dumps({'candidateTestsPassed':True}),flush=True)

def active():
    result=boss.active_work();result['bossCommands']=int(database("SELECT count(*) FROM boss_approval_commands WHERE status IN ('queued','sending')"));return result

def verify():
    data=state();row=data['services']['app'];core.core.ready(row['candidateImageId'])
    actual=metadata(APP);assert actual['imageId']==row['candidateImageId'];assert actual['configuration']==row['before']['configuration'];assert trees(APP)==row['tree']
    assert {n:metadata(n) for n in DEPENDENCIES}==data['dependencies']
    probe="""import './src/config.js';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {createPasswordResetMailer} from './src/password-reset-mail.js';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 assert.equal((await fetch(base+'/health',{signal:AbortSignal.timeout(15000)})).status,200);
 for(const [file,hash] of Object.entries(HASHES)){
  if(!file.startsWith('public/'))continue;
  const r=await fetch(base+'/'+file.slice(7)+'?release=boss-close-20261003',{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});assert.equal(r.status,200,file);
  const body=(await r.text()).replace(/<script type=\"module\" src=\"https:\\/\\/static\\.cloudflareinsights\\.com\\/beacon\\.min\\.js\\/[^>]+><\\/script>\\n/g,'');assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,file);
 }
 assert.equal((await fetch(base+'/api/boss/requests')).status,401);
 assert.equal((await fetch(base+'/api/delivery/audit')).status,401);

}
assert.equal(createPasswordResetMailer().readiness().configured,true);console.log(JSON.stringify({health:true,publicAssetsVerified:true,auditProtected:true,smtpConfigured:true,anonymousBossDenied:true}));"""
    checked=json.loads(docker('exec','-i',APP,'node','--input-type=module',input=probe.replace('HASHES',json.dumps(row['sourceHashes'])).encode()))
    operational=json.loads(docker('exec','-i',APP,'node','--input-type=module',input=(SERVER/'tools/boss-history-live.mjs').read_bytes()))
    save('live-readback.json',operational)
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':row['candidateImageId'],'configurationPreserved':True,'workerPreserved':True,**checked};save('result.json',result);print(json.dumps(result),flush=True)

def apply():
    data=state();current(data)
    checked=json.loads((RELEASE/'candidate-checks.json').read_text());assert checked['passed'] and checked['image']==data['services']['app']['candidateImageId']
    results=json.loads((ARTIFACTS/'gauntlet-results.json').read_text());assert results and all(r['status']==0 for r in results)
    core.config_check(data);work=active();save('active-before.json',work);assert not any(work.values()),work
    current(data);assert not any(active().values()),'Active operations; defer app restart'
    try:
        with (RELEASE/'publish.log').open('wb') as log:subprocess.run(core.compose(data)+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
    except Exception:
        with (RELEASE/'rollback.log').open('wb') as log:subprocess.run(core.compose(data,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        core.core.ready(data['services']['app']['before']['imageId']);save('rollback-result.json',{'previousImageRestored':True,'noSchemaChanges':True});raise

if __name__=='__main__':globals()[sys.argv[1]]()

"""Scoped grouped-packing release: prepare, build, test, apply, verify.

The live parent image supplies every file except delivery-repository.js.
Tests use the existing isolated database and test-only fast-check packages.
"""
import datetime
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
spec = importlib.util.spec_from_file_location('release_core', HERE/'operator-display-settings-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = Path('/home/ubuntu/operatorapp-deploy-backups/operator-group-packing-20260929-v1')
core.IMAGE = 'mbbs-operator-app:operator-group-packing-20260929-v1'
core.ROLLBACK = 'mbbs-operator-app:rollback-operator-group-packing-20260929-v1'
core.FILES = core.EXISTING = ['src/delivery-repository.js']
core.ADDED = []
R = core.RELEASE
ART = core.SERVER/'test-artifacts/operator-group-camera'
GROUP = 'test/mbt/integration/operator-group-draft.test.js'
SUITE = [GROUP, 'test/mbt/integration/group-underpack.test.js',
         'test/dispatch/integration/co-source-packing-handoff.test.js',
         'test/dispatch/property/group-underpack-boundary.property.test.js',
         'test/mbt/unit/operator-posting-responsiveness.test.js',
         'test/mbt/unit/operator-delivery-refresh.test.js',
         'test/mbt/unit/operator-delivery-reference.test.js']

def extract(container, folder, names, target):
    target.mkdir(parents=True, exist_ok=True)
    raw = core.docker('exec', container, 'tar', '-C', folder, '-cf', '-', *names)
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        archive.extractall(target, filter='data')

def prepare():
    os.umask(0o077)
    R.mkdir(parents=True, exist_ok=False)
    state = {'app': core.metadata(core.APP), 'dependencies': [core.metadata(n) for n in core.DEPENDENCIES]}
    extract(core.APP, '/app', ['src','public','migrations'], R/'baseline')
    assert core.metadata(core.APP) == state['app'], 'Live image changed during snapshot'
    file = core.FILES[0]
    assert (R/'baseline'/file).read_bytes() == (ART/'delivery.before.js').read_bytes(), 'Rebase packing fix first'
    shutil.copytree(R/'baseline', R/'candidate')
    shutil.copyfile(core.SERVER/file, R/'candidate'/file)
    old, new = (R/'baseline'/file).read_text(), (R/'candidate'/file).read_text()
    (R/'release.patch').write_text(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+file,tofile='b/'+file)))
    before, after = core.files_at(R/'baseline'), core.files_at(R/'candidate')
    assert sorted(k for k in after if before.get(k) != after[k]) == core.FILES
    state.update({'image':core.IMAGE,'before':{file:before[file]},'after':{file:after[file]},
                  'workspace':{file:core.digest((core.SERVER/file).read_bytes())},'changedFiles':core.FILES,
                  'allBefore':before,'allAfter':after})
    state['changedLines'] = [line + 1
        for tag, _, _, start, end in difflib.SequenceMatcher(None, old.splitlines(), new.splitlines()).get_opcodes()
        if tag in ('insert', 'replace') for line in range(start, end)]
    (R/'stage/src').mkdir(parents=True)
    shutil.copyfile(R/'candidate'/file,R/'stage'/file)
    (R/'compose.release.yml').write_text('services:\n  app:\n    image: '+core.IMAGE+'\n')
    (R/'compose.rollback.yml').write_text('services:\n  app:\n    image: '+state['app']['imageId']+'\n')
    runner = json.loads(core.docker('inspect','mbbs-regular-v2-runner'))[0]
    env = dict(row.split('=',1) for row in runner['Config']['Env'])
    (R/'test.env').write_text('DATABASE_URL='+env['DATABASE_URL']+'\nNODE_ENV=test\nNETSUITE_DIRECT_ACCESS_ENABLED=false\n')
    state['testNetwork'] = next(iter(runner['NetworkSettings']['Networks']))
    assert 'test' in state['testNetwork']
    extract('mbbs-regular-v2-runner','/app/node_modules',['fast-check','pure-rand'],R/'test-deps')
    (R/'coverage').mkdir()
    core.save('manifest.json',state)
    print(json.dumps({'prepared':True,'baseImage':state['app']['image'],'files':core.FILES}),flush=True)

def run_test(label, image, args, extra_env=None):
    state = core.manifest()
    test_environment = dict(row.split('=', 1) for row in (R/'test.env').read_text().splitlines())
    assert re.search(r'/mbt_test(?:_file_[\w]+)?(?:[?#]|$)', test_environment['DATABASE_URL']), 'Disposable test database required'
    cmd=['sudo','-n','docker','run','--rm','--network',state['testNetwork'],'--env-file',str(R/'test.env'),
         '-e','MBT_TEST_ISOLATED=1',
         '--mount',f'type=bind,src={core.SERVER / "test"},dst=/app/test,readonly',
         '--mount',f'type=bind,src={core.SERVER / "tools"},dst=/app/tools,readonly',
         '--mount',f'type=bind,src={R},dst=/release',
         '--mount',f'type=bind,src={R / "test-deps/fast-check"},dst=/app/node_modules/fast-check,readonly',
         '--mount',f'type=bind,src={R / "test-deps/pure-rand"},dst=/app/node_modules/pure-rand,readonly']
    for key,value in (extra_env or {}).items():cmd+=['-e',key+'='+value]
    cmd+=['--entrypoint','node',image,*args]
    result=subprocess.run(cmd,capture_output=True,timeout=180)
    output=(result.stdout+result.stderr).decode()
    (R/(label+'.log')).write_text(output)
    failures=re.findall(r'^not ok \d+ - (.+)$',output,re.M)
    counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$',output,re.M)}
    row={'name':label,'exit':result.returncode,'failures':failures,**counts}
    print(json.dumps(row),flush=True)
    return row

def flatten(state):
    config = json.loads(core.docker('image', 'inspect', state['app']['imageId']))[0]['Config']
    flattened = core.IMAGE + '-base'
    if (R/'flattened-base.json').exists():
        saved = json.loads((R/'flattened-base.json').read_text())
        assert saved['parent']==state['app']['imageId']
        assert core.docker('image','inspect','--format','{{.Id}}',flattened).decode().strip()==saved['imageId']
        return flattened
    container = core.docker('create', '--network', 'none', '--entrypoint', 'true', state['app']['imageId']).decode().strip()
    archive = R/'base-filesystem.tar'
    try:
        with archive.open('wb') as output:
            subprocess.run(['sudo', '-n', 'docker', 'export', container], stdout=output, check=True)
    finally:
        core.docker('rm', container)
    changes = []
    for field in ['User', 'WorkingDir', 'StopSignal']:
        instruction = {'User':'USER', 'WorkingDir':'WORKDIR', 'StopSignal':'STOPSIGNAL'}[field]
        if config.get(field): changes += ['--change', instruction+' '+config[field]]
    for field in ['Entrypoint', 'Cmd']:
        if config.get(field) is not None: changes += ['--change', field.upper()+' '+json.dumps(config[field])]
    for entry in config.get('Env', []):
        key, value = entry.split('=', 1)
        changes += ['--change', 'ENV '+key+'='+json.dumps(value)]
    for port in config.get('ExposedPorts', {}): changes += ['--change', 'EXPOSE '+port]
    for key, value in (config.get('Labels') or {}).items(): changes += ['--change', 'LABEL '+key+'='+json.dumps(value)]
    assert not config.get('Volumes') and not config.get('OnBuild'), 'Unexpected image volume or build hook'
    health = config.get('Healthcheck')
    if health:
        options = ' '.join('--'+flag+'='+str(health[field])+'ns' for field,flag in
            [('Interval','interval'),('Timeout','timeout'),('StartPeriod','start-period'),('StartInterval','start-interval')] if health.get(field))
        if health.get('Retries'): options += ' --retries='+str(health['Retries'])
        test = health['Test']
        command = 'NONE' if test[0]=='NONE' else 'CMD '+(test[1] if test[0]=='CMD-SHELL' else json.dumps(test[1:]))
        changes += ['--change', 'HEALTHCHECK '+options+' '+command]
    flat_id = core.docker('import', *changes, str(archive), flattened).decode().strip()
    flat_config = json.loads(core.docker('image', 'inspect', flat_id))[0]['Config']
    for field in ['User','WorkingDir','Entrypoint','Cmd','Env','ExposedPorts','Healthcheck','Labels','StopSignal']:
        assert (config.get(field) or None)==(flat_config.get(field) or None), 'Flatten changed '+field
    core.save('flattened-base.json', {'parent':state['app']['imageId'],'imageId':flat_id,'runtimeConfigurationPreserved':True})
    archive.unlink()
    return flattened

def build():
    state = core.manifest(); core.current(state)
    core.docker('tag', state['app']['imageId'], core.ROLLBACK)
    flattened = flatten(state)
    if (R/'build.log').exists() and not (R/'build-initial.log').exists(): shutil.copyfile(R/'build.log',R/'build-initial.log')
    (R/'stage/Dockerfile').write_text('FROM '+flattened+'\nCOPY --chown=node:node --chmod=0644 src/delivery-repository.js /app/src/delivery-repository.js\n')
    with (R/'build.log').open('wb') as output:
        subprocess.run(['sudo','-n','docker','build','--network','none','--pull=false','-t',core.IMAGE,str(R/'stage')],
                       stdout=output,stderr=subprocess.STDOUT,check=True)
    state['candidateImageId'] = core.docker('image','inspect','--format','{{.Id}}',core.IMAGE).decode().strip()
    actual = core.docker('run','--rm','--network','none','--entrypoint','sha256sum',core.IMAGE,
                        *['/app/'+file for file in state['allAfter']]).decode().splitlines()
    assert {line.split()[1].removeprefix('/app/'):line.split()[0] for line in actual}==state['allAfter']
    core.current(state); core.save('manifest.json',state)
    print(json.dumps({'built':core.IMAGE,'imageId':state['candidateImageId'],'verifiedFiles':len(actual),'flattened':True}),flush=True)

def tests():
    state=core.manifest();core.current(state)
    for previous in (R/'coverage').glob('*.json'): previous.unlink()
    results=[]
    red=run_test('baseline-group',state['app']['imageId'],['--test',GROUP]);results.append(red)
    assert red['exit']==1 and set(red['failures'])=={
        'mixed packed/open group keeps its preparing owner and current draft identity',
        'current draft returns the group even when its first child is already packed',
        'property: member ordering does not change draft identity or ownership'},'Unexpected baseline regression'
    green=run_test('release-suite',state['candidateImageId'],['--test','--test-concurrency=1',*SUITE],
                   {'NODE_V8_COVERAGE':'/release/coverage'});results.append(green)
    known='P2 the installed operator shell precaches the versioned refresh guard and client together'
    assert green['exit']==1 and green['failures']==[known] and green.get('skipped')==0,'New suite failure'
    baseline_cache=run_test('baseline-cache',state['app']['imageId'],['--test','test/mbt/unit/operator-delivery-refresh.test.js']);results.append(baseline_cache)
    assert baseline_cache['exit']==1 and baseline_cache['failures']==[known],'Cache failure must predate release'
    for name,pattern in [('owner','mixed packed'),('draft','current draft returns'),('packing','complete remaining'),('ownership','another operator')]:
        row=run_test('mutant-'+name,state['candidateImageId'],['--loader','./tools/operator-group-camera-mutants.mjs','--test','--test-name-pattern='+pattern,GROUP],{'OPERATOR_GROUP_CAMERA_MUTANT':name});results.append(row)
        assert row['exit']==1 and row['failures'] and 'ERR_ASSERTION' in (R/('mutant-'+name+'.log')).read_text()
    for name in ['owner','draft']:
        row=run_test('property-mutant-'+name,state['candidateImageId'],['--loader','./tools/operator-group-camera-mutants.mjs','--test','--test-name-pattern=property: member',GROUP],{'OPERATOR_GROUP_CAMERA_MUTANT':name});results.append(row)
        assert row['exit']==1 and row['failures']
    static_cmd=['sudo','-n','docker','run','--rm','--network','none',
        '--mount',f'type=bind,src={R},dst=/release',
        '--mount',f'type=bind,src={R / "candidate/src"},dst=/app/src,readonly',
        '--mount',f'type=bind,src={core.SERVER / "tools"},dst=/app/tools,readonly',
        '--entrypoint','node','mbbs-regular-v2:test','tools/operator-group-packing-static.mjs']
    static=subprocess.run(static_cmd,capture_output=True,timeout=120)
    (R/'static.log').write_bytes(static.stdout+static.stderr)
    assert static.returncode==0,'Static checks failed; see static.log'
    core.current(state)
    core.save('verified.json',{'passed':True,'imageId':state['candidateImageId'],'sourceHash':state['after'][core.FILES[0]],'results':results,
                             'static':json.loads((R/'static.json').read_text())})
    print(json.dumps({'verified':True,'scope':core.FILES,'sourceHash':state['after'][core.FILES[0]]}),flush=True)

def verify():
    state=core.manifest();core.ready(state['candidateImageId']);after=core.metadata(core.APP)
    assert after['configuration']==state['app']['configuration'],'Application configuration changed'
    assert [core.metadata(n) for n in core.DEPENDENCIES]==state['dependencies'],'Dependency changed'
    script='''import fs from 'node:fs';import crypto from 'node:crypto';
const hashes={};for(const folder of ['src','public','migrations']){
 for(const file of fs.readdirSync('/app/'+folder,{recursive:true})){
  const full='/app/'+folder+'/'+file;if(fs.statSync(full).isFile())hashes[folder+'/'+file]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
 }}console.log(JSON.stringify(hashes));'''
    hashes=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()))
    assert hashes==state['allAfter'],'Unexpected deployed file change'
    http='''import assert from 'node:assert/strict';
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 let r=await fetch(base+'/health');assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
 r=await fetch(base+'/operator');assert.equal(r.status,200);
 r=await fetch(base+'/api/delivery/orders?locationId=1');assert.equal(r.status,401);
}console.log(JSON.stringify({localHealth:200,publicHealth:200,operatorPage:200,unauthenticatedOrders:401}));'''
    checks=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=http.encode()))
    result={'deployed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':core.IMAGE,'imageId':after['imageId'],
            'files':core.FILES,'allRuntimeFilesVerified':len(hashes),'configurationPreserved':True,'dependenciesUnchanged':True,**checks}
    core.save('deployment-result.json',result);print(json.dumps(result),flush=True)

def apply():
    state=core.manifest();core.current(state)
    evidence=json.loads((R/'verified.json').read_text())
    assert evidence['passed'] and evidence['imageId']==state['candidateImageId']
    assert core.docker('image','inspect','--format','{{.Id}}',core.IMAGE).decode().strip()==state['candidateImageId']
    resolved=json.loads(subprocess.check_output(core.compose(state,'compose.release.yml')+['config','--format','json'],cwd=core.ROOT))['services']['app']
    image_config=json.loads(core.docker('image','inspect',core.IMAGE))[0]['Config']
    runtime_config=json.loads(core.docker('inspect',core.APP))[0]['Config']
    env=dict(row.split('=',1) for row in image_config['Env']);env.update({k:str(v) for k,v in resolved.get('environment',{}).items()})
    assert env==dict(row.split('=',1) for row in runtime_config['Env']),'Compose would change environment'
    for field,key in [('Cmd','command'),('Entrypoint','entrypoint'),('User','user'),('WorkingDir','working_dir')]:
        expected=resolved.get(key);expected=image_config.get(field) if expected is None else expected
        assert expected==runtime_config.get(field),'Compose would change '+field
    active=core.database("SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('posting','finalizing');").strip()
    assert active=='0','Active posting command; wait for completion before restart'
    core.current(state)
    try:
        with (R/'apply.log').open('wb') as log:
            subprocess.run(core.compose(state,'compose.release.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=core.ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
        verify()
    except Exception:
        with (R/'rollback.log').open('wb') as log:
            subprocess.run(core.compose(state,'compose.rollback.yml')+['up','-d','--no-build','--no-deps','--pull','never','app'],cwd=core.ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
        core.ready(state['app']['imageId'])
        raise

if __name__=='__main__':
    {'prepare':prepare,'build':build,'test':tests,'apply':apply,'verify':verify}[sys.argv[1]]()

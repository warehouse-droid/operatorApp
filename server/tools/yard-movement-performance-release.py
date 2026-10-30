"""Scoped, app-only release of the In/Outbound read-performance changes."""
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
RELEASE = SERVER / 'deployments/yard-movement-performance-20261022'
spec = importlib.util.spec_from_file_location('yard_performance_release_base', SERVER / 'tools/count-sheet-variance-release.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
core = base.core
base.RELEASE = core.RELEASE = RELEASE
base.IMAGE = 'mbbs-operator-app:yard-movement-performance-20261022'
base.ROLLBACK = base.IMAGE + '-rollback'
FILES = json.loads((RELEASE / 'scope.json').read_text())['files'] + ['public/yard-movement-requests.js']
base.FILES = FILES


def inputs():
    names = FILES + [str(p.relative_to(SERVER)) for folder in ['test','tools']
                    for p in (SERVER / folder).glob('yard-movement-performance*') if p.is_file()]
    names += ['test/support/yard-movement-performance-fixture.mjs',
              'test/support/yard-movement-performance-mutations.mjs','test/yard-movement-requests.test.js',
              'test/mbt/integration/yard-movement-po-search.test.js','test/mbt/integration/movement-document-history.test.js']
    return {name:core.sha((SERVER / name).read_bytes()) for name in names}


base.workspace_inputs = inputs


def prepare():
    os.umask(0o077)
    assert not (RELEASE / 'manifest.json').exists(), 'Already prepared'
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    roots = json.loads(core.docker('exec',core.APP,'node','-e',"console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec',core.APP,'tar','-cf','-','-C','/app',*roots)
    before = RELEASE / 'before'; before.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before,filter='data')
    candidate = RELEASE / 'candidate'; shutil.copytree(before,candidate)
    patch = ''
    for name in FILES:
        prior = RELEASE / 'workspace-before' / name
        if not prior.exists():
            assert name == 'public/yard-movement-requests.js' and not (candidate / name).exists()
            shutil.copy2(SERVER / name,candidate / name)
        else:
            patch += ''.join(difflib.unified_diff(prior.read_text().splitlines(True),(SERVER / name).read_text().splitlines(True),
                                                fromfile='a/'+name,tofile='b/'+name,n=3))
    core.apply_patch(candidate,patch,'yard-performance')
    before_tree, candidate_tree = base.tree(before), base.tree(candidate)
    changed = sorted(name for name in before_tree.keys() | candidate_tree.keys() if before_tree.get(name) != candidate_tree.get(name))
    assert changed == sorted(FILES), changed
    assert candidate_tree['package-lock.json'] == core.sha((SERVER / 'package-lock.json').read_bytes())
    for field in ['dependencies','devDependencies']:
        assert json.loads((candidate / 'package.json').read_text()).get(field) == json.loads((SERVER / 'package.json').read_text()).get(field)
    data = {'capturedAt':core.now(),'authorization':'User requested the live application speed enhancement and Playwright validation',
            'app':app,'dependencies':dependencies,'files':FILES,'workspace':inputs(),'beforeTree':before_tree,'candidateTree':candidate_tree,
            'candidateTreeHash':core.sha(json.dumps(candidate_tree,sort_keys=True).encode())}
    core.save('manifest.json',data);base.current(data)
    print(json.dumps({'prepared':True,'files':FILES,'candidateDiffersFromWorkspace':[name for name in FILES if candidate_tree[name] != data['workspace'][name]]}),flush=True)


def verify():
    data = core.state();core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration']
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec',core.APP,'node','-e',core.HASH_SCRIPT)) == data['candidateTree']
    assets = {name:data['candidateTree'][name] for name in FILES if name.startswith('public/')}
    script = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const assets=ASSETS,results=[];
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for(const [name,hash] of Object.entries(assets)) {
  const r=await fetch(origin+'/'+name.replace(/^public\\//,'')+'?v=20261022-yard-speed-v1',{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash);
 }
 for(const path of ['/health','/control/yard-in-outbound','/sales/in-outbound-record','/dispatch/loaded-export']) {
  const r=await fetch(origin+path,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,path);
  if(path==='/health') assert.equal((await r.json()).ok,true);
 }
 for(const path of ['/api/control/loaded-orders','/api/sales/in-outbound-records','/api/dispatch/loaded-orders']) {
  const r=await fetch(origin+path+'/detail?orderId=1',{signal:AbortSignal.timeout(15000)});assert.equal(r.status,401,path);
 }
 results.push({origin,health:200,pages:3,assetHashes:Object.keys(assets).length,anonymousDetail:401});
} console.log(JSON.stringify(results));""".replace('ASSETS',json.dumps(assets))
    http = json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()))
    containers = {key:core.docker(*args,'--format','{{.Names}} {{.Status}}').decode().splitlines()
                  for key,args in [('running',['ps']),('all',['ps','-a'])]}
    for rows in containers.values():
        assert {row.split()[0] for row in rows} == {core.APP,*core.DEPENDENCIES}
    core.save('container-check.json',containers)
    result = {'deployed':True,'at':core.now(),'image':base.IMAGE,'imageId':actual['imageId'],
              'rollbackImage':base.ROLLBACK,'configurationPreserved':True,'dependenciesUnchanged':True,
              'runtimeFilesVerified':len(data['candidateTree']),'http':http,'files':FILES,'databaseMigration':False}
    core.save('deployment-result.json',result);print(json.dumps(result),flush=True)


def deploy():
    data = core.state();base.current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['imageId'] == data['candidateImageId'] and validation['candidateTreeHash'] == data['candidateTreeHash']
    assert core.docker('image','inspect','--format','{{.Id}}',base.IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    for attempt in range(20):
        active = core.preflight()
        active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
        try:
            core.assert_no_active_operations(active);break
        except AssertionError:
            if attempt == 19: raise
            time.sleep(2)
    base.current(data);start = time.monotonic()
    args = ['up','-d','--no-build','--no-deps','--pull','never','app']
    try:
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data,'release')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify();core.save('cutover-timing.json',{'secondsThroughVerification':round(time.monotonic()-start,3)})
    except BaseException:
        with (RELEASE / 'rollback.log').open('wb') as output:
            subprocess.run(core.compose(data,'rollback')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        core.ready(data['app']['imageId']);core.save('rollback-result.json',{'at':core.now(),'priorImageRestored':True})
        raise


if __name__ == '__main__':
    signal.signal(signal.SIGTERM,lambda signum,_:sys.exit(128+signum))
    {'prepare':prepare,'build':base.build,'deploy':deploy,'verify':verify}[sys.argv[1]]()

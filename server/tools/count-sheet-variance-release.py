"""Deploy the corrected count-sheet formula with exact-image validation and rollback."""
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
RELEASE = SERVER / 'deployments/count-sheet-variance-20261021'
BASELINE = SERVER / 'deployments/count-sheet-adjustments-20261021'
IMAGE = 'mbbs-operator-app:count-sheet-variance-20261021'
ROLLBACK = IMAGE + '-rollback'
MIGRATION = '303_count_sheet_variance.sql'
FILES = ['src/count-sheet-repository.js','src/count-sheet-reconstruction.js',
         'public/control-count-sheets.js','public/control.html','public/i18n.js','migrations/' + MIGRATION]
NEW = {'migrations/' + MIGRATION}
spec = importlib.util.spec_from_file_location('count_adjustments_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE = RELEASE
core.HASH_SCRIPT = """const fs=require('node:fs'),c=require('node:crypto'),result={};
function hash(p){result[p]=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){
const p=d+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hash(p);}}
for(const d of ['src','public','migrations','contracts'])walk(d);
for(const p of ['package.json','package-lock.json'])hash(p);console.log(JSON.stringify(result));"""


def tree(directory):
    paths = [p for name in ['src','public','migrations','contracts'] for p in (directory / name).rglob('*') if p.is_file()]
    paths += [directory / name for name in ['package.json','package-lock.json']]
    return {str(p.relative_to(directory)):core.sha(p.read_bytes()) for p in sorted(paths)}


def workspace_inputs():
    tests = ['test/count-sheet-adjustments.test.js','test/count-sheet-adjustments-browser.test.js',
             'test/count-sheet-refresh.test.js','test/count-sheet-refresh-browser.test.js','test/count-sheet-reconstruction.test.js',
             'test/inventory-packed-count.test.js','test/inventory-count-review-browser.test.js','test/cycle-count-refresh-http.test.js']
    tests += ['test/operator-inventory-' + name + '.test.js' for name in ['domain','adapter','photos','count','damage','http','browser']]
    checks = ['test/support/count-sheet-adjustments-mutation-loader.mjs',
              'tools/count-sheet-adjustments-checks.mjs','tools/count-sheet-adjustments-coverage.mjs',
              'tools/count-sheet-adjustments-candidate.mjs','tools/count-sheet-adjustments-eslint.config.mjs',
              'tools/count-sheet-adjustments-isolated.sh','tools/count-sheet-variance-release.py']
    return {name:core.sha((SERVER / name).read_bytes()) for name in FILES + tests + checks}


def current(data):
    assert core.metadata(core.APP) == data['app'], 'Live app changed; recapture required'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies']
    assert json.loads(core.docker('exec',core.APP,'node','-e',core.HASH_SCRIPT)) == data['beforeTree']
    assert tree(RELEASE / 'candidate') == data['candidateTree']
    assert workspace_inputs() == data['workspace']


def capture():
    hashes = workspace_inputs()
    os.umask(0o077)
    RELEASE.mkdir(parents=True,exist_ok=False)
    app = core.metadata(core.APP)
    dependencies = [core.metadata(name) for name in core.DEPENDENCIES]
    roots = json.loads(core.docker('exec',core.APP,'node','-e',"console.log(JSON.stringify(['src','public','migrations','contracts','package.json','package-lock.json'].filter(p=>require('node:fs').existsSync(p))))"))
    archive = core.docker('exec',core.APP,'tar','-cf','-','-C','/app',*roots)
    before = RELEASE / 'before'; before.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(before,filter='data')
    candidate = RELEASE / 'candidate'; shutil.copytree(before,candidate)
    patch = ''
    baseline = json.loads((BASELINE / 'manifest.json').read_text())
    for name in FILES:
        source = (SERVER / name).read_text()
        if name in NEW:
            assert not (candidate / name).exists(), 'New file already deployed: ' + name
            shutil.copy2(SERVER / name,candidate / name)
            continue
        old = (BASELINE / 'candidate' / name).read_text()
        assert core.sha(old.encode()) == baseline['candidateTree'][name], 'Baseline changed: ' + name
        assert (before / name).read_text() == old, 'Live baseline changed: ' + name
        new = source
        patch += ''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+name,tofile='b/'+name,n=3))
    core.apply_patch(candidate,patch,'count-variance')
    before_tree, after_tree = tree(before), tree(candidate)
    changed = sorted(name for name in before_tree.keys() | after_tree.keys() if before_tree.get(name) != after_tree.get(name))
    assert changed == sorted(FILES), 'Unexpected deployment scope'
    assert after_tree['package-lock.json'] == core.sha((SERVER / 'package-lock.json').read_bytes()), 'Candidate lockfile differs from tested workspace'
    live_package = json.loads((candidate / 'package.json').read_text())
    workspace_package = json.loads((SERVER / 'package.json').read_text())
    for field in ['dependencies','devDependencies']:
        assert live_package.get(field) == workspace_package.get(field), 'Candidate dependencies differ: ' + field
    data = {'capturedAt':core.now(),'authorization':'User explicitly requested deploy','app':app,'dependencies':dependencies,
            'files':FILES,'expectedTests':109,'workspace':hashes,'beforeTree':before_tree,'candidateTree':after_tree,
            'candidateTreeHash':core.sha(json.dumps(after_tree,sort_keys=True).encode())}
    core.save('manifest.json',data)
    current(data)
    print(json.dumps({'captured':True,'files':FILES,'candidateDiffersFromWorkspace':[name for name in FILES if after_tree[name] != hashes[name]]}),flush=True)


def build():
    data = core.state(); current(data)
    core.docker('tag',data['app']['imageId'],ROLLBACK)
    stage = RELEASE / 'stage'
    for name in FILES:
        target = stage / 'overlay' / name; target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / name,target)
    (stage / 'Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    for mode, image in [('release',IMAGE),('rollback',ROLLBACK)]:
        (RELEASE / ('compose.' + mode + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n    pull_policy: never\n')
    with (RELEASE / 'build.log').open('wb') as output:
        subprocess.run(['docker','build','--network=none','--pull=false','-t',IMAGE,str(stage)],stdout=output,stderr=subprocess.STDOUT,check=True,timeout=180)
    data['candidateImageId'] = core.docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()
    core.save('manifest.json',data)
    configs = [json.loads(subprocess.check_output(core.compose(data,mode)+['config','--format','json'],cwd=ROOT)) for mode in ['release','rollback']]
    for config in configs: config['services']['app'].pop('image')
    assert configs[0] == configs[1], 'Configuration changed beyond image'
    core.config_check(data); current(data)
    core.save('image-hash-script.json',{'script':core.HASH_SCRIPT})
    print(json.dumps({'built':True,'imageId':data['candidateImageId']}),flush=True)


def sheet_state():
    return json.loads(core.sql("""SELECT json_build_object(
      'counts',(SELECT count(*) FROM inventory_count_sheet_counts),
      'countContents',(SELECT md5(coalesce(jsonb_agg(to_jsonb(c)-'variance' ORDER BY sheet_id,attempt,item_id)::text,'[]')) FROM inventory_count_sheet_counts c),
      'sheets',(SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'[]')) FROM inventory_count_sheets s),
      'items',(SELECT md5(coalesce(jsonb_agg(to_jsonb(i) ORDER BY sheet_id,item_id)::text,'[]')) FROM inventory_count_sheet_items i),
      'events',(SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY id)::text,'[]')) FROM inventory_count_sheet_events e));"""))


def schema_state():
    return json.loads(core.sql("""SELECT json_build_object(
      'migration',(SELECT count(*) FROM schema_migrations WHERE filename='303_count_sheet_variance.sql'),
      'adjustingColumn',(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_count_sheet_counts' AND column_name='adjusting'),
      'incorrectVariance',(SELECT count(*) FROM inventory_count_sheet_counts WHERE actual_on_hand IS NOT NULL AND variance IS DISTINCT FROM quantity-actual_on_hand+adjusting));"""))


def verify():
    data = core.state(); core.ready(data['candidateImageId'])
    actual = core.metadata(core.APP)
    assert actual['configuration'] == data['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(name) for name in core.DEPENDENCIES] == data['dependencies'], 'Dependency changed'
    assert json.loads(core.docker('exec',core.APP,'node','-e',core.HASH_SCRIPT)) == data['candidateTree']
    schema = schema_state(); assert schema == {'migration':1,'adjustingColumn':1,'incorrectVariance':0}, schema
    assets = {name:data['candidateTree'][name] for name in FILES if name.startswith('public/')}
    script = """import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const assets=ASSETS, results=[];
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']) {
 for(const [name,hash] of Object.entries(assets)) {
  const r=await fetch(base+'/'+name.replace(/^public\\//,'')+'?v=20261021-variance-v2',{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200);assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash,name);
 }
 for(const path of ['/health','/control/count-sheets']) {
  const r=await fetch(base+path,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200,path);
  if(path==='/health')assert.equal((await r.json()).ok,true);
 }
 for(const action of ['adjust','reset','reopen']) {
  const r=await fetch(base+'/api/control/count-sheets/1/'+action,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});assert.equal(r.status,401,action);
 }
 results.push({origin:base,health:200,page:200,assetHashes:Object.keys(assets).length,anonymousMutations:401});
}
console.log(JSON.stringify(results));""".replace('ASSETS',json.dumps(assets))
    http = json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode()))
    containers = {key:core.docker(*args,'--format','{{.Names}} {{.Status}}').decode().splitlines()
                  for key,args in [('running',['ps']),('all',['ps','-a'])]}
    for rows in containers.values(): assert {row.split()[0] for row in rows} == {core.APP,*core.DEPENDENCIES}
    core.save('container-check.json',containers)
    result = {'deployed':True,'at':core.now(),'image':IMAGE,'imageId':actual['imageId'],'rollbackImage':ROLLBACK,
              'configurationPreserved':True,'dependenciesUnchanged':True,'runtimeFilesVerified':len(data['candidateTree']),
              'schema':schema,'http':http,'files':FILES}
    core.save('deployment-result.json',result)
    print(json.dumps(result),flush=True)


def apply():
    data = core.state(); current(data)
    validation = json.loads((RELEASE / 'validation-passed.json').read_text())
    assert validation['passed'] and validation['imageId'] == data['candidateImageId'] and validation['candidateTreeHash'] == data['candidateTreeHash']
    assert core.docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip() == data['candidateImageId']
    core.config_check(data)
    assert core.sql("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"';") == '0'
    for attempt in range(20):
        active = core.preflight()
        active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
        try:
            core.assert_no_active_operations(active); break
        except AssertionError:
            if attempt == 19: raise
            time.sleep(2)
    current(data)
    with (RELEASE / 'schema-before.dump').open('wb') as output:
        subprocess.run(['docker','exec',core.DB,'pg_dump','-U','mbbs_app','-d','mbbs_yard','--format=custom','--schema-only'],stdout=output,check=True,timeout=30)
    stopped = False; migrated = False; start = time.monotonic()
    args = ['up','-d','--no-build','--no-deps','--pull','never','app']
    try:
        stopped = True
        core.docker('stop','--time','30',core.APP,timeout=40)
        active = core.preflight()
        active['automaticFulfillment'] = int(core.sql("SELECT count(*) FROM dispatch_sales_order_if_candidates WHERE status='posting';"))
        core.assert_no_active_operations(active)
        before = sheet_state(); core.save('count-sheet-state-before.json',before)
        with (RELEASE / 'count-sheets-before.dump').open('wb') as output:
            subprocess.run(['docker','exec',core.DB,'pg_dump','-U','mbbs_app','-d','mbbs_yard','--format=custom',
                            '--table=public.inventory_count_sheets','--table=public.inventory_count_sheet_counts',
                            '--table=public.inventory_count_sheet_items','--table=public.inventory_count_sheet_events'],stdout=output,check=True,timeout=30)
        with (RELEASE / 'count-sheets-before.dump').open('rb') as backup:
            assert b'inventory_count_sheet_counts' in core.docker('exec','-i',core.DB,'pg_restore','--list',stdin=backup)
        statement = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
        core.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s';\n"+statement+"\nINSERT INTO schema_migrations(filename) VALUES('"+MIGRATION+"'); COMMIT;")
        migrated = True
        after = sheet_state(); assert after == before, 'Migration changed count contents, sheet assignments or history'
        core.save('migration-result.json',{'at':core.now(),'countedRowsPreserved':after['counts'],'countContentsAdjustmentsAndSheetsPreserved':True,'schema':schema_state()})
        with (RELEASE / 'publish.log').open('wb') as output:
            subprocess.run(core.compose(data,'release')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
        verify()
        core.save('cutover-timing.json',{'secondsThroughVerification':round(time.monotonic()-start,3)})
    except BaseException:
        if stopped:
            core.docker('stop','--time','30',core.APP,timeout=40)
            migrated = migrated or core.sql("SELECT count(*) FROM schema_migrations WHERE filename='"+MIGRATION+"';") == '1'
            if migrated:
                # Restore the prior convention without discarding counts or signed adjustments.
                core.sql("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='20s'; UPDATE inventory_count_sheet_counts SET variance=actual_on_hand-quantity+adjusting WHERE actual_on_hand IS NOT NULL; DELETE FROM schema_migrations WHERE filename='"+MIGRATION+"'; COMMIT;")
            with (RELEASE / 'rollback.log').open('wb') as output:
                subprocess.run(core.compose(data,'rollback')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=60)
            core.ready(data['app']['imageId'])
            core.save('rollback-result.json',{'at':core.now(),'previousImageRestored':True,'priorFormulaRestored':migrated,'adjustmentsPreserved':True})
        raise

if __name__ == '__main__':
    signal.signal(signal.SIGTERM,lambda signum,_:sys.exit(128+signum))
    {'capture':capture,'build':build,'apply':apply,'verify':verify}[sys.argv[1]]()

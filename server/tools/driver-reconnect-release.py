#!/usr/bin/env python3
"""Deploy the verified reconnect patch over the current production runtimes."""
import atexit
import datetime
import difflib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
from zoneinfo import ZoneInfo

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent
TASK = SERVER / 'test-artifacts/driver-reconnect-20261016'
RELEASE = SERVER / 'deployments/driver-reconnect-20261016'
IMAGE = 'mbbs-operator-app:driver-reconnect-20261016'
WORKER = 'mbbs-operator-app-webhook-worker-1'
WORKER_IMAGE = IMAGE + '-worker'
INITIAL = SERVER / 'deployments/driver-reconnect-20261016-initial-capture'
WORKER_FILES = ['src/dispatch-plan-repository.js', 'src/dispatch-planner-v2-repository.js',
                'src/dispatch-repository.js', 'src/sales-order-reconciliation-repository.js', 'src/server.js']
spec = importlib.util.spec_from_file_location('reconnect_release_core', SERVER / 'tools/delivery-scm-release.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.IMAGE, core.ROLLBACK = RELEASE, IMAGE, IMAGE + '-rollback'
core.READ_NAME, core.CHECK_NAME = 'mbbs-driver-reconnect-release-reader', 'mbbs-driver-reconnect-release-check'


def toronto():
    return datetime.datetime.now(ZoneInfo('America/Toronto')).isoformat()


def evidence():
    result = json.loads((TASK / 'evidence.json').read_text())
    assert result['validated'] is True
    assert result['focused']['pass'] == 94 and result['integration']['pass'] == 22
    assert result['browser']['expected'] == 10 and result['browser']['unexpected'] == 0
    for name, value in result['runtimeHashes'].items():
        original = INITIAL / 'verified-workspace-server.js' if name == 'src/server.js' else SERVER / name
        assert core.sha(original.read_bytes()) == value, 'Verified input changed: ' + name
    return result


def capture_runtime(container, target):
    target.mkdir()
    archive = core.docker('exec', container, 'tar', '-cf', '-', '-C', '/app',
                          'src', 'public', 'migrations', 'package.json', 'package-lock.json')
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(target, filter='data')


def capture():
    verified = evidence()
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = core.metadata(core.APP)
    dependencies = [core.metadata(n) for n in core.DEPENDENCIES]
    baseline, candidate = RELEASE / 'before', RELEASE / 'candidate'
    capture_runtime(core.APP, baseline)
    capture_runtime(WORKER, RELEASE / 'worker-before')
    assert core.metadata(core.APP) == before
    assert [core.metadata(n) for n in core.DEPENDENCIES] == dependencies
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in verified['runtimeHashes']:
        old = TASK / 'baseline' / name
        original = old.read_text() if old.exists() else ''
        desired = (SERVER / name).read_text()
        if name == 'src/server.js':
            trace_import = 'import {traceDriverCompletion} from "./driver-completion-trace.js";\n'
            assert desired.startswith(trace_import)
            desired = desired.removeprefix(trace_import)
            live = (candidate / name).read_text()
            assert trace_import not in live
            (candidate / name).write_text(trace_import + live)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), desired.splitlines(True),
            fromfile='a/' + name, tofile='b/' + name))
    apply_patch(candidate, patch, 'reconnect')
    before_tree, after_tree = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(n for n in before_tree.keys() | after_tree.keys() if before_tree.get(n) != after_tree.get(n))
    assert changed == sorted(verified['runtimeHashes']), 'Unexpected release scope'
    data = {'capturedAtToronto': toronto(), 'app': before, 'dependencies': dependencies,
        'files': changed, 'beforeTree': before_tree, 'candidateTree': after_tree,
        'candidateTreeHash': core.sha(json.dumps(after_tree, sort_keys=True).encode()),
        'workspace': {n: core.sha((SERVER/n).read_bytes()) for n in changed},
        'workerBeforeTree': core.files_at(RELEASE / 'worker-before'),
        'packages': {n: core.sha((candidate/n).read_bytes()) for n in ['package.json', 'package-lock.json']}}
    core.save('manifest.json', data)
    core.current(data)
    different = [n for n in changed if after_tree[n] != verified['runtimeHashes'][n]]
    core.save('candidate-comparison.json', {'differsFromVerifiedWorkspace': different,
        'preservedUnrelatedFiles': len(before_tree) - sum(n in before_tree for n in changed)})
    print(json.dumps({'captured': True, 'changedFiles': changed, 'differsFromVerifiedWorkspace': different}), flush=True)


def apply_patch(candidate, patch, label):
    (RELEASE / (label + '.patch')).write_text(patch)
    result = subprocess.run(['patch', '--batch', '--forward', '--fuzz=0', '-p1', '-d', str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / (label + '-patch.log')).write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Scoped patch conflict: ' + label
    for path in candidate.rglob('*.orig'):
        path.unlink()


def function_text(source, name):
    match = re.search(r'(?:export )?(?:async )?function ' + re.escape(name) + r'\(', source)
    assert match, name
    following = re.search(r'\n(?:export )?(?:async )?function ', source[match.end():])
    assert following, name
    return source[match.start():match.end() + following.start()]


def worker_candidate():
    data = core.state()
    core.current(data)
    baseline, candidate = RELEASE / 'worker-before', RELEASE / 'worker-candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for name in WORKER_FILES[:2]:
        patch += ''.join(difflib.unified_diff((TASK/'baseline'/name).read_text().splitlines(True),
            (SERVER/name).read_text().splitlines(True), fromfile='a/'+name, tofile='b/'+name))
    apply_patch(candidate, patch, 'worker-common')
    name = 'src/dispatch-repository.js'
    source = (candidate/name).read_text()
    for function in ['exactBilledSalesOrderSql', 'billedSalesOrderFamilySql']:
        source = source.replace(function_text(source, function), '')
    clause = '        AND ($11::boolean OR NOT ${billedSalesOrderFamilySql("sales_orders")})\n'
    assert source.count(clause) == 1
    (candidate/name).write_text(source.replace(clause, ''))
    name = 'src/sales-order-reconciliation-repository.js'
    source = (candidate/name).read_text()
    comment = (TASK/'baseline'/name).read_text()
    start = comment.index('      // Fulfilled/Pending Billing is terminal evidence')
    end = comment.index('      closed,', start)
    old = comment[start:end].replace('billed: billed && !locallyReopened,', 'billed,')
    assert source.count(old) == 1
    (candidate/name).write_text(source.replace(old, ''))
    name = 'src/server.js'
    source = (candidate/name).read_text()
    before = function_text(source, 'loadDispatchOrdersForResponse')
    assert before == function_text((TASK/'baseline'/name).read_text(), 'loadDispatchOrdersForResponse')
    after = function_text((SERVER/name).read_text(), 'loadDispatchOrdersForResponse')
    source = source.replace(before, after)
    assert source.count('  isBilledSalesOrderIdentifier,\n  listBilledSalesOrderFamilyRefs\n') == 1
    source = source.replace('  isBilledSalesOrderIdentifier,\n  listBilledSalesOrderFamilyRefs\n', '  isBilledSalesOrderIdentifier\n')
    (candidate/name).write_text(source)
    tree = core.files_at(candidate)
    changed = sorted(n for n in tree if tree[n] != data['workerBeforeTree'].get(n))
    assert changed == sorted(WORKER_FILES)
    data['workerTree'] = tree
    data['workerFiles'] = changed
    data['workerTreeHash'] = core.sha(json.dumps(tree, sort_keys=True).encode())
    core.save('manifest.json', data)
    (RELEASE/'worker-scoped.patch').write_text(''.join(''.join(difflib.unified_diff(
        (baseline/n).read_text().splitlines(True), (candidate/n).read_text().splitlines(True),
        fromfile='a/'+n, tofile='b/'+n)) for n in changed))
    print(json.dumps({'workerPrepared': True, 'changedFiles': changed}), flush=True)


def validate():
    data = core.state()
    core.current(data)
    assert core.files_at(RELEASE/'worker-candidate') == data['workerTree']
    out = TASK/'release-validation/final'
    layers = json.loads((out/'layers.json').read_text())
    assert all(row['passed'] for row in layers)
    assert next(row for row in layers if row['name']=='focused')['counts']['pass'] == 94
    assert json.loads((out/'dispatch-regressions.json').read_text())['newFailures'] == []
    hashes = json.loads((out/'runtime-hashes.json').read_text())
    assert all(hashes[n] == data['candidateTree'][n] for n in data['files'])
    coverage = json.loads((out/'changed-line-coverage.json').read_text())
    assert coverage and all(row['covered'] for row in coverage)
    integration_phase=os.environ.get('RECOVERY_RELEASE_INTEGRATION_PHASE','browser-deploy-derived-feed-green')
    app_log = (TASK/integration_phase/'gps-radius.log').read_text()
    assert '# tests 24\n' in app_log and '# pass 24\n' in app_log and '# fail 0\n' in app_log
    worker_log = (TASK/'browser-release-worker/billing.log').read_text()
    assert '# tests 10\n' in worker_log and '# pass 10\n' in worker_log and '# fail 0\n' in worker_log
    report = json.loads((TASK/'browser-release-app/results/browser-report.json').read_text())
    assert report['stats']['expected'] == 10 and report['stats']['unexpected'] == 0
    for phase in ['release-app','release-worker']:
        art = TASK/('browser-'+phase)
        assert (art/'teardown.log').exists()
        assert not re.search(r'^mbbs-driver-reconnect-', (art/'docker-ps-a.txt').read_text(), re.M)
    core.save('validation-passed.json', {'passed': True, 'atToronto': toronto(),
        'candidateTreeHash': data['candidateTreeHash'], 'workerTreeHash': data['workerTreeHash'],
        'focused':94, 'integration':24, 'mobile':10, 'workerBilling':10,
        'integrationPhase':integration_phase,
        'changedLinesCovered':len(coverage),'changedLinesTotal':len(coverage),
        'layers':layers, 'dispatch':json.loads((out/'dispatch-regressions.json').read_text()),
        'reproduce':'bash server/tools/driver-reconnect-release-verify.sh',
        'priorR2Evidence':str(TASK/'evidence.json'), 'r2ClientUnchanged':True})
    print(json.dumps({'validated':True,'focused':94,'integration':24,'mobile':10,'workerBilling':10}),flush=True)


def config_check(data):
    core.config_check(data)
    resolved = json.loads(subprocess.check_output(core.compose(data,'release')+['config','--format','json'],cwd=ROOT))
    for service,container,image_id in [('app',core.APP,data['candidateImageId']),('webhook-worker',WORKER,data['workerImageId'])]:
        service_config = resolved['services'][service]
        live = json.loads(core.docker('inspect',container))[0]
        image = json.loads(core.docker('image','inspect',image_id))[0]['Config']
        env = dict(entry.split('=',1) for entry in image.get('Env',[]))
        env.update({k:str(v) for k,v in service_config.get('environment',{}).items()})
        assert env == dict(entry.split('=',1) for entry in live['Config']['Env']), 'Environment would change: '+service
        for field,key in [('Cmd','command'),('Entrypoint','entrypoint'),('User','user'),('WorkingDir','working_dir')]:
            assert (image.get(field) if service_config.get(key) is None else service_config[key]) == live['Config'].get(field), service+':'+field
    core.save('config-check.json',{'appAndWorkerEnvironmentPreserved':True,'commandsPreserved':True,'imageOnlyOverrides':True})


def build():
    initial=core.state()
    validation=json.loads((RELEASE/'validation-passed.json').read_text())
    assert validation['workerTreeHash']==initial['workerTreeHash']
    assert core.files_at(RELEASE/'worker-candidate')==initial['workerTree']
    core.build()
    data=core.state()
    worker=next(row for row in data['dependencies'] if row['id']==core.metadata(WORKER)['id'])
    tag=WORKER_IMAGE+'-rollback'
    core.docker('tag',worker['imageId'],tag)
    stage=RELEASE/'worker-stage'
    for name in data['workerFiles']:
        target=stage/'overlay'/name
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(RELEASE/'worker-candidate'/name,target)
    (stage/'Dockerfile').write_text('FROM '+tag+'\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE/'worker-build.log').open('wb') as output:
        subprocess.run(['docker','build','--network','none','--pull=false','-t',WORKER_IMAGE,str(stage)],stdout=output,stderr=subprocess.STDOUT,check=True,timeout=180)
    data['workerImageId']=core.docker('image','inspect','--format','{{.Id}}',WORKER_IMAGE).decode().strip()
    core.save('manifest.json',data)
    actual=json.loads(core.bounded(data['workerImageId'],core.CHECK_NAME,'node','-e',core.HASH_SCRIPT))
    assert actual==data['workerTree']
    (RELEASE/'worker-import.log').write_bytes(core.bounded(data['workerImageId'],core.CHECK_NAME,'node','--input-type=module','-e',
        "await import('./src/server.js'); console.log(JSON.stringify({workerServerImport:true})); process.exit(0)"))
    for mode,app_image,worker_image in [('release',IMAGE,WORKER_IMAGE),('rollback',data['app']['imageId'],worker['imageId'])]:
        (RELEASE/('compose.'+mode+'.yml')).write_text('services:\n  app:\n    image: '+app_image+'\n    pull_policy: never\n  webhook-worker:\n    image: '+worker_image+'\n    pull_policy: never\n')
    config_check(data)
    core.save('worker-image-check.json',{'passed':True,'imageId':data['workerImageId'],'runtimeFiles':len(actual)})
    print(json.dumps({'bothImagesBuilt':True,'configurationPreserved':True}),flush=True)


def migration_state():
    return json.loads(core.sql("""BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT json_build_object(
 'registered',(SELECT count(*) FROM schema_migrations WHERE filename='295_driver_upload_recovery_audit.sql'),
 'index',(SELECT json_build_object('valid',indisvalid,'ready',indisready,'unique',indisunique,'definition',pg_get_indexdef(indexrelid)) FROM pg_index WHERE indexrelid=to_regclass('public.driver_upload_recovery_audit_identity')));
COMMIT;"""))


def migrate():
    before=migration_state()
    core.save('migration-before.json',before)
    if before['registered']==0:
        duplicate=int(core.sql("""BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT count(*) FROM (SELECT 1 FROM delivery_audit_log WHERE action='driver.photo_upload.recovered'
AND details->>'driverLogin' IS NOT NULL AND details->>'deviceId' IS NOT NULL AND details->>'failureId' IS NOT NULL
GROUP BY details->>'driverLogin',details->>'deviceId',details->>'failureId' HAVING count(*)>1) duplicates; COMMIT;"""))
        assert duplicate==0, 'Existing recovery identity duplicates require review'
        statement=(RELEASE/'candidate/migrations/295_driver_upload_recovery_audit.sql').read_text()
        core.sql("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SELECT pg_advisory_xact_lock(hashtext('driver-reconnect-migration-295'));\n"+statement+
            "\nINSERT INTO schema_migrations(filename) VALUES('295_driver_upload_recovery_audit.sql') ON CONFLICT DO NOTHING; COMMIT;")
    state=migration_state()
    assert state['registered']==1 and state['index']['valid'] and state['index']['ready'] and state['index']['unique']
    assert 'driver.photo_upload.recovered' in state['index']['definition']
    core.save('migration-result.json',{'atToronto':toronto(),'state':state,'businessRowsChanged':0,'additiveSchemaRetainedOnRollback':True})


def active():
    result=core.preflight()
    result['webhooksRunning']=int(core.sql("SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running' AND lease_expires_at>clock_timestamp();"))
    core.save('active-before-release.json',{'atToronto':toronto(),**result})
    core.assert_no_active_operations(result)


def accept_unchanged_restart():
    data=core.state()
    current=core.metadata(core.APP)
    assert current['imageId']==data['app']['imageId'], 'A different release requires a scoped rebase'
    assert current['configuration']==data['app']['configuration'], 'Runtime configuration changed'
    assert [core.metadata(n) for n in core.DEPENDENCIES]==data['dependencies']
    assert json.loads(core.docker('exec',core.APP,'node','-e',core.HASH_SCRIPT))==data['beforeTree']
    core.save('unchanged-restart.json',{'atToronto':toronto(),'previousApp':data['app'],'currentApp':current,'runtimeAndConfigurationUnchanged':True})
    data['app']=current
    core.save('manifest.json',data)
    core.current(data)
    print(json.dumps({'unchangedRestartVerified':True}),flush=True)


def rebase_unrelated():
    data=core.state()
    current=core.metadata(core.APP)
    assert current['configuration']==data['app']['configuration']
    assert [core.metadata(n) for n in core.DEPENDENCIES]==data['dependencies']
    tree=json.loads(core.docker('exec',core.APP,'node','-e',core.HASH_SCRIPT))
    changed=sorted(n for n in tree.keys()|data['beforeTree'].keys() if tree.get(n)!=data['beforeTree'].get(n))
    assert changed and not set(changed)&set(data['files']), 'Overlapping release requires a reviewed merge'
    fresh=RELEASE/'rebase-live'
    capture_runtime(core.APP,fresh)
    assert core.files_at(fresh)==tree and core.metadata(core.APP)==current
    assert all(core.sha((fresh/n).read_bytes())==v for n,v in data['packages'].items()), 'Production packages changed'
    archive=RELEASE/'before-unrelated-rebase'
    archive.mkdir()
    for name in ['before','candidate','manifest.json','validation-passed.json','image-check.json','config-check.json']:
        path=RELEASE/name
        if path.exists(): path.rename(archive/name)
    fresh.rename(RELEASE/'before')
    shutil.copytree(RELEASE/'before',RELEASE/'candidate')
    for name in data['files']:
        target=RELEASE/'candidate'/name
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(archive/'candidate'/name,target)
    after=core.files_at(RELEASE/'candidate')
    assert all(after[n]==data['candidateTree'][n] for n in data['files'])
    assert sorted(n for n in tree.keys()|after.keys() if tree.get(n)!=after.get(n))==data['files']
    data.update(app=current,beforeTree=tree,candidateTree=after,candidateTreeHash=core.sha(json.dumps(after,sort_keys=True).encode()))
    data.pop('candidateImageId',None)
    core.save('manifest.json',data)
    core.current(data)
    core.save('rebase-result.json',{'atToronto':toronto(),'preservedNewLiveFiles':{n:tree.get(n) for n in changed},'reconnectFilesByteIdentical':True})
    print(json.dumps({'rebased':True,'preservedNewLiveFiles':changed,'reconnectFilesByteIdentical':True}),flush=True)


def verify():
    data=core.state()
    core.ready(data['candidateImageId'])
    live=core.metadata(core.APP)
    assert live['imageId']==data['candidateImageId'] and live['configuration']==data['app']['configuration']
    old_worker=data['dependencies'][core.DEPENDENCIES.index(WORKER)]
    worker=core.metadata(WORKER)
    assert worker['imageId']==data['workerImageId'] and worker['configuration']==old_worker['configuration']
    for name,previous in zip(core.DEPENDENCIES,data['dependencies']):
        if name!=WORKER: assert core.metadata(name)==previous
    assert json.loads(core.docker('exec',core.APP,'node','-e',core.HASH_SCRIPT))==data['candidateTree']
    assert json.loads(core.docker('exec',WORKER,'node','-e',core.HASH_SCRIPT))==data['workerTree']
    for attempt in range(60):
        row=json.loads(core.docker('inspect',WORKER))[0]
        assert row['State']['Running'] and row['RestartCount']==0
        if row['State'].get('Health',{}).get('Status','healthy')=='healthy': break
        time.sleep(0.5)
    else: raise RuntimeError('Webhook worker did not become healthy')
    worker_log=core.docker('logs','--since',row['State']['StartedAt'],WORKER,stderr=subprocess.STDOUT).decode()
    assert re.search(r'NetSuite order webhook serial worker .+ started\.',worker_log), 'Worker startup message missing'
    assert not re.search(r'(^|\n)(?:Error:|SyntaxError:|ReferenceError:|TypeError:)',worker_log), 'Worker startup error'
    core.save('worker-startup-check.json',{'atToronto':toronto(),'started':True,'running':True,'restartCount':row['RestartCount']})
    public={n:data['candidateTree'][n] for n in data['files'] if n.startswith('public/')}
    http=core.http_check(public,[])
    script="""import assert from 'node:assert/strict';
const results={}; const version='20261016-driver-reconnect-v1';
for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
const opts={signal:AbortSignal.timeout(15000),headers:{'X-MBBS-Driver-Version':'2026.08.12.3','Cache-Control':'no-cache'}};
const page=await fetch(origin+'/driver',opts); assert.equal(page.status,200); assert.match(page.headers.get('cache-control')||'',/no-store/);
const html=await page.text(); assert.ok(html.includes('/driver.js?v='+version)); assert.ok(html.includes('/driver-upload.js?v='+version));
const sw=await fetch(origin+'/driver-service-worker.js?v='+version,opts); assert.equal(sw.status,200); assert.match(sw.headers.get('cache-control')||'',/no-store/); assert.equal(sw.headers.get('service-worker-allowed'),'/');
const health=await fetch(origin+'/api/driver/network-health',opts); assert.equal(health.status,200); assert.equal((await health.json()).ok,true);
const current=await fetch(origin+'/api/driver/client-version',opts); assert.equal(current.status,200); const body=await current.json(); assert.equal(body.currentVersion,'2026.08.12.3'); assert.equal(body.supported,true); assert.equal(body.reopenRequired,false);
assert.equal((await fetch(origin+'/api/driver/history',opts)).status,401);
assert.equal((await fetch(origin+'/api/driver/next-job',{signal:AbortSignal.timeout(15000)})).status,426);
results[origin]={driverPage:200,workerScope:'/',noStore:true,networkHealth:200,versionStatus:200,anonymousHistory:401,missingVersion:426,assetVersion:version};
}
console.log(JSON.stringify(results));"""
    probes=json.loads(core.docker('exec','-i',core.APP,'node','--input-type=module',input=script.encode(),timeout=90))
    schema=migration_state()
    assert schema['registered']==1 and schema['index']['valid'] and schema['index']['ready']
    result={'deployed':True,'atToronto':toronto(),'appImage':IMAGE,'workerImage':WORKER_IMAGE,
        'appImageId':data['candidateImageId'],'workerImageId':data['workerImageId'],'appConfigurationPreserved':True,
        'workerConfigurationPreserved':True,'databaseAndOllamaUnchanged':True,'appRuntimeFilesVerified':len(data['candidateTree']),
        'workerRuntimeFilesVerified':len(data['workerTree']),'migration':schema,'http':http,'driverProbes':probes,
        'driverShell':'v47','assetVersion':'20261016-driver-reconnect-v1','existingOpenPwaNeedsReload':True}
    core.save('deployment-result.json',result)
    print(json.dumps({k:result[k] for k in ['deployed','atToronto','appImage','workerImage','driverShell','existingOpenPwaNeedsReload']}),flush=True)


def apply():
    data=core.state()
    core.current(data)
    assert core.files_at(RELEASE/'worker-candidate')==data['workerTree']
    for filename,key in [('image-check.json','candidateImageId'),('worker-image-check.json','workerImageId')]:
        check=json.loads((RELEASE/filename).read_text()); assert check['passed'] and check['imageId']==data[key]
    config_check(data)
    active()
    migrate()
    core.current(data)
    active()
    leases=core.edit_lease_identities()
    assert core.docker('image','inspect','--format','{{.Id}}',IMAGE).decode().strip()==data['candidateImageId']
    assert core.docker('image','inspect','--format','{{.Id}}',WORKER_IMAGE).decode().strip()==data['workerImageId']
    args=['up','-d','--no-build','--no-deps','--pull','never','--timeout','65','app','webhook-worker']
    core.save('cutover-start.json',{'atToronto':toronto()})
    try:
        with (RELEASE/'publish.log').open('wb') as output:
            subprocess.run(core.compose(data,'release')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=150)
        verify()
        core.save('editing-lease-result.json',{'before':leases,'after':core.edit_lease_identities(),'deploymentModifiedLeases':False})
    except BaseException:
        def present_image(name):
            ids=core.docker('ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}').strip()
            return core.metadata(name)['imageId'] if ids else None
        app_image=present_image(core.APP); worker_image=present_image(WORKER)
        previous=data['dependencies'][core.DEPENDENCIES.index(WORKER)]
        if app_image in [None,data['candidateImageId'],data['app']['imageId']] and worker_image in [None,data['workerImageId'],previous['imageId']]:
            with (RELEASE/'rollback.log').open('wb') as output:
                subprocess.run(core.compose(data,'rollback')+args,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,check=True,timeout=150)
            core.ready(data['app']['imageId'])
            core.save('rollback-result.json',{'atToronto':toronto(),'appRestored':True,'workerRestored':core.metadata(WORKER)['imageId']==previous['imageId'],'additiveIndexRetained':True})
        raise


if __name__ == '__main__':
    if RELEASE.exists():
        atexit.register(core.cleanup_manual)
    {'capture': capture, 'worker-candidate': worker_candidate, 'validate':validate, 'build':build, 'preflight':active, 'accept-unchanged-restart':accept_unchanged_restart, 'rebase-unrelated':rebase_unrelated, 'apply':apply, 'verify':verify}[sys.argv[1]]()

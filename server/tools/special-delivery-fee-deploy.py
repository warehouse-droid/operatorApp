"""Scoped delivery-fee/local-submit release over the current running app."""
import datetime
import difflib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/special-delivery-fee-20261001'
OUT = SERVER / 'test-artifacts/special-delivery-fee-20261001'
FILES = json.loads((SERVER / 'tools/special-delivery-fee-files.json').read_text())
IMAGE = 'mbbs-operator-app:special-delivery-fee-20261001'
MIGRATIONS = ['251_special_delivery_fee.sql', '252_special_sales_rep_cache.sql', '253_special_custom_po_linkage.sql']
spec = importlib.util.spec_from_file_location('delivery_release_parent', SERVER / 'tools/scm-schedule-multi-sort-deploy.py')
parent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parent)
parent.RELEASE, parent.OUT, parent.FILES, parent.IMAGE = RELEASE, OUT, FILES, IMAGE
parent.core.RELEASE = RELEASE
APP, docker, metadata, digest = parent.APP, parent.docker, parent.metadata, parent.digest
WORKER = 'mbbs-operator-app-webhook-worker-1'
WORKER_FILES = ['src/special-stock-request-repository.js', 'migrations/253_special_custom_po_linkage.sql']
parent.core.CONTAINERS = {'app': APP, 'webhook-worker': WORKER}


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before
    parent.save('capture.json', {'before': before, 'untouched': {name: metadata(name) for name in parent.UNTOUCHED}})
    print(json.dumps({'captured': True, 'parent': before['image']}), flush=True)


def stage():
    captured = json.loads((RELEASE / 'capture.json').read_text())
    assert metadata(APP) == captured['before']
    candidate = RELEASE / 'candidate'
    shutil.copytree(RELEASE / 'before', candidate, dirs_exist_ok=True)
    patch = ''
    for file in FILES:
        old, base, updated = RELEASE / 'before' / file, OUT / 'before' / file, SERVER / file
        original = old.read_text() if old.exists() else ''
        if old.exists() and base.exists() and old.read_bytes() != base.read_bytes():
            merged = subprocess.run(['git', 'merge-file', '-p', str(updated), str(base), str(old)], text=True, capture_output=True)
            assert merged.returncode == 0, 'Resolve concurrent changes: ' + file
            content = merged.stdout
        else:
            assert old.exists() == base.exists(), 'Unexpected live file: ' + file
            content = updated.read_text()
        target = candidate / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), content.splitlines(True), fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    old_tree, new_tree = parent.core.files_at(RELEASE / 'before'), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(FILES)
    (RELEASE / 'changes.patch').write_text(patch)
    parent.save('manifest.json', {'services': {'app': {'before': captured['before'], 'image': IMAGE}},
        'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
        'sourceHashes': {file: new_tree[file] for file in FILES}, 'untouched': captured['untouched']})
    parent.save('source-tree.json', new_tree)
    parent.current(parent.state())
    print(json.dumps({'staged': True, 'mergedFiles': [file for file in FILES if new_tree[file] != digest((SERVER / file).read_bytes())]}), flush=True)
    stage_worker()


def stage_worker():
    captured = json.loads((RELEASE / 'capture.json').read_text())['untouched'][WORKER]
    assert metadata(WORKER) == captured
    baseline = RELEASE / 'before-worker'
    if not baseline.exists():
        baseline.mkdir()
        for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', WORKER + ':/app/' + name, '-'))) as archive:
                archive.extractall(baseline, filter='data')
        assert metadata(WORKER) == captured
    candidate = RELEASE / 'candidate-worker'
    shutil.copytree(baseline, candidate, dirs_exist_ok=True)
    file = WORKER_FILES[0]
    merged = subprocess.run(['git', 'merge-file', '-p', str(SERVER / file),
        str(SERVER / 'test-artifacts/special-custom-po-20261001/before' / file), str(baseline / file)], text=True, capture_output=True)
    assert merged.returncode == 0, 'Resolve worker source conflicts before publication'
    (candidate / file).write_text(merged.stdout)
    shutil.copy2(SERVER / WORKER_FILES[1], candidate / WORKER_FILES[1])
    old_tree, new_tree = parent.core.files_at(baseline), parent.core.files_at(candidate)
    assert sorted(file for file in new_tree if old_tree.get(file) != new_tree[file]) == sorted(WORKER_FILES)
    (RELEASE / 'worker-changes.patch').write_text(''.join(''.join(difflib.unified_diff(
        (baseline / file).read_text().splitlines(True) if (baseline / file).exists() else [],
        (candidate / file).read_text().splitlines(True), fromfile='a/' + file, tofile='b/' + file)) for file in WORKER_FILES))
    parent.save('worker-source-tree.json', new_tree)
    data = parent.state()
    data['services']['webhook-worker'] = {'before': captured, 'image': 'mbbs-operator-app:special-custom-po-worker-20261001',
        'files': WORKER_FILES, 'sourceHashes': {file: new_tree[file] for file in WORKER_FILES}}
    parent.save('manifest.json', data)
    print(json.dumps({'workerStaged': True, 'workerFiles': WORKER_FILES}), flush=True)


def check_worker():
    spec = importlib.util.spec_from_file_location('custom_po_worker_runner', SERVER / 'tools/special-delivery-fee-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.REMOTE = '/tmp/special-custom-po-worker-20261001'
    root = RELEASE / 'candidate-worker'
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', root)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    assert runner.run('worker-custom-po-syntax', ['node', '--check', WORKER_FILES[0]]) == 0
    assert runner.run('worker-custom-po-tests', ['node', '--test', 'test/mbt/integration/special-custom-po-http.test.js']) == 0
    data = parent.state()
    assert parent.core.files_at(root) == json.loads((RELEASE / 'worker-source-tree.json').read_text())
    parent.save('worker-checks.json', {'completed': True, 'sourceHashes': data['services']['webhook-worker']['sourceHashes'], 'httpTests': 4})


def validate_candidate():
    data = parent.state()
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['sourceHashes'] == data['sourceHashes'], 'Run final checks on this candidate first'
    worker = json.loads((RELEASE / 'worker-checks.json').read_text())
    assert worker['completed'] and worker['sourceHashes'] == data['services']['webhook-worker']['sourceHashes']
    assert parent.core.files_at(RELEASE / 'candidate-worker') == json.loads((RELEASE / 'worker-source-tree.json').read_text())


def prepare():
    data = parent.state()
    parent.current(data)
    validate_candidate()
    for service, row in data['services'].items():
        stage = RELEASE / ('stage' if service == 'app' else 'stage-worker')
        candidate = RELEASE / ('candidate' if service == 'app' else 'candidate-worker')
        for file in FILES if service == 'app' else WORKER_FILES:
            target = stage / 'overlay' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate / file, target)
        before = row['before']
        assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
        (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
        with (RELEASE / (service + '-build.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'], str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip()
        tree_file = 'source-tree.json' if service == 'app' else 'worker-source-tree.json'
        assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['image'], '-e', parent.HASH)) == json.loads((RELEASE / tree_file).read_text())
        docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
            '--entrypoint', 'node', row['image'], '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for kind in ['release', 'rollback']:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n' + ''.join('  ' + service + ':\n    image: ' + (row['image'] if kind == 'release' else row['before']['imageId']) + '\n' for service, row in data['services'].items()))
    parent.core.config_check(data)
    parent.current(data)
    parent.save('manifest.json', data)
    print(json.dumps({'prepared': True, 'services': {service: row['candidateImageId'] for service, row in data['services'].items()}}), flush=True)


def refresh_after_rollback():
    data = parent.state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['restoredPreviousApp']
    for service, container, folder in [('app', APP, 'before'), ('webhook-worker', WORKER, 'before-worker')]:
        previous = data['services'][service]['before']
        restored = metadata(container)
        assert restored['imageId'] == previous['imageId'], 'Rollback image changed: ' + service
        assert restored['configuration'] == previous['configuration'], 'Rollback configuration changed: ' + service
        assert json.loads(docker('exec', container, 'node', '-e', parent.HASH)) == parent.core.files_at(RELEASE / folder), 'Rollback source changed: ' + service
        assert docker('image', 'inspect', '--format', '{{.Id}}', data['services'][service]['image']).decode().strip() == data['services'][service]['candidateImageId']
        data['services'][service]['before'] = restored
    assert {name: metadata(name) for name in parent.UNTOUCHED if name != WORKER} == {name: value for name, value in data['untouched'].items() if name != WORKER}
    data['untouched'][WORKER] = data['services']['webhook-worker']['before']
    parent.current(data)
    validate_candidate()
    parent.core.config_check(data)
    archive = RELEASE / 'first-publish-attempt'
    archive.mkdir(exist_ok=False)
    for name in ['manifest.json', 'publish.log', 'rollback.log', 'rollback-result.json', 'active-before-release.json', 'cache-warm.json']:
        shutil.copy2(RELEASE / name, archive / name)
    parent.save('manifest.json', data)
    parent.save('retry-baseline.json', {'restoredAppAndWorkerVerified': True, 'sourceAndConfigurationPreserved': True,
        'databaseAndOllamaPreserved': True, 'candidateImagesUnchanged': True})
    print(json.dumps({'retryBaselineVerified': True, 'appAndWorkerRestored': True}), flush=True)


def verify():
    data = parent.state()
    parent.core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in parent.UNTOUCHED if name != WORKER} == {name: value for name, value in data['untouched'].items() if name != WORKER}
    assert json.loads(docker('exec', APP, 'node', '-e', parent.HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    worker = metadata(WORKER)
    assert worker['imageId'] == data['services']['webhook-worker']['candidateImageId']
    assert worker['configuration'] == data['services']['webhook-worker']['before']['configuration']
    assert json.loads(docker('exec', WORKER, 'node', '-e', parent.HASH)) == json.loads((RELEASE / 'worker-source-tree.json').read_text())
    state = json.loads(docker('inspect', WORKER))[0]
    assert state['State']['Running'] and state['RestartCount'] == 0
    for migration in MIGRATIONS:
        assert parent.database("SELECT count(*) FROM schema_migrations WHERE filename='" + migration + "'") == '1'
    code = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES,routes={'public/sales-stock-requests.html':'/sales/stock-requests','public/scm-stock-requests.html':'/scm/stock-requests'};
let publicReadRetries=0;
async function read(url,options={}){
 for(let attempt=1;attempt<=3;attempt++){
  try{return await fetch(url,{...options,signal:AbortSignal.timeout(30000)});}
  catch(error){
   if(attempt===3||!url.startsWith('https://test.mbbsoperation.com/')||error.cause?.code!=='UND_ERR_CONNECT_TIMEOUT')throw error;
   publicReadRetries++;
   console.error(JSON.stringify({publicReadRetry:attempt,path:new URL(url).pathname,code:error.cause.code}));
   await new Promise(resolve=>setTimeout(resolve,attempt*1000));
  }
 }
}
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await read(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const response=await read(base+(routes[file]||'/'+file.slice(7)),{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,file);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,file);
 }
}
const {query,closeDb}=await import('./src/db.js');
try{const row=(await query('SELECT attention,attention_reason FROM sales_special_stock_cases WHERE request_id=95')).rows[0];assert.equal(row.attention,false);assert.equal(row.attention_reason,null);
const lines=(await query('SELECT order_kind,item_id,quantity,unit_rate FROM sales_special_stock_order_lines WHERE request_id=95 AND item_id=1987')).rows;assert.equal(lines.length,1);assert.equal(lines[0].order_kind,'sales_order');assert.equal(Number(lines[0].unit_rate),235);
const materials=(await query('SELECT uom FROM sales_special_stock_order_lines WHERE request_id=95 AND item_id=2055')).rows;assert.equal(materials.length,6);assert.ok(materials.every(line=>line.uom==='SQFT'));
const reps=(await query('SELECT reps FROM special_stock_sales_rep_cache WHERE singleton')).rows[0].reps;assert.ok(reps.length);
const {specialSalesReps}=await import('./src/special-stock-sales-reps.js');const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Submission validation must stay local');};
const started=performance.now();assert.deepEqual(await specialSalesReps.select(reps[0].id,{localOnly:true}),reps[0]);const localSelectionMs=performance.now()-started;assert.ok(localSelectionMs<1000);globalThis.fetch=originalFetch;
console.log(JSON.stringify({health:true,publicAssets:true,request24Resolved:true,request24Unit:'SQFT',deliveryCharge:235,localSelectionMs,publicReadRetries}));}finally{await closeDb();}
"""
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    parent.save('result.json', {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
        'imageId': actual['imageId'], 'workerImageId': worker['imageId'], 'configurationPreserved': True, 'untouchedServicesPreserved': True, 'migrations': MIGRATIONS, **live})
    print(json.dumps({'deployed': True, **live}), flush=True)


def apply():
    data = parent.state()
    parent.current(data)
    validate_candidate()
    parent.core.config_check(data)
    activity_sql = """SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""
    active = json.loads(parent.database(activity_sql))
    parent.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    for migration in MIGRATIONS:
        if parent.database("SELECT count(*) FROM schema_migrations WHERE filename='" + migration + "'") == '0':
            parent.database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + (RELEASE / 'candidate/migrations' / migration).read_text() + "\nINSERT INTO schema_migrations(filename) VALUES('" + migration + "'); COMMIT;")
    warm = r"""import {specialSalesReps} from './src/special-stock-sales-reps.js';import {query,closeDb} from './src/db.js';
try{const reps=await specialSalesReps.list();if(!reps.length)throw Error('Sales Rep directory is empty');await query(`INSERT INTO special_stock_sales_rep_cache(singleton,reps) VALUES(true,$1::jsonb) ON CONFLICT(singleton) DO UPDATE SET reps=EXCLUDED.reps,refreshed_at=now()`,[JSON.stringify(reps)]);console.log(JSON.stringify({verifiedSalesReps:reps.length}));}finally{await closeDb();}"""
    parent.save('cache-warm.json', json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=warm.encode())))
    parent.current(data)
    assert not any(json.loads(parent.database(activity_sql)).values()), 'Wait for operations started during cache refresh'
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(parent.core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(parent.core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app', 'webhook-worker'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        parent.core.core.ready(data['services']['app']['before']['imageId'])
        parent.save('rollback-result.json', {'restoredPreviousApp': True, 'restoredPreviousWorker': True, 'additiveSchemaRetained': True})
        raise


parent.validate_candidate = validate_candidate
if __name__ == '__main__':
    {'capture': capture, 'stage': stage, 'worker-check': check_worker, 'prepare': prepare, 'refresh-after-rollback': refresh_after_rollback, 'apply': apply, 'verify': verify}[sys.argv[1]]()

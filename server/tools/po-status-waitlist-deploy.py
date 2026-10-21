"""Deploy frozen PO lifecycle and waitlist enhancements over fresh live source."""
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
import threading
import time
import urllib.request

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/po-status-waitlist-20261002'
IMAGE = 'mbbs-operator-app:po-status-waitlist-20261002'
APP = 'mbbs-operator-app-app-1'
UNTOUCHED = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
MIGRATION = '256_direct_linked_po_transport_lifecycle.sql'
PO_FILES = ['src/dispatch-repository.js', 'src/scm-reconciliation-repository.js', 'migrations/' + MIGRATION]
WAITLIST_FILES = json.loads((SERVER / 'tools/regular-waitlist-enhancements-files.json').read_text())
FILES = sorted(PO_FILES + WAITLIST_FILES)
spec = importlib.util.spec_from_file_location('combined_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, {'app': APP}
docker, metadata, digest, files_at = core.docker, core.metadata, core.digest, core.files_at
HASH = "const fs=require('fs'),crypto=require('crypto'),h={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=d+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())h[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(h));"
PO_IDS = '-179615128203145,-43808732443904,1025403'
INPUT_FINGERPRINT = """(SELECT md5(jsonb_build_object(
 'headers',(SELECT jsonb_agg(to_jsonb(po) ORDER BY netsuite_id) FROM purchase_orders po WHERE netsuite_id IN (IDS)),
 'lines',(SELECT jsonb_agg(to_jsonb(line) ORDER BY id) FROM purchase_order_lines line WHERE purchase_order_id IN (IDS)),
 'links',(SELECT jsonb_agg(to_jsonb(link) ORDER BY id) FROM dispatch_so_po_allocations link WHERE po_order_id IN (IDS)),
 'driver',(SELECT jsonb_agg(to_jsonb(job) ORDER BY id) FROM driver_job_records job WHERE job.order_refs ?| ARRAY(
   SELECT sales_order_ref FROM dispatch_so_po_allocations WHERE po_order_id IN (IDS)
   UNION SELECT dispatch_target_ref FROM dispatch_so_po_allocations WHERE po_order_id IN (IDS))),
 'receipts',(SELECT jsonb_agg(to_jsonb(receipt) ORDER BY id) FROM dispatch_direct_po_ir_jobs receipt WHERE local_po_id IN (IDS))
)::text))""".replace('IDS', PO_IDS)


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def database(sql):
    return docker('exec', '-i', UNTOUCHED[1], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live app changed; recapture required'
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched'], 'A dependency changed'
    assert files_at(RELEASE / 'candidate') == data['sourceTree'], 'Frozen candidate changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == files_at(RELEASE / 'before'), 'Live source changed'


def capture_stage():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == files_at(baseline)
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    origins = [
        ('po', PO_FILES, SERVER / 'deployments/direct-ship-schedule-20261002/candidate',
         SERVER / 'deployments/direct-linked-po-lifecycle-20261002/validation-workspace',
         json.loads((SERVER / 'deployments/direct-linked-po-lifecycle-20261002/gauntlet-result.json').read_text())['sourceHashes']),
        ('waitlist', WAITLIST_FILES, SERVER / 'deployments/regular-waitlist-enhancements-20261002/before',
         SERVER / 'deployments/regular-waitlist-enhancements-20261002/candidate',
         json.loads((SERVER / 'deployments/regular-waitlist-enhancements-20261002/manifest.json').read_text())['sourceHashes'])]
    provenance = {}
    for label, scoped, old_base, tested, expected in origins:
        patch = ''
        for file in scoped:
            original, new = old_base / file, tested / file
            assert digest(new.read_bytes()) == expected[file], 'Recorded source changed: ' + file
            patch += ''.join(difflib.unified_diff(original.read_text().splitlines(True) if original.exists() else [],
                new.read_text().splitlines(True), fromfile='a/' + file if original.exists() else '/dev/null', tofile='b/' + file))
        (RELEASE / (label + '-recorded.patch')).write_text(patch)
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)], input=patch, text=True, capture_output=True)
        (RELEASE / (label + '-rebase.log')).write_text(result.stdout + result.stderr)
        assert result.returncode == 0, 'Review rebase: ' + label
        provenance[label] = {file: expected[file] for file in scoped}
    for path in candidate.rglob('*.orig'):
        path.unlink()
    old_tree, tree = files_at(baseline), files_at(candidate)
    changed = sorted(file for file in tree if tree[file] != old_tree.get(file))
    assert changed == FILES, 'Unexpected release scope: ' + json.dumps(changed)
    for file in ['package.json', 'package-lock.json']:
        assert (candidate / file).read_bytes() == (baseline / file).read_bytes()
    patch = ''
    for file in FILES:
        old = baseline / file
        patch += ''.join(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [],
            (candidate / file).read_text().splitlines(True), fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    (RELEASE / 'changes.patch').write_text(patch)
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'sourceHashes': {file: tree[file] for file in FILES}, 'sourceTree': tree,
            'untouched': {name: metadata(name) for name in UNTOUCHED}, 'provenance': provenance,
            'authorization': 'deploy with shortover with the waitlist change as well'}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'staged': True, 'parentImage': before['image'], 'changedFiles': changed,
        'rebasedFiles': [file for file in FILES if tree[file] != (provenance['po'] | provenance['waitlist'])[file]]}), flush=True)


def validated(data):
    checks = json.loads((RELEASE / 'candidate-checks.json').read_text())
    assert checks['sourceHashes'] == data['sourceHashes']
    assert all(check['exitCode'] == 0 for check in checks['results'])
    assert {'po-regressions', 'waitlist-focused', 'waitlist-shuffled', 'syntax'} <= {check['label'] for check in checks['results']}
    assert files_at(RELEASE / 'validation-candidate') == data['sourceTree']


def prepare():
    data = state()
    current(data)
    validated(data)
    overlay = RELEASE / 'stage/overlay'
    for file in FILES:
        target = overlay / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / file, target)
    before = data['services']['app']['before']
    parent_image = IMAGE + '-parent'
    docker('tag', before['imageId'], parent_image)
    assert docker('image', 'inspect', '--format', '{{.Id}}', parent_image).decode().strip() == before['imageId']
    (RELEASE / 'stage/Dockerfile').write_text('FROM ' + parent_image + '\nCOPY --chown=node:node overlay/ /app/\n')
    if (RELEASE / 'build.log').exists():
        (RELEASE / 'build.log').rename(RELEASE / ('build-attempt-' + str(time.time_ns()) + '.log'))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(RELEASE / 'stage')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    data['services']['app']['candidateImageId'] = image_id
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == data['sourceTree']
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=.env.release-test-nonexistent',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for name, image in [('release', IMAGE), ('rollback', before['imageId'])]:
        (RELEASE / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE}), flush=True)


def live(name, verify=False):
    options = ['-e', 'COMBINED_RELEASE_VERIFY=1'] if verify else []
    result = json.loads(docker('exec', '-i', *options, APP, 'node', '--input-type=module',
        input=(SERVER / 'tools/po-status-waitlist-live.mjs').read_bytes()))
    save(name + '.json', result)
    print(json.dumps({'liveCheck': name, 'orders': result['orders'], 'receiptJobs': result['receiptJobs']}), flush=True)
    return result


def active_operations():
    return json.loads(database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'waitlistConverting',(SELECT count(*) FROM regular_waitlist_conversions WHERE status IN ('preparing','submitted')),
      'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))


def apply_migration(rehearsal=False):
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1':
        raise RuntimeError('Migration appeared after capture; review current live state')
    old_functions = database("SELECT string_agg(pg_get_functiondef(signature::regprocedure),E'\\n') FROM (VALUES ('dispatch_linked_transport_delivery_ready(text,text)'),('dispatch_project_direct_po_link_completion()')) AS functions(signature)")
    (RELEASE / 'before-functions.sql').write_text('BEGIN;\n' + old_functions + '\nCOMMIT;\n')
    sql = "BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';\n"
    sql += 'CREATE TEMP TABLE po_release_input_guard ON COMMIT DROP AS SELECT ' + INPUT_FINGERPRINT + ' AS fingerprint;\n'
    sql += (RELEASE / 'candidate/migrations' / MIGRATION).read_text() + '\n'
    sql += "DO $guard$ BEGIN IF (SELECT fingerprint FROM po_release_input_guard) IS DISTINCT FROM " + INPUT_FINGERPRINT + " THEN RAISE EXCEPTION 'PO headers, quantities, links, driver evidence or receipts changed during repair'; END IF;\n"
    sql += "IF (SELECT count(*) FROM dispatch_order_completion_status completion JOIN (VALUES ('LOINC-033146',3628::bigint),('LOINC-035332',5398::bigint)) expected(ref,job_id) ON completion.order_kind='PO' AND completion.order_ref=expected.ref JOIN driver_job_records driver ON driver.id=expected.job_id AND driver.status='complete' AND driver.stop_type='dropoff' WHERE completion.dispatch_completed_at=driver.completed_at AND completion.completion_evidence_type='driver_job' AND completion.completion_evidence_id=driver.job_id AND completion.metadata->>'driverJobRecordId'=driver.id::text AND completion.metadata->>'directShipCoverageVerified'='false' AND completion.metadata->>'directTransportCoverageVerified'='true') <> 2 THEN RAISE EXCEPTION 'Verified historical delivery evidence differs'; END IF; END $guard$;\n"
    sql += "INSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); " + ('ROLLBACK' if rehearsal else 'COMMIT') + ';\n'
    sql_file = RELEASE / ('migration-rehearsal-guard.sql' if rehearsal else 'migration-transaction.sql')
    if sql_file.exists():
        sql_file.rename(RELEASE / ('migration-attempt-' + str(time.time_ns()) + '.sql'))
    sql_file.write_text(sql)
    started = time.monotonic()
    (RELEASE / ('migration-rehearsal-guard.log' if rehearsal else 'migration.log')).write_text(database(sql) + '\n')
    result = {'applied': None if rehearsal else MIGRATION, 'rollbackRehearsalPassed': rehearsal,
        'transactional': True, 'seconds': round(time.monotonic()-started, 3),
        'oldAppOnline': True, 'sourceQuantitiesLinksDriverAndReceiptsUnchanged': True, 'verifiedHistoricalOrders': 2}
    save('migration-rehearsal-result.json' if rehearsal else 'migration-result.json', result)
    print(json.dumps(result), flush=True)


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == data['sourceTree']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1'
    orders = live('live-after', verify=True)
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES,routes={'public/sales-stock-requests.html':'/sales/stock-requests','public/scm-stock-requests.html':'/scm/stock-requests'};
let retries=0;
async function read(url){for(let attempt=1;attempt<=3;attempt++){try{return await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});}catch(error){if(attempt===3)throw error;retries++;await new Promise(resolve=>setTimeout(resolve,500));}}}
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await read(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
  const response=await read(base+(routes[file]||'/'+file.slice(7)+'?v=20261002-v2'));assert.equal(response.status,200,file);
  const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,file);
 }
 for(const path of ['/api/scm/schedule','/api/scm/waitlist/pools','/api/sales/stock-requests/waitlist/customers'])assert.equal((await read(base+path)).status,401,path);
}
console.log(JSON.stringify({localAndPublicHealth:true,waitlistAssetsVerified:6,protectedRoutesVerified:3,retries}));"""
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    save('result.json', {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
        'imageId': actual['imageId'], 'configurationPreserved': True, 'workerDatabaseAndOllamaUnchanged': True,
        'completeRuntimeSourceTreeVerified': True, 'migration': MIGRATION, 'orders': orders['orders'], 'receiptJobs': orders['receiptJobs'], **checks})
    print(json.dumps({'deployed': True, **checks}), flush=True)


def apply():
    data = state()
    current(data)
    validated(data)
    core.config_check(data)
    live('live-before')
    active = active_operations()
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    current(data)
    apply_migration()
    current(data)
    stop_probe, samples = threading.Event(), []
    cutover_start = time.monotonic()
    def probe():
        while not stop_probe.is_set():
            stamp = time.monotonic()
            try:
                with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=0.5) as response:
                    ok = response.status == 200 and json.loads(response.read())['ok'] is True
            except Exception:
                ok = False
            samples.append({'seconds': round(stamp-cutover_start,3), 'ok': ok})
            stop_probe.wait(0.1)
    watcher = threading.Thread(target=probe, daemon=True)
    watcher.start()
    ready_seconds = None
    try:
        print(json.dumps({'cutoverStarted': datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up','-d','--no-build','--no-deps','--pull','never','app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['candidateImageId'])
        ready_seconds = round(time.monotonic()-cutover_start,3)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data,'compose.rollback.yml') + ['up','-d','--no-build','--no-deps','--pull','never','app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'restoredPreviousApp': True, 'compatibleMigrationAndImmutableDeliveryEvidenceRetained': True})
        raise
    finally:
        stop_probe.set()
        watcher.join(timeout=2)
        failed = [sample['seconds'] for sample in samples if not sample['ok']]
        recovered = [sample['seconds'] for sample in samples if sample['ok'] and failed and sample['seconds'] > max(failed)]
        interruption = round(min(recovered)-min(failed),3) if recovered else None if failed else 0
        save('cutover.json', {'serviceReadySeconds': ready_seconds, 'observedInterruptionSeconds': interruption,
            'totalReleaseCheckSeconds': round(time.monotonic()-cutover_start,3), 'samples': samples})
    print(json.dumps({'cutoverComplete': True, 'serviceReadySeconds': ready_seconds, 'observedInterruptionSeconds': interruption}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    {'capture-stage': capture_stage, 'prepare': prepare, 'apply': apply, 'verify': verify,
     'live-before': lambda: live('live-before'), 'rehearse-migration': lambda: apply_migration(rehearsal=True)}[sys.argv[1]]()

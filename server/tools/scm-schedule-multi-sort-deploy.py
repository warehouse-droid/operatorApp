"""Deploy the requested Schedule changes over the verified PO Note app."""
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
RELEASE = SERVER / 'deployments/scm-schedule-multi-sort-20261001'
OUT = SERVER / 'test-artifacts/scm-schedule-deploy-20261001'
APP = 'mbbs-operator-app-app-1'
UNTOUCHED = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:scm-schedule-multi-sort-20261001'
MIGRATION = '248_scm_schedule_multi_filters.sql'
HTML_ROUTE = '/scm/POTOschedule'
HTML_ROUTES = {}
FILES = json.loads((SERVER / 'tools/scm-schedule-multi-sort-files.json').read_text())
spec = importlib.util.spec_from_file_location('schedule_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, {'app': APP}
docker, digest, metadata = core.docker, core.digest, core.metadata
HASH = """const fs=require('fs'),crypto=require('crypto'),hashes={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(hashes));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['workspaceHashes'], 'Selected workspace source changed'
    assert metadata(APP) == data['services']['app']['before'], 'Running app changed; recapture before publishing'
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched'], 'An untouched service changed'
    assert core.files_at(RELEASE / 'candidate') == json.loads((RELEASE / 'source-tree.json').read_text()), 'Candidate source changed'


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    OUT.mkdir(exist_ok=True)
    before = metadata(APP)
    note = json.loads((SERVER / 'deployments/special-po-so-note-20261001/manifest.json').read_text())
    assert before['imageId'] == note['services']['app']['candidateImageId'], 'Use the verified Note deployment as this parent'
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for file in FILES:
        old = baseline / file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        target = candidate / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(updated)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                           fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    (RELEASE / 'changes.patch').write_text(patch)
    old_tree, new_tree = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in new_tree if old_tree.get(file) != new_tree[file])
    assert changed == sorted(FILES), changed
    # Only dispatch-repository.js overlaps the Note release. Its source Note
    # mapping must survive alongside the new schedule filter predicates.
    assert 'COALESCE(po.netsuite_note, po.dispatch_instructions) AS source_note' in (candidate / 'src/dispatch-repository.js').read_text()
    for file in note['services']['app']['files']:
        if file != 'src/dispatch-repository.js':
            assert new_tree[file] == note['services']['app']['sourceHashes'][file], 'Note source changed: ' + file
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
            'sourceHashes': {file: new_tree[file] for file in FILES},
            'untouched': {name: metadata(name) for name in UNTOUCHED}, 'noteSourcePreserved': True}
    save('source-tree.json', new_tree)
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'changedFiles': changed, 'parent': before['image'], 'noteSourcePreserved': True}), flush=True)


def validate_candidate():
    spec = importlib.util.spec_from_file_location('schedule_test_runner', SERVER / 'tools/special-po-so-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.OUT, runner.REMOTE = OUT, '/tmp/scm-schedule-multi-sort-20261001'
    root = RELEASE / 'validation'
    shutil.copytree(RELEASE / 'candidate', root, dirs_exist_ok=True)
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', root)
    for file in ['src/scm-schedule-column-filter-harness.js', 'src/scm-schedule-column-filter-integration-harness.js',
                 'src/scm-schedule-preference-harness.js']:
        shutil.copy2(SERVER / file, root / file)
    for file in FILES:
        old = RELEASE / 'before' / file
        if old.exists():
            target = root / 'test-artifacts/scm-schedule-deploy-20261001/before' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, target)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    assert runner.run('checks', ['node', 'tools/scm-schedule-multi-sort-check.mjs']) == 0
    with tarfile.open(fileobj=io.BytesIO(docker('cp', runner.RUNNER + ':' + runner.REMOTE + '/test-artifacts/scm-schedule-deploy-20261001/.', '-'))) as archive:
        archive.extractall(OUT, filter='data')
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and not checks['newFailures']
    assert checks['sourceHashes'] == state()['sourceHashes']


def prepare():
    data = state()
    current(data)
    validate_candidate()
    stage = RELEASE / 'stage'
    for file in FILES:
        target = stage / 'overlay' / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / file, target)
    before = data['services']['app']['before']
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for kind, image in [('release', IMAGE), ('rollback', before['imageId'])]:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'imageId': data['services']['app']['candidateImageId']}), flush=True)


def database(sql):
    return docker('exec', '-i', UNTOUCHED[1], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def refresh_after_rollback():
    data = state()
    assert json.loads((RELEASE / 'rollback-result.json').read_text())['rolledBackToNoteImage']
    previous = data['services']['app']['before']
    restored = metadata(APP)
    assert restored['imageId'] == previous['imageId'], 'Rollback parent image changed'
    assert restored['configuration'] == previous['configuration'], 'Rollback configuration changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == core.files_at(RELEASE / 'before'), 'Rollback source changed'
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['services']['app']['candidateImageId']
    data['services']['app']['before'] = restored
    current(data)
    core.config_check(data)
    archive = RELEASE / 'first-attempt'
    archive.mkdir(exist_ok=False)
    for name in ['manifest.json', 'publish.log', 'rollback.log', 'rollback-result.json', 'active-before-release.json']:
        shutil.copy2(RELEASE / name, archive / name)
    save('manifest.json', data)
    save('retry-baseline.json', {'restoredParentVerified': True, 'sourceAndConfigurationPreserved': True,
                               'untouchedServicesPreserved': True, 'candidateImageUnchanged': True})
    print(json.dumps({'retryBaselineVerified': True, 'parentImageId': restored['imageId']}), flush=True)


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1'
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES,htmlRoutes=HTML_ROUTES;
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
 const path=file.endsWith('.html')?(htmlRoutes[file]||HTML_ROUTE):'/'+file.slice(7);
 const response=await read(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);
 }
 const protectedRoute=await read(base+'/api/scm/schedule-preferences/scm');assert.equal(protectedRoute.status,401);
}
const {query,closeDb}=await import('./src/db.js');
try {
 const columns=(await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='scm_schedule_user_preferences' AND column_name=ANY($1::text[])",[['order_kinds','methods','dropoff_points']])).rows;
 assert.equal(columns.length,3);
 const note=(await query('SELECT netsuite_note FROM purchase_orders WHERE netsuite_id=1030348')).rows[0];
 assert.equal(note.netsuite_note,'for SOB121819');
 console.log(JSON.stringify({health:true,publicAssets:true,preferencesProtected:true,preferenceColumns:true,notePreserved:true,publicReadRetries,poRef:'POB03976',poNote:note.netsuite_note}));
} finally {await closeDb();}
"""
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module',
                            input=script.replace('HASHES', json.dumps(data['sourceHashes'])).replace('HTML_ROUTES', json.dumps(HTML_ROUTES)).replace('HTML_ROUTE', json.dumps(HTML_ROUTE)).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
              'imageId': data['services']['app']['candidateImageId'], 'configurationPreserved': True,
              'webhookWorkerDatabaseOllamaUnchanged': True, 'noteSourcePreserved': True, 'migration': MIGRATION, **live}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    core.config_check(data)
    active = json.loads(database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '0':
        database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" +
                 (RELEASE / 'candidate/migrations' / MIGRATION).read_text() +
                 "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
        save('migration-result.json', {'applied': MIGRATION, 'transactional': True, 'additive': True})
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBackToNoteImage': True, 'additivePreferenceColumnsRetained': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'refresh-after-rollback': refresh_after_rollback, 'apply': apply, 'verify': verify}[sys.argv[1]]()

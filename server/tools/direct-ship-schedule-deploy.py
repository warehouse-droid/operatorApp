"""Scoped schedule release over the captured live image, with a rollback image."""
import datetime
import difflib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/direct-ship-schedule-20261002'
APP = 'mbbs-operator-app-app-1'
IMAGE = 'mbbs-operator-app:direct-ship-schedule-20261002'
MIGRATION = '255_scm_direct_ship_schedule_status.sql'
FILES = ['src/dispatch-repository.js', 'src/scm-reconciliation-repository.js',
         'src/scm-schedule-preference-repository.js', 'public/scm-schedule.js',
         'public/scm-schedule.html', 'migrations/' + MIGRATION]
UNTOUCHED = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
spec = importlib.util.spec_from_file_location('schedule_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, {'app': APP}
docker, metadata, digest = core.docker, core.metadata, core.digest
HASH = """const fs=require('fs'),crypto=require('crypto'),hashes={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(hashes));"""


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Running app changed; recapture before deploying'
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched'], 'A dependency changed'
    # The deployment uses the frozen, tested candidate. Later workspace edits
    # belong to concurrent work and remain in place for their own release.
    assert core.files_at(RELEASE / 'candidate') == data['sourceTree'], 'Candidate changed'


def stage():
    capture = json.loads((RELEASE / 'capture.json').read_text())
    before = metadata(APP)
    for captured, field in [('containerId', 'id'), ('imageId', 'imageId'), ('startedAt', 'startedAt')]:
        assert before[field] == capture['app'][captured], 'Running app changed since capture'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == core.files_at(RELEASE / 'before'), 'Captured source changed'
    candidate = RELEASE / 'candidate'
    shutil.copytree(RELEASE / 'before', candidate, dirs_exist_ok=True)
    patch = ''
    for file in FILES:
        old = RELEASE / 'before' / file
        base = RELEASE / 'workspace-before' / file
        if old.exists():
            assert old.read_bytes() == base.read_bytes(), 'Unexpected source baseline: ' + file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        dest = candidate / file
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(updated)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                           fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    baseline_tree, candidate_tree = core.files_at(RELEASE / 'before'), core.files_at(candidate)
    changed = sorted(file for file in candidate_tree if candidate_tree[file] != baseline_tree.get(file))
    assert changed == sorted(FILES), 'Unexpected runtime file changes'
    for file in ['package.json', 'package-lock.json']:
        assert (candidate / file).read_bytes() == (RELEASE / 'before' / file).read_bytes()
    (RELEASE / 'changes.patch').write_text(patch)
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
            'sourceHashes': {file: candidate_tree[file] for file in FILES},
            'sourceTree': candidate_tree, 'untouched': {name: metadata(name) for name in UNTOUCHED}}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'staged': True, 'changedFiles': changed}), flush=True)


def validated(data):
    log = (RELEASE / 'validated.log').read_text()
    assert re.search(r'^# fail 0$', log, re.M), 'Schedule regression suite must pass'
    for file in FILES:
        assert digest((RELEASE / 'validation-workspace' / file).read_bytes()) == data['sourceHashes'][file], 'Tested source differs: ' + file


def prepare():
    data = state()
    current(data)
    validated(data)
    overlay = RELEASE / 'stage' / 'overlay'
    for file in FILES:
        target = overlay / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / file, target)
    before = data['services']['app']['before']
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
    (RELEASE / 'stage/Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(RELEASE / 'stage')],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    data['services']['app']['candidateImageId'] = image_id
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == data['sourceTree']
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=.env.schedule-test-nonexistent',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for name, image in [('release', IMAGE), ('rollback', before['imageId'])]:
        (RELEASE / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE}), flush=True)


def database(sql):
    return docker('exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def live(name, verify=False):
    args = ['exec', '-i']
    if verify:
        args += ['-e', 'SCM_DIRECT_SHIP_VERIFY=1']
    result = json.loads(docker(*args, APP, 'node', '--input-type=module', input=(SERVER / 'tools/direct-ship-schedule-live.mjs').read_bytes()))
    save(name + '.json', result)
    print(json.dumps({key: value for key, value in result.items() if key != 'orders'}), flush=True)


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    after = metadata(APP)
    assert after['imageId'] == data['services']['app']['candidateImageId']
    assert after['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == data['sourceTree']
    assert database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1'
    live('live-after', verify=True)
    code = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(20000)});assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const script=await fetch(base+'/scm-schedule.js?v=20261002-direct-ship-schedule-v1',{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});assert.equal(script.status,200);assert.equal(crypto.createHash('sha256').update(await script.text()).digest('hex'),hashes['public/scm-schedule.js']);
 const page=await fetch(base+'/scm/POTOschedule',{signal:AbortSignal.timeout(20000)});assert.equal(page.status,200);assert.ok((await page.text()).includes('/scm-schedule.js?v=20261002-direct-ship-schedule-v1'));
 assert.equal((await fetch(base+'/api/scm/schedule',{signal:AbortSignal.timeout(20000)})).status,401);
}
console.log(JSON.stringify({health:true,publicAssets:true,scheduleRouteProtected:true}));"""
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    save('result.json', {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        'image': IMAGE, 'configurationPreserved': True, 'untouchedServicesPreserved': True, **checks})
    print(json.dumps({'deployed': True, **checks}), flush=True)


def apply():
    data = state()
    current(data)
    validated(data)
    core.config_check(data)
    active = json.loads(database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Active operations: ' + json.dumps(active)
    # This additive constraint upgrade leaves every existing selection intact.
    migration = (RELEASE / 'candidate/migrations' / MIGRATION).read_text()
    database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + migration +
             "\nINSERT INTO schema_migrations(filename) VALUES ('" + MIGRATION + "') ON CONFLICT DO NOTHING; COMMIT;")
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
        save('rollback-result.json', {'restoredParentImage': True, 'preferenceConstraintStillAllowsDirectShip': True})
        raise


if __name__ == '__main__':
    action = sys.argv[1]
    if action == 'live-before':
        live(action)
    else:
        {'stage': stage, 'prepare': prepare, 'apply': apply, 'verify': verify}[action]()

"""Deploy only the verified history, cargo and packing-slip changes over live."""
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
import time

SERVER = Path(__file__).resolve().parents[1]
ARTIFACT = SERVER / 'test-artifacts/dispatch-all-history-20261002'
FROZEN = ARTIFACT / 'packing-expanded-source'
RELEASE = SERVER / 'deployments/dispatch-history-cargo-20261002'
APP = 'mbbs-operator-app-app-1'
IMAGE = 'mbbs-operator-app:dispatch-history-cargo-20261002'
ROLLBACK = 'mbbs-operator-app:rollback-dispatch-history-cargo-20261002'
VERSION = '20261002-history-cargo-v1'
HISTORY = ['src/dispatch-history-mode.js', 'src/dispatch-load-assignment.js',
           'src/dispatch-planner-v2-repository.js', 'src/dispatch-pickup-visits.js',
           'src/dispatch-historical-order-snapshots.js', 'src/order-dependency-repository.js',
           'src/scm-dependency-preview-service.js']
CARGO = ['src/driver-repository.js', 'public/dispatch.js', 'src/dispatch-retained-link-manifests.js', 'src/co-direct-to-cargo.js']
UNTOUCHED = ['mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
spec = importlib.util.spec_from_file_location('history_cargo_release_core', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, {'app': APP}
docker, metadata, digest, files_at = core.docker, core.metadata, core.digest, core.files_at
HASH = """const fs=require('fs'),crypto=require('crypto'),hashes={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(hashes));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live app changed; rebase the release'
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched'], 'A dependency changed'
    assert files_at(RELEASE / 'candidate') == data['sourceTree'], 'Candidate source changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == data['beforeTree'], 'Live source changed'


def patch_text(file, old, new):
    return ''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
        fromfile='a/' + file if old else '/dev/null', tofile='b/' + file))


def prepare():
    os.umask(0o077)
    RELEASE.mkdir(parents=True, exist_ok=False)
    before = metadata(APP)
    untouched = {name: metadata(name) for name in UNTOUCHED}
    save('capture.json', {'before': before, 'untouched': untouched})
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for folder in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + folder, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    assert metadata(APP) == before, 'App changed during capture'
    before_tree = files_at(baseline)
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == before_tree
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = ''
    for file in HISTORY + CARGO:
        old_path = ARTIFACT / ('workspace-baseline' if file in HISTORY else 'final-source') / file
        old = old_path.read_text() if old_path.exists() else ''
        new = (FROZEN / file).read_text()
        patch += patch_text(file, old, new)
    packing_before = (ARTIFACT / 'packing-slip/scm-schedule-before.js').read_text()
    packing_after = (ARTIFACT / 'packing-slip/scm-schedule-after.js').read_text()
    patch += patch_text('public/scm-schedule.js', packing_before, packing_after)
    (RELEASE / 'requested.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Review the scoped patch conflicts before continuing'
    finish_stage(before, untouched, before_tree)


def finish_stage(before, untouched, before_tree):
    candidate = RELEASE / 'candidate'
    for path in candidate.rglob('*.orig'):
        path.unlink()
    assert not list(candidate.rglob('*.rej')), 'Unresolved patch conflicts'
    for file, asset in [('public/dispatch.html', 'dispatch.js'), ('public/scm-schedule.html', 'scm-schedule.js')]:
        text = (candidate / file).read_text()
        text, count = re.subn(r'/' + re.escape(asset) + r'\?v=[^"\s]+', '/' + asset + '?v=' + VERSION, text)
        assert count == 1, 'Unexpected asset reference: ' + file
        (candidate / file).write_text(text)
    source_tree = files_at(candidate)
    changed = sorted(file for file in source_tree if source_tree[file] != before_tree.get(file))
    expected = sorted(HISTORY + CARGO + ['public/scm-schedule.js', 'public/dispatch.html', 'public/scm-schedule.html'])
    assert changed == expected, 'Unexpected release scope: ' + json.dumps(changed)
    patch = ''
    for file in changed:
        old_path = RELEASE / 'before' / file
        patch += patch_text(file, old_path.read_text() if old_path.exists() else '', (candidate / file).read_text())
    (RELEASE / 'changes.patch').write_text(patch)
    for file in ['package.json', 'package-lock.json']:
        assert (candidate / file).read_bytes() == (RELEASE / 'before' / file).read_bytes()
    validation = RELEASE / 'validation-workspace'
    shutil.copytree(FROZEN, validation)
    for folder in ['src', 'public', 'migrations']:
        shutil.rmtree(validation / folder)
        shutil.copytree(candidate / folder, validation / folder)
    for file in ['package.json', 'package-lock.json']:
        shutil.copy2(candidate / file, validation / file)
    shutil.copy2(SERVER / 'tools/scm-packing-slip-view-check.mjs', validation / 'tools/scm-packing-slip-view-check.mjs')
    data = {'services': {'app': {'before': before, 'image': IMAGE}}, 'untouched': untouched,
            'beforeTree': before_tree, 'sourceTree': source_tree, 'changedFiles': changed,
            'sourceHashes': {file: source_tree[file] for file in changed},
            'testedHistorySourceHashes': {file: digest((FROZEN / file).read_bytes()) for file in HISTORY + CARGO}}
    save('manifest.json', data)
    current(data)
    print(json.dumps({'prepared': True, 'parentImage': before['image'], 'changedFiles': changed}), flush=True)


def validated(data):
    for log in ['focused.log', 'packing-regression.log']:
        text = (RELEASE / log).read_text()
        assert re.search(r'^[#ℹ] fail 0$', text, re.M) and not re.search(r'^[#ℹ] fail [1-9]',text,re.M), 'Candidate regression required: ' + log
    assert files_at(RELEASE / 'validation-workspace') == data['sourceTree'], 'Tested source differs'
    packing = json.loads((ARTIFACT / 'packing-slip/release-views-after.json').read_text())
    assert packing['passed'] and len(packing['views']) == 8, 'Packing-slip view matrix must pass'


def build():
    data = state()
    current(data)
    validated(data)
    docker('tag', data['services']['app']['before']['imageId'], ROLLBACK)
    assert docker('image', 'inspect', '--format', '{{.Id}}', ROLLBACK).decode().strip() == data['services']['app']['before']['imageId']
    overlay = RELEASE / 'stage/overlay'
    for file in data['changedFiles']:
        target = overlay / file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RELEASE / 'candidate' / file, target)
    (RELEASE / 'stage/Dockerfile').write_text('FROM ' + ROLLBACK + '\nCOPY --chown=node:node overlay/ /app/\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE,
                        str(RELEASE / 'stage')], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    image_id = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    data['services']['app']['candidateImageId'] = image_id
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == data['sourceTree']
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=.env.history-disabled',
           '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
           '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for name, image in [('release', IMAGE), ('rollback', data['services']['app']['before']['imageId'])]:
        (RELEASE / ('compose.' + name + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'built': IMAGE, 'imageId': image_id, 'rollbackImage': ROLLBACK}), flush=True)


def database(sql):
    return docker('exec', '-i', 'mbbs-operator-app-db-1', 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard',
                  '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    after = metadata(APP)
    assert after['imageId'] == data['services']['app']['candidateImageId']
    assert after['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == data['sourceTree']
    code = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const options={signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}};
 const health=await fetch(base+'/health',options);assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const file of Object.keys(hashes).filter(file=>file.startsWith('public/'))){
  const response=await fetch(base+'/'+file.slice(7)+'?v=VERSION',options);assert.equal(response.status,200);
  assert.equal(crypto.createHash('sha256').update(await response.text()).digest('hex'),hashes[file],file);
 }
 const page=await fetch(base+'/scm/POTOschedule',options);assert.equal(page.status,200);
 assert.ok((await page.text()).includes('/scm-schedule.js?v=VERSION'));
 for(const path of ['/api/scm/schedule','/api/dispatch/plan'])assert.equal((await fetch(base+path,options)).status,401,path);
}
console.log(JSON.stringify({localHealth:true,publicHealth:true,publicAssets:true,protectedEndpoints:true}));"""
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module',
                              input=code.replace('HASHES', json.dumps(data['sourceHashes'])).replace('VERSION', VERSION).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'image': IMAGE, 'imageId': after['imageId'], 'runtimeFilesVerified': len(data['sourceTree']),
              'changedFiles': data['changedFiles'], 'configurationPreserved': True,
              'untouchedServicesPreserved': True, 'noBusinessDataRepair': True, 'noMigration': True, **checks}
    save('deployment-result.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = state()
    current(data)
    validated(data)
    core.config_check(data)
    assert docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip() == data['services']['app']['candidateImageId']
    sql = """SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""
    for attempt in range(12):
        active = json.loads(database(sql))
        if not any(active.values()):
            break
        print(json.dumps({'waitingForActiveOperations': active}), flush=True)
        time.sleep(5)
    else:
        raise RuntimeError('Active operations remain; retry the cutover after they finish')
    save('active-before-release.json', active)
    current(data)
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
        save('rollback-result.json', {'restoredParentImage': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'build': build, 'apply': apply, 'verify': verify}[sys.argv[1]]()

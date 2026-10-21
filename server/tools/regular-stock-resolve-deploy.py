"""Scoped regular Stocking Resolve release over the captured production app."""
import datetime
import difflib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

SERVER = Path(__file__).resolve().parents[1]
RELEASE = SERVER / 'deployments/regular-stock-resolve-20261002'
OUT = SERVER / 'test-artifacts/regular-stock-resolve-20261002'
FILES = json.loads((SERVER / 'tools/regular-stock-resolve-files.json').read_text())
IMAGE = 'mbbs-operator-app:regular-stock-resolve-20261002'
spec = importlib.util.spec_from_file_location('resolve_release_parent', SERVER / 'tools/scm-schedule-multi-sort-deploy.py')
parent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parent)
parent.RELEASE, parent.OUT, parent.FILES, parent.IMAGE = RELEASE, OUT, FILES, IMAGE
parent.core.RELEASE = RELEASE
APP, docker, metadata, digest = parent.APP, parent.docker, parent.metadata, parent.digest


def stage():
    captured = json.loads((RELEASE / 'capture.json').read_text())
    assert metadata(APP) == captured['before'], 'Running app changed; recapture before publishing'
    candidate = RELEASE / 'candidate'
    shutil.copytree(RELEASE / 'before', candidate, dirs_exist_ok=True)
    patch = ''
    for file in FILES:
        old, base, updated = RELEASE / 'before' / file, OUT / 'before' / file, SERVER / file
        original = old.read_text() if old.exists() else ''
        if old.exists() and base.exists() and old.read_bytes() != base.read_bytes():
            merged = subprocess.run(['git', 'merge-file', '-p', str(updated), str(base), str(old)], text=True, capture_output=True)
            assert merged.returncode == 0, 'Resolve concurrent source changes: ' + file
            content = merged.stdout
        else:
            assert old.exists() == base.exists(), 'Unexpected live source: ' + file
            content = updated.read_text()
        target = candidate / file
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        patch += ''.join(difflib.unified_diff(original.splitlines(True), content.splitlines(True), fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    old_tree, new_tree = parent.core.files_at(RELEASE / 'before'), parent.core.files_at(candidate)
    changed = sorted(file for file in new_tree if old_tree.get(file) != new_tree[file])
    assert set(changed) <= set(FILES)
    (RELEASE / 'changes.patch').write_text(patch)
    parent.save('manifest.json', {'services': {'app': {'before': captured['before'], 'image': IMAGE}},
        'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
        'sourceHashes': {file: new_tree[file] for file in FILES}, 'untouched': captured['untouched']})
    parent.save('source-tree.json', new_tree)
    parent.current(parent.state())
    print(json.dumps({'staged': True, 'changedFiles': changed}), flush=True)


def validate_candidate():
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and not checks['newFailures']
    assert checks['sourceHashes'] == parent.state()['sourceHashes']


def prepare():
    data = parent.state()
    parent.current(data)
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
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', parent.HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
        '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for kind, image in [('release', IMAGE), ('rollback', before['imageId'])]:
        (RELEASE / ('compose.' + kind + '.yml')).write_text('services:\n  app:\n    image: ' + image + '\n')
    parent.core.config_check(data)
    parent.current(data)
    parent.save('manifest.json', data)
    print(json.dumps({'prepared': True, 'image': IMAGE, 'imageId': data['services']['app']['candidateImageId']}), flush=True)


def verify():
    data = parent.state()
    parent.core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in parent.UNTOUCHED} == data['untouched']
    assert json.loads(docker('exec', APP, 'node', '-e', parent.HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    code = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES,routes={'public/sales-stock-requests.html':'/sales/stock-requests','public/scm-stock-requests.html':'/scm/stock-requests'};let publicReadRetries=0;
async function read(url,options={}){for(let attempt=1;attempt<=3;attempt++){try{return await fetch(url,{...options,signal:AbortSignal.timeout(30000)});}catch(error){if(attempt===3||!url.startsWith('https://test.mbbsoperation.com/')||error.cause?.code!=='UND_ERR_CONNECT_TIMEOUT')throw error;publicReadRetries++;await new Promise(resolve=>setTimeout(resolve,attempt*1000));}}}
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await read(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;const response=await read(base+(routes[file]||'/'+file.slice(7)),{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,file);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,file);}
 const denied=await read(base+'/api/scm/stock-requests/0/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);
}
console.log(JSON.stringify({health:true,publicAssets:true,resolveRouteProtected:true,publicReadRetries}));"""
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=code.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    parent.save('result.json', {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
        'imageId': actual['imageId'], 'configurationPreserved': True, 'untouchedServicesPreserved': True, 'migrations': [], **live})
    print(json.dumps({'deployed': True, **live}), flush=True)


def apply():
    data = parent.state()
    parent.current(data)
    validate_candidate()
    parent.core.config_check(data)
    active = json.loads(parent.database("""SELECT json_build_object(
      'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
      'quantityApplying',(SELECT count(*) FROM sales_special_stock_cases WHERE quantity_review->>'status'='applying'),
      'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
      'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    parent.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(parent.core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(parent.core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        parent.core.core.ready(data['services']['app']['before']['imageId'])
        parent.save('rollback-result.json', {'restoredPreviousApp': True})
        raise


if __name__ == '__main__':
    {'stage': stage, 'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()

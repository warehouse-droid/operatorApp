"""Publish the scoped PO Remark/Note mapping and mini-bar layout changes."""
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
OUT = SERVER / 'test-artifacts/scm-po-text-refs-20260930'
RELEASE = SERVER / 'deployments/scm-po-text-refs-20260930'
APP = 'mbbs-operator-app-app-1'
DEPS = ['mbbs-operator-app-db-1', 'mbbs-operator-app-webhook-worker-1', 'mbbs-operator-app-ollama-1']
IMAGE = 'mbbs-operator-app:scm-po-text-refs-20260930'
FILES = json.loads((SERVER / 'tools/scm-po-text-refs-files.json').read_text())
spec = importlib.util.spec_from_file_location('scoped_release', SERVER / 'tools/regular-stock-v2-deploy.py')
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
    assert metadata(APP) == data['services']['app']['before'], 'Running app changed; recapture before release'
    assert {name: metadata(name) for name in DEPS} == data['dependencies'], 'A dependency changed'
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['workspaceHashes'], 'Tested workspace changed'
    assert {file: digest((RELEASE / 'candidate' / file).read_bytes()) for file in FILES} == data['sourceHashes']


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    before = metadata(APP)
    data = {'services': {'app': {'before': before, 'image': IMAGE}},
            'dependencies': {name: metadata(name) for name in DEPS},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES}}
    baseline = RELEASE / 'before'
    baseline.mkdir()
    for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
        with tarfile.open(fileobj=io.BytesIO(docker('cp', APP + ':/app/' + name, '-'))) as archive:
            archive.extractall(baseline, filter='data')
    candidate = RELEASE / 'candidate'
    shutil.copytree(baseline, candidate)
    patch = []
    for file in FILES:
        old = OUT / 'before' / file
        original = old.read_text() if old.exists() else ''
        updated = (SERVER / file).read_text()
        if file.endswith('.html'):
            import re
            original = (baseline / file).read_text()
            updated = original
            assets = ['dispatch.css', 'dispatch-scm.js'] if file == 'public/dispatch-scm.html' else [
                'scm-special-stock-requests.js']
            for asset in assets:
                updated, count = re.subn('/' + re.escape(asset) + r'\?v=[^"\s]+',
                                        '/' + asset + '?v=20260930-po-text-v2', updated)
                assert count == 1, asset
        patch.extend(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                        fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
    patch = ''.join(patch)
    (RELEASE / 'release.patch').write_text(patch)
    result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                            input=patch, text=True, capture_output=True)
    (RELEASE / 'patch.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, 'Review the scoped patch before release'
    for file in candidate.rglob('*.orig'):
        file.unlink()
    old, new = core.files_at(baseline), core.files_at(candidate)
    changed = sorted(file for file in new if old.get(file) != new[file])
    assert changed == sorted(FILES), changed
    data['sourceHashes'] = {file: new[file] for file in FILES}
    save('source-tree.json', new)
    save('manifest.json', data)
    current(data)
    print(json.dumps({'captured': True, 'changedFiles': changed}), flush=True)


def candidate_tests(data):
    spec = importlib.util.spec_from_file_location('feature_runner', SERVER / 'tools/scm-po-text-refs-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.REMOTE = '/tmp/scm-po-text-release'
    root = RELEASE / 'candidate'
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', root)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    suites = ['test/mbt/unit/scm-schedule-remarks.red.test.js', 'test/mbt/property/scm-schedule-remarks.property.test.js',
              'test/mbt/unit/special-po-routing.test.js', 'test/mbt/unit/special-po-pallet.test.js',
              'test/mbt/integration/scm-po-text.test.js', 'test/mbt/integration/special-po-routing-browser.test.js',
              'test/mbt/integration/special-po-pallet.test.js', 'test/mbt/integration/scm-schedule-status-concurrency.test.js']
    status = runner.run('candidate-tests', ['node', '--test', '--test-concurrency=1', *suites])
    import re
    log = (OUT / 'candidate-tests.log').read_text()
    failures = re.findall(r'^not ok \d+ - (.+)$', log, re.M)
    assert status == 0 and not failures, log[-5000:]
    assert 'ERR_MODULE_NOT_FOUND' not in log and 'hookFailed' not in log
    result = {key: int(re.search(r'^# ' + key + r' (\d+)$', log, re.M).group(1)) for key in ['tests', 'pass', 'fail']}
    assert result['tests'] == 34 and result['pass'] == 34
    result.update(newFailures=[], failures=failures)
    save('candidate-checks.json', result)
    print(json.dumps(result), flush=True)


def prepare():
    data = state()
    checks = json.loads((OUT / 'checks.json').read_text())
    assert checks['completed'] and checks['fail'] == 0 and checks['pass'] == 34
    assert checks['sourceHashes'] == data['workspaceHashes']
    current(data)
    check_live_script()
    candidate_tests(data)
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
    assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', IMAGE, '-e', HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
           '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', IMAGE, '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'sourceFiles': len(FILES)}), flush=True)


def database(sql):
    return docker('exec', '-i', DEPS[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def check_live_script():
    import ast
    module = ast.parse(Path(__file__).read_text())
    function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'verify')
    assignment = next(node for node in function.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == 'script' for target in node.targets))
    script = ast.literal_eval(assignment.value).replace('HASHES', '{}')
    docker('exec', '-i', 'mbbs-special-review-runner', 'node', '--input-type=module', '--check', input=script.encode())
    print(json.dumps({'liveCheckSyntax': True}), flush=True)


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    actual = metadata(APP)
    assert actual['imageId'] == data['services']['app']['candidateImageId']
    assert actual['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in DEPS} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', HASH)) == json.loads((RELEASE / 'source-tree.json').read_text())
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES;for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const path=({'public/scm-stock-requests.html':'/scm/stock-requests','public/dispatch-scm.html':'/scm/POsplit'})[file] || '/'+file.slice(7);
 const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);}}
const {getScmPurchaseOrderCatalogOrder}=await import('./src/scm-purchase-order-catalog-repository.js');
const {getSpecialStockCase}=await import('./src/special-stock-request-repository.js');
const {specialPoRoutingHtml}=await import('./public/special-stock-po-routing.js');
const {query,closeDb}=await import('./src/db.js');
try {
 const detail=await getSpecialStockCase(83,{audience:'scm'});assert.equal(detail.requestRef,'SPREQ-000017');assert.equal(detail.attention,false);
 const order=await getScmPurchaseOrderCatalogOrder(detail.purchaseOrderRef);assert(order);
 const source=(await query('SELECT memo,dispatch_instructions FROM purchase_orders WHERE tranid=$1',[detail.purchaseOrderRef])).rows[0];assert(source);
 assert.equal(order.scm.netSuiteMemo,String(source.memo || '').trim());
 assert.equal(order.scm.remark,order.scm.remarkOverride || order.scm.netSuiteMemo);
 assert.equal(order.notes,String(source.dispatch_instructions || '').trim());
 const html=specialPoRoutingHtml(detail,{ref:detail.purchaseOrderRef,order});
 assert.match(html,/data-scm-field="notes"/);assert.match(html,/data-scm-field="remarkOverride"/);
 console.log(JSON.stringify({health:true,publicAssets:true,readOnly:true,poRemarkMapped:true,poNoteMapped:true,requestRef:detail.requestRef,poRef:detail.purchaseOrderRef}));
} finally {await closeDb();}"""
    live = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.replace('HASHES', json.dumps(data['sourceHashes'])).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
              'configurationPreserved': True, 'workerAndDependenciesUnchanged': True, 'changedFiles': FILES, **live}
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
      'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
      'webhookRunning',(SELECT count(*) FROM netsuite_order_webhook_inbox WHERE status='running'))"""))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active work: ' + json.dumps(active)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True, 'databaseUnchanged': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'apply': apply, 'verify': verify, 'syntax': check_live_script}[sys.argv[1]]()

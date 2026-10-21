"""Scoped PO Note release over each service's own deployed sources."""
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

SERVER = Path(__file__).resolve().parents[1]
OUT = SERVER / 'test-artifacts/special-po-so-note-20261001'
RELEASE = SERVER / 'deployments/special-po-so-note-20261001'
CONTAINERS = {'app': 'mbbs-operator-app-app-1', 'webhook-worker': 'mbbs-operator-app-webhook-worker-1'}
DEPS = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1']
FILES = json.loads((SERVER / 'tools/special-po-so-note-files.json').read_text())
WORKER_FILES = ['src/netsuite.js', 'src/order-sync-repository.js', 'src/netsuite-mirror-repository.js',
                'src/scm-netsuite-po-history-service.js', 'src/special-stock-purchase-order-note-adapter.js',
                'migrations/247_purchase_order_note.sql']
MIGRATION = '247_purchase_order_note.sql'
spec = importlib.util.spec_from_file_location('scoped_release', SERVER / 'tools/regular-stock-v2-deploy.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
core.RELEASE, core.CONTAINERS = RELEASE, CONTAINERS
docker, digest, metadata = core.docker, core.digest, core.metadata
HASH = """const fs=require('fs'),crypto=require('crypto'),hashes={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(e.isFile())hashes[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}}for(const d of ['src','public','migrations'])walk(d);console.log(JSON.stringify(hashes));"""


def save(name, value):
    (RELEASE / name).write_text(json.dumps(value, indent=2) + '\n')


def state():
    return json.loads((RELEASE / 'manifest.json').read_text())


def feature_source(file):
    snapshot = OUT / 'feature-source' / file
    return snapshot if snapshot.exists() else SERVER / file


def current(data):
    assert {file: digest((SERVER / file).read_bytes()) for file in FILES} == data['workspaceHashes']
    assert {file: digest(feature_source(file).read_bytes()) for file in FILES} == data['featureHashes']
    assert {name: metadata(name) for name in DEPS} == data['dependencies']
    for service, container in CONTAINERS.items():
        row = data['services'][service]
        assert metadata(container) == row['before'], 'Running service changed: ' + service
        assert {file: digest((RELEASE / ('candidate-' + service) / file).read_bytes()) for file in row['files']} == row['sourceHashes']


def capture():
    os.umask(0o077)
    RELEASE.mkdir(exist_ok=False)
    data = {'services': {}, 'dependencies': {name: metadata(name) for name in DEPS},
            'workspaceHashes': {file: digest((SERVER / file).read_bytes()) for file in FILES},
            'featureHashes': {file: digest(feature_source(file).read_bytes()) for file in FILES}}
    for service, container in CONTAINERS.items():
        before = metadata(container)
        baseline = RELEASE / ('before-' + service)
        baseline.mkdir()
        for name in ['src', 'public', 'migrations', 'package.json', 'package-lock.json']:
            with tarfile.open(fileobj=io.BytesIO(docker('cp', container + ':/app/' + name, '-'))) as archive:
                archive.extractall(baseline, filter='data')
        candidate = RELEASE / ('candidate-' + service)
        shutil.copytree(baseline, candidate)
        selected = FILES if service == 'app' else WORKER_FILES
        patch = []
        for file in selected:
            old = OUT / 'before' / file
            original = old.read_text() if old.exists() else ''
            updated = feature_source(file).read_text()
            if file == 'public/scm-stock-requests.html':
                original = (baseline / file).read_text()
                updated, count = re.subn(r'/scm-special-stock-requests\.js\?v=[^"\s]+',
                                         '/scm-special-stock-requests.js?v=20261001-po-note-v1', original)
                assert count == 1
            patch.extend(difflib.unified_diff(original.splitlines(True), updated.splitlines(True),
                                            fromfile='a/' + file if old.exists() else '/dev/null', tofile='b/' + file))
        patch = ''.join(patch)
        (RELEASE / (service + '.patch')).write_text(patch)
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-d', str(candidate)],
                                input=patch, text=True, capture_output=True)
        (RELEASE / (service + '-patch.log')).write_text(result.stdout + result.stderr)
        assert result.returncode == 0, 'Inspect scoped patch: ' + service
        for path in candidate.rglob('*.orig'):
            path.unlink()
        old_tree, new_tree = core.files_at(baseline), core.files_at(candidate)
        changed = sorted(file for file in new_tree if old_tree.get(file) != new_tree[file])
        assert changed == sorted(selected), changed
        data['services'][service] = {'before': before, 'files': selected,
            'image': 'mbbs-operator-app:special-po-so-note-' + service + '-20261001',
            'sourceHashes': {file: new_tree[file] for file in selected}}
        save(service + '-source-tree.json', new_tree)
        print(json.dumps({'captured': service, 'changedFiles': changed}), flush=True)
    save('manifest.json', data)
    current(data)


def candidate_tests(service):
    spec = importlib.util.spec_from_file_location('feature_runner', SERVER / 'tools/special-po-so-note-run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    runner.REMOTE = '/tmp/special-po-so-note-release-' + service
    root = RELEASE / ('candidate-' + service)
    for folder in ['test', 'tools']:
        shutil.copytree(SERVER / folder, root / folder, dirs_exist_ok=True)
    shutil.copy2(SERVER / 'netsuite-smart-scm-picking-ticket-restlet.js', root)
    docker('exec', runner.RUNNER, 'node', '-e', "const fs=require('fs'),p=process.argv[1];fs.rmSync(p,{recursive:true,force:true});fs.mkdirSync(p)", runner.REMOTE)
    docker('cp', str(root) + '/.', runner.RUNNER + ':' + runner.REMOTE)
    docker('exec', runner.RUNNER, 'node', '-e', "require('fs').symlinkSync('/app/node_modules',process.argv[1]+'/node_modules','dir')", runner.REMOTE)
    if service == 'app':
        command = ['node', '--input-type=module', '-e', "import {existing,own} from './tools/special-po-so-note-suites.mjs';import {spawnSync} from 'node:child_process';const r=spawnSync(process.execPath,['--test','--test-concurrency=1',...existing,...own],{stdio:'inherit'});process.exit(r.status);"]
        status = runner.run('candidate-app', command)
        log = (OUT / 'candidate-app.log').read_text()
        failures = re.findall(r'^not ok \d+ - (.+)$', log, re.M)
        expected = json.loads((OUT / 'checks.json').read_text())
        assert sorted(failures) == sorted(expected['finalFailures']), failures
        counts = {key: int(re.search(r'^# ' + key + r' (\d+)$', log, re.M).group(1)) for key in ['tests', 'pass', 'fail']}
        assert counts == {key: expected[key] for key in counts}, counts
        assert status in [0, 1]
        save('candidate-app-checks.json', {**counts, 'newFailures': [], 'baselineFailures': failures})
    else:
        assert runner.run('candidate-worker', ['node', 'tools/special-po-so-note-worker-check.mjs']) == 0
        assert runner.run('candidate-worker-read', ['node', 'tools/special-po-so-note-worker-read.mjs']) == 0
        save('candidate-worker-checks.json', {'noteSync': True, 'mirrorNote': True, 'partialNotePreserved': True, 'noteReads': True})


def prepare():
    data = state()
    checks = json.loads((OUT / 'checks.json').read_text())
    coverage = json.loads((OUT / 'changed-lines.json').read_text())
    assert checks['completed'] and not checks['newFailures'] and not coverage['uncovered']
    assert checks['sourceHashes'] == data['featureHashes']
    current(data)
    for service, row in data['services'].items():
        candidate_tests(service)
        stage = RELEASE / ('stage-' + service)
        for file in row['files']:
            target = stage / 'overlay' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(RELEASE / ('candidate-' + service) / file, target)
        before = row['before']
        assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId']
        (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node overlay/ /app/\n')
        with (RELEASE / (service + '-build.log')).open('wb') as log:
            subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', row['image'], str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
        row['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', row['image']).decode().strip()
        assert json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', row['image'], '-e', HASH)) == json.loads((RELEASE / (service + '-source-tree.json')).read_text())
        docker('run', '--rm', '--network', 'none', '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false',
               '-e', 'NETSUITE_MIRROR_ROLE=disabled', '--entrypoint', 'node', row['image'], '--input-type=module', '-e', "await import('./src/server.js');process.exit(0)")
    for kind in ['release', 'rollback']:
        content = 'services:\n'
        for service, row in data['services'].items():
            content += '  ' + service + ':\n    image: ' + (row['image'] if kind == 'release' else row['before']['imageId']) + '\n'
        (RELEASE / ('compose.' + kind + '.yml')).write_text(content)
    core.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'services': list(CONTAINERS)}), flush=True)


def database(sql):
    return docker('exec', '-i', DEPS[0], 'psql', '-U', 'mbbs_app', '-d', 'mbbs_yard', '-XAt', '-v', 'ON_ERROR_STOP=1', input=sql.encode()).decode().strip()


def migrate():
    if database("SELECT count(*) FROM schema_migrations WHERE filename='" + MIGRATION + "'") == '1':
        return
    sql = (RELEASE / 'candidate-app/migrations' / MIGRATION).read_text()
    database("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';\n" + sql +
             "\nINSERT INTO schema_migrations(filename) VALUES('" + MIGRATION + "'); COMMIT;")
    save('migration-result.json', {'applied': MIGRATION, 'additive': True, 'transactional': True})


def verify():
    data = state()
    core.core.ready(data['services']['app']['candidateImageId'])
    assert {name: metadata(name) for name in DEPS} == data['dependencies']
    for service, container in CONTAINERS.items():
        row = data['services'][service]
        actual = metadata(container)
        assert actual['imageId'] == row['candidateImageId']
        assert actual['configuration'] == row['before']['configuration']
        assert json.loads(docker('exec', container, 'node', '-e', HASH)) == json.loads((RELEASE / (service + '-source-tree.json')).read_text())
    script = r"""import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes=HASHES;for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const path=file.endsWith('.html')?'/scm/stock-requests':'/'+file.slice(7);
 const response=await fetch(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);}}
const {getSpecialStockCase}=await import('./src/special-stock-request-repository.js');
const {readSpecialPurchaseOrderNote}=await import('./src/special-stock-purchase-order-routing.js');
const {getScmPurchaseOrderCatalogOrder}=await import('./src/scm-purchase-order-catalog-repository.js');
const {buildSpecialPurchaseOrderPayload}=await import('./src/special-stock-request-netsuite.js');
const {specialPoRoutingHtml}=await import('./public/special-stock-po-routing.js');
const {fetchPurchaseOrderReferenceFromNetSuite}=await import('./src/netsuite.js');
const {closeDb}=await import('./src/db.js');
try {
 const detail=await getSpecialStockCase(83,{audience:'scm'});assert.equal(detail.requestRef,'SPREQ-000017');assert.equal(detail.attention,false);
 const {note}=await readSpecialPurchaseOrderNote(83);
 const header=await fetchPurchaseOrderReferenceFromNetSuite(detail.purchaseOrderId);
 assert.equal(header.netsuite_note,note);
 const order=await getScmPurchaseOrderCatalogOrder(detail.purchaseOrderReference || detail.purchaseOrderRef);assert(order);
 assert.equal(order.netSuiteNote,note);
 const html=specialPoRoutingHtml(detail,{ref:detail.purchaseOrderRef,order});assert.match(html,/Saved to the NetSuite PO/);
 const payload=buildSpecialPurchaseOrderPayload({caseId:detail.id,vendorId:detail.vendorId,netsuiteLocationId:1,
   salesOrderRef:detail.salesOrderRef,lines:detail.purchaseOrderLines,vendorDiscountReview:detail.vendorDiscountReview});
 assert.equal(payload.custbody7,'for '+detail.salesOrderRef);
 const pallet=payload.item.items.find(line=>line.item.id==='1784');assert.equal(pallet.quantity,1);assert.equal(pallet.rate,35);
 console.log(JSON.stringify({health:true,publicAssets:true,netSuiteReadOnly:true,suiteqlPoNoteVerified:true,localNoteCacheRefreshed:true,
   requestRef:detail.requestRef,poRef:detail.purchaseOrderRef,poNote:note,newPoNote:payload.custbody7,palletPreserved:true,payloadSubmitted:false}));
} finally {await closeDb();}"""
    live = json.loads(docker('exec', '-i', CONTAINERS['app'], 'node', '--input-type=module',
                            input=script.replace('HASHES', json.dumps(data['services']['app']['sourceHashes'])).encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'configurationPreserved': True, 'databaseAndOllamaUnchanged': True, 'migration': MIGRATION,
              'images': {service: row['image'] for service, row in data['services'].items()}, **live}
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
    migrate()
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(core.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(core.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', *CONTAINERS],
                           cwd=SERVER.parent, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        core.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True, 'additiveNoteColumnRetained': True})
        raise


if __name__ == '__main__':
    {'capture': capture, 'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()

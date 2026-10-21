"""Release the verified delivery enhancement as a scoped live-image overlay."""
import datetime
import difflib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
OUT = SERVER / 'test-artifacts/delivery-enhancements-20261013'
RELEASE = SERVER / 'deployments/delivery-request-enhancements-20261013'
APP = 'mbbs-operator-app-app-1'
DEPENDENCIES = ['mbbs-operator-app-db-1', 'mbbs-operator-app-ollama-1', 'mbbs-operator-app-webhook-worker-1']
IMAGE = 'mbbs-operator-app:delivery-request-enhancements-20261013'
FILES = ['src/delivery-request-domain.js', 'src/delivery-request-documents.js', 'src/delivery-request-repository.js',
         'src/delivery-request-router.js', 'src/netsuite.js', 'public/delivery-requests.js',
         'public/delivery-requests.css', 'public/delivery-request-alert.js', 'public/delivery-requests.html']
spec = importlib.util.spec_from_file_location('delivery_release', SERVER / 'tools/regular-stock-v2-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
release.RELEASE, release.CONTAINERS, release.DEPENDENCIES = RELEASE, {'app': APP}, DEPENDENCIES
docker, digest, metadata = release.docker, release.digest, release.metadata
HASH_SCRIPT = """const fs=require('node:fs'),crypto=require('node:crypto'),hashes={};
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+entry.name;
if(entry.isDirectory())walk(path);else if(entry.isFile())hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');}}
for(const dir of ['src','public','migrations'])walk(dir);console.log(JSON.stringify(hashes));"""


def save(name, data):
    (RELEASE / name).write_text(json.dumps(data, indent=2) + '\n')


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live release changed; rebase before publishing'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'A dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == data['beforeTree'], 'Live source changed'
    for name in FILES:
        assert digest((SERVER / name).read_bytes()) == data['sourceHashes'][name], 'Validated source changed: ' + name


def import_check(image):
    name = 'mbbs-delivery-enhancements-import-check'
    try:
        args = ['run', '--rm', '--name', name, '--network', 'none', '--init', '--read-only',
                '--label', 'com.mbbs.lifecycle=disposable-test', '--cgroup-parent=mbbs-tests.slice',
                '--memory=2g', '--memory-swap=2g', '--pids-limit=512', '--cpus=2',
                '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777,size=512m',
                '--tmpfs', '/app/data:uid=1000,gid=1000,mode=0700,size=128m',
                '-e', 'MBBS_ENV_FILE=/nonexistent', '-e', 'NODE_ENV=test', '-e', 'MBT_TEST_ISOLATED=1',
                '-e', 'DATABASE_URL=', '-e', 'NETSUITE_DIRECT_ACCESS_ENABLED=false', '-e', 'NETSUITE_MIRROR_ROLE=disabled',
                '--entrypoint', 'node', image, '--input-type=module', '-e',
                "await import('./src/server.js'); console.log('production dependency import passed'); process.exit(0)"]
        (RELEASE / 'production-image-imports.log').write_bytes(docker(*args))
        save('candidate-tree.json', json.loads(docker('run', '--rm', '--name', name, '--network', 'none', '--init', '--read-only',
             '--label', 'com.mbbs.lifecycle=disposable-test', '--cgroup-parent=mbbs-tests.slice', '--memory=512m', '--memory-swap=512m',
             '--pids-limit=128', '--cpus=1', '--tmpfs', '/tmp:size=64m', '--entrypoint', 'node', image, '-e', HASH_SCRIPT)))
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (RELEASE / 'docker-ps.log').write_bytes(docker('ps', '--format', '{{.Names}} {{.Status}}'))
        (RELEASE / 'docker-ps-a.log').write_bytes(docker('ps', '-a', '--format', '{{.Names}} {{.Status}}'))
        assert not docker('ps', '-a', '--filter', f'name=^/{name}$', '--format', '{{.ID}}').strip(), 'Test container remains'
        docker('exec', APP, 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))")


def prepare():
    os.umask(0o077)
    evidence = json.loads((OUT / 'final/results/evidence.json').read_text())
    assert all(layer['exitCode'] == 0 for layer in evidence['layers']), 'Final verification failed'
    assert evidence['coverage']['covered'] == evidence['coverage']['total'], 'Uncovered changed lines'
    assert evidence['mutations']['restored'] and all(row['killed'] for row in evidence['mutations']['mutants']), 'Mutation verification failed'
    assert (OUT / 'final/teardown.log').read_text().endswith('teardown_exit=0\n'), 'Disposable teardown failed'
    before = metadata(APP)
    captured = json.loads((OUT / 'live-before/identity.json').read_text())
    assert before['imageId'] == captured['imageId'] and before['id'] == captured['containerId'], 'Captured release changed'
    source = {name: digest((SERVER / name).read_bytes()) for name in FILES}
    for name, value in evidence['sourceHashes'].items():
        assert source[name] == value, 'Source changed since final tests: ' + name
    tree = json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT))
    for name in FILES:
        original = OUT / 'live-before' / name
        if original.exists():
            assert tree[name] == digest(original.read_bytes()), 'Captured source drift: ' + name
        else:
            assert name not in tree, 'Unexpected existing runtime file: ' + name
    RELEASE.mkdir(exist_ok=False)
    data = {'services': {'app': {'before': before, 'image': IMAGE}}, 'dependencies': {name: metadata(name) for name in DEPENDENCIES},
            'beforeTree': tree, 'sourceHashes': source}
    current(data)
    stage = RELEASE / 'stage'
    patch = ''
    for name in FILES:
        destination = stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SERVER / name, destination)
        original = OUT / 'live-before' / name
        old = original.read_text().splitlines(True) if original.exists() else []
        patch += ''.join(difflib.unified_diff(old, destination.read_text().splitlines(True), fromfile='a/' + name, tofile='b/' + name))
    (RELEASE / 'runtime.patch').write_text(patch)
    assert docker('image', 'inspect', '--format', '{{.Id}}', before['image']).decode().strip() == before['imageId'], 'Base tag changed'
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\n' + ''.join('COPY --chown=node:node ' + name + ' /app/' + name + '\n' for name in FILES))
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).decode().strip()
    import_check(IMAGE)
    expected = {**tree, **source}
    assert json.loads((RELEASE / 'candidate-tree.json').read_text()) == expected, 'Unrelated image files changed'
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    release.config_check(data)
    current(data)
    save('manifest.json', data)
    print(json.dumps({'prepared': True, 'runtimeFilesChanged': len(FILES), 'unrelatedSourcePreserved': True}), flush=True)


def rebase():
    captured_path = OUT / 'live-before/identity.json'
    captured = json.loads(captured_path.read_text())
    before = metadata(APP)
    tree = json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT))
    for name in FILES:
        original = OUT / 'live-before' / name
        if original.exists():
            assert tree[name] == digest(original.read_bytes()), 'Overlapping runtime change requires a merge: ' + name
        else:
            assert name not in tree, 'Added file overlaps the new release: ' + name
    assert metadata(APP) == before, 'Release changed while rebasing'
    history = OUT / 'live-before/identity-before-rebase.json'
    if not history.exists():
        history.write_text(json.dumps(captured, indent=2) + '\n')
    captured.update({'containerId': before['id'], 'imageId': before['imageId'], 'image': before['image'], 'rebaseVerified': True})
    captured_path.write_text(json.dumps(captured, indent=2) + '\n')
    print(json.dumps({'rebased': True, 'overlappingChanges': False, 'newBaseImage': before['image']}), flush=True)


def capture_candidate():
    data = json.loads((RELEASE / 'manifest.json').read_text())
    current(data)
    destination = RELEASE / 'candidate-source'
    destination.mkdir()
    name = 'mbbs-delivery-enhancements-capture'
    script = "const fs=require('node:fs');for(const name of ['src','public','migrations','package.json','package-lock.json'])fs.cpSync('/app/'+name,'/capture/'+name,{recursive:true});"
    try:
        docker('run', '--rm', '--name', name, '--network', 'none', '--init', '--read-only', '--user', '1000:1000',
               '--label', 'com.mbbs.lifecycle=disposable-test', '--cgroup-parent=mbbs-tests.slice', '--memory=512m', '--memory-swap=512m',
               '--pids-limit=128', '--cpus=1', '--tmpfs', '/tmp:size=64m', '-v', str(destination) + ':/capture',
               '--entrypoint', 'node', data['services']['app']['candidateImageId'], '-e', script)
    finally:
        subprocess.run(['sudo', '-n', 'docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (RELEASE / 'capture-docker-ps.log').write_bytes(docker('ps', '--format', '{{.Names}} {{.Status}}'))
        (RELEASE / 'capture-docker-ps-a.log').write_bytes(docker('ps', '-a', '--format', '{{.Names}} {{.Status}}'))
        assert not docker('ps', '-a', '--filter', f'name=^/{name}$', '--format', '{{.ID}}').strip()
    hashes = {str(path.relative_to(destination)): digest(path.read_bytes())
              for folder in ['src', 'public', 'migrations'] for path in (destination / folder).rglob('*') if path.is_file()}
    assert hashes == json.loads((RELEASE / 'candidate-tree.json').read_text()), 'Captured image source changed'
    print(json.dumps({'candidateCaptured': True, 'filesVerified': len(hashes)}), flush=True)


def verify():
    data = json.loads((RELEASE / 'manifest.json').read_text())
    release.core.ready(data['services']['app']['candidateImageId'])
    assert metadata(APP)['configuration'] == data['services']['app']['before']['configuration'], 'Application configuration changed'
    assert {name: metadata(name) for name in DEPENDENCIES} == data['dependencies'], 'Another service changed'
    assert json.loads(docker('exec', APP, 'node', '-e', HASH_SCRIPT)) == json.loads((RELEASE / 'candidate-tree.json').read_text()), 'Live source does not match verified image'
    script = """import assert from 'node:assert/strict';import crypto from 'node:crypto';
const assets=ASSETS;
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
  const health=await fetch(base+'/health');assert.equal(health.status,200);
  for(const [file,hash] of Object.entries(assets)){
    const r=await fetch(base+'/'+file.replace('public/',''),{headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),hash,file);
  }
  for(const audience of ['sales','dispatch']){
    const page=await fetch(base+'/'+audience+'/delivery-requests');assert.equal(page.status,200);assert.match(await page.text(),/20261013-conversation/);
    const denied=await fetch(base+'/api/'+audience+'/delivery-requests/meta');assert.equal(denied.status,401);
  }
}
console.log(JSON.stringify({localHealth:200,publicHealth:200,assetsVerified:Object.keys(assets).length,privateRoutesProtected:true}));"""
    script = script.replace('ASSETS', json.dumps({name: value for name, value in data['sourceHashes'].items() if name.startswith('public/')}))
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    result = {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': IMAGE,
              'imageId': data['services']['app']['candidateImageId'], 'schemaChanged': False,
              'configurationPreserved': True, 'otherServicesPreserved': True, **checks}
    save('result.json', result)
    print(json.dumps(result), flush=True)


def live_documents():
    script = """import assert from 'node:assert/strict';
import {suiteql} from './src/netsuite.js';
import {createDeliveryRequestDocuments} from './src/delivery-request-documents.js';
import {query,closeDb} from './src/db.js';
const result={readOnly:true,estimateVerified:false,salesOrderVerified:false};
try {
  const estimates=await suiteql(`SELECT t.id,t.tranid,t.location FROM transaction t
    WHERE t.type='Estimate' AND t.location IN (1,28,15,26) ORDER BY t.id DESC FETCH FIRST 1 ROW ONLY`);
  const documents=createDeliveryRequestDocuments(),estimate=estimates.items?.[0];
  if(estimate){
    const preview=await documents.estimate(estimate.tranid,Number(estimate.location));
    assert.equal(preview.reference,estimate.tranid);assert.ok(Array.isArray(preview.lines));assert.ok(Number.isFinite(Number(preview.total)));
    result.estimateVerified=true;result.estimateLineCount=preview.lines.length;
  }
  const linked=await query(`SELECT link.order_ref,request.requesting_yard_location_id FROM delivery_request_sales_orders link
    JOIN delivery_requests request ON request.id=link.request_id WHERE request.status='confirmed' ORDER BY request.updated_at DESC LIMIT 1`);
  if(linked.rowCount){
    const row=linked.rows[0],pdf=await documents.salesOrder(row.order_ref,row.requesting_yard_location_id);
    assert.equal(pdf.buffer.subarray(0,5).toString(),'%PDF-');result.salesOrderVerified=true;result.salesOrderPdfBytes=pdf.buffer.length;
  }
  console.log(JSON.stringify(result));
}finally{await closeDb();}
"""
    result = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    save('live-documents.json', result)
    print(json.dumps(result), flush=True)


def apply():
    data = json.loads((RELEASE / 'manifest.json').read_text())
    candidate = json.loads((OUT / 'candidate-final/results/evidence.json').read_text())
    assert all(layer['exitCode'] == 0 for layer in candidate['layers']), 'Exact candidate verification failed'
    assert candidate['coverage']['covered'] == candidate['coverage']['total'], 'Candidate has untested changed lines'
    assert candidate['mutations']['restored'] and all(row['killed'] for row in candidate['mutations']['mutants']), 'Candidate mutation checks failed'
    assert (OUT / 'candidate-final/teardown.log').read_text().endswith('teardown_exit=0\n'), 'Candidate test cleanup failed'
    for name, value in candidate['sourceHashes'].items():
        assert data['sourceHashes'][name] == value, 'Candidate source differs from final tests: ' + name
    current(data)
    release.config_check(data)
    active = json.loads(release.database("""BEGIN READ ONLY;
SELECT json_build_object(
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
 'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
 'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
 'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'));
ROLLBACK;""").removeprefix('BEGIN\n').removesuffix('\nROLLBACK'))
    save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active application operations: ' + json.dumps(active)
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        release.core.ready(data['services']['app']['before']['imageId'])
        save('rollback-result.json', {'rolledBack': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify, 'rebase': rebase, 'capture': capture_candidate, 'documents': live_documents}[sys.argv[1]]()

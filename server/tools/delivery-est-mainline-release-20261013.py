"""Correct estimate yard lookup and unit labels over the deployed combined release."""
import datetime
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'server'
RELEASE = SERVER / 'deployments/delivery-est-mainline-20261013'
OUT = SERVER / 'test-artifacts/delivery-driver-release-20261013/est-final'
spec = importlib.util.spec_from_file_location('estimate_release', SERVER / 'tools/delivery-request-enhancements-deploy.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.RELEASE = RELEASE
base.IMAGE = 'mbbs-operator-app:delivery-driver-est-mainline-20261013'
base.FILES = ['src/delivery-request-documents.js']
base.release.RELEASE = RELEASE
docker, digest, metadata = base.docker, base.digest, base.metadata
APP = base.APP


def current(data):
    assert metadata(APP) == data['services']['app']['before'], 'Live release changed'
    assert {name: metadata(name) for name in base.DEPENDENCIES} == data['dependencies'], 'A dependency changed'
    assert json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT)) == data['beforeTree'], 'Live source changed'
    assert digest((SERVER / base.FILES[0]).read_bytes()) == data['sourceHashes'][base.FILES[0]], 'Estimate correction changed'


base.current = current


def prepare():
    parent = json.loads((SERVER / 'deployments/delivery-driver-20261013/result.json').read_text())
    before = metadata(APP)
    assert before['imageId'] == parent['imageId'], 'Combined deployment changed'
    tree = json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT))
    file = base.FILES[0]
    parent_manifest = json.loads((SERVER / 'deployments/delivery-driver-20261013/manifest.json').read_text())
    assert tree[file] == parent_manifest['sourceHashes'][file]
    RELEASE.mkdir(exist_ok=False)
    stage = RELEASE / 'stage'
    target = stage / file
    target.parent.mkdir(parents=True)
    shutil.copy2(SERVER / file, target)
    source = {file: digest(target.read_bytes())}
    data = {'services': {'app': {'before': before, 'image': base.IMAGE}}, 'beforeTree': tree, 'sourceHashes': source,
            'dependencies': {name: metadata(name) for name in base.DEPENDENCIES}}
    current(data)
    (stage / 'Dockerfile').write_text('FROM ' + before['image'] + '\nCOPY --chown=node:node ' + file + ' /app/' + file + '\n')
    with (RELEASE / 'build.log').open('wb') as log:
        subprocess.run(['sudo', '-n', 'docker', 'build', '--network', 'none', '--pull=false', '-t', base.IMAGE, str(stage)], stdout=log, stderr=subprocess.STDOUT, check=True)
    data['services']['app']['candidateImageId'] = docker('image', 'inspect', '--format', '{{.Id}}', base.IMAGE).decode().strip()
    base.import_check(base.IMAGE)
    assert json.loads((RELEASE / 'candidate-tree.json').read_text()) == {**tree, **source}
    (RELEASE / 'compose.release.yml').write_text('services:\n  app:\n    image: ' + base.IMAGE + '\n')
    (RELEASE / 'compose.rollback.yml').write_text('services:\n  app:\n    image: ' + before['imageId'] + '\n')
    base.release.config_check(data)
    current(data)
    base.save('manifest.json', data)
    base.capture_candidate()
    print(json.dumps({'prepared': True, 'filesChanged': 1}), flush=True)


def verify():
    data = json.loads((RELEASE / 'manifest.json').read_text())
    base.release.core.ready(data['services']['app']['candidateImageId'])
    assert metadata(APP)['configuration'] == data['services']['app']['before']['configuration']
    assert {name: metadata(name) for name in base.DEPENDENCIES} == data['dependencies']
    assert json.loads(docker('exec', APP, 'node', '-e', base.HASH_SCRIPT)) == json.loads((RELEASE / 'candidate-tree.json').read_text())
    script = """import assert from 'node:assert/strict';
import {suiteql} from './src/netsuite.js';
import {createDeliveryRequestDocuments} from './src/delivery-request-documents.js';
import {query,closeDb} from './src/db.js';
try{
 const result=await suiteql(`SELECT t.id,t.tranid,COALESCE(t.location,tl.location) AS location FROM transaction t
  LEFT JOIN transactionline tl ON tl.transaction=t.id AND tl.mainline='T'
  WHERE t.type='Estimate' AND COALESCE(t.location,tl.location) IN (1,28,15,26) ORDER BY t.id DESC FETCH FIRST 1 ROW ONLY`);
 const found=result.items[0];assert.ok(found,'An EST must be available for the live verification');
 const preview=await createDeliveryRequestDocuments().estimate(found.tranid,Number(found.location));
 assert.equal(preview.reference,found.tranid);assert.ok(preview.lines.length>0);assert.ok(Number.isFinite(Number(preview.total)));
 assert.ok(preview.lines.some(line=>line.unit));assert.ok(preview.lines.every(line=>!/^\\d+$/.test(line.unit)));
 const linked=await query(`SELECT link.order_ref,request.requesting_yard_location_id FROM delivery_request_sales_orders link
  JOIN delivery_requests request ON request.id=link.request_id WHERE request.status='confirmed' ORDER BY request.updated_at DESC LIMIT 1`);
 assert.equal(linked.rowCount,1,'A linked SO must be available for the live verification');
 const row=linked.rows[0],pdf=await createDeliveryRequestDocuments().salesOrder(row.order_ref,row.requesting_yard_location_id);
 assert.equal(pdf.buffer.subarray(0,5).toString(),'%PDF-');
 for(const origin of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
  assert.equal((await fetch(origin+'/health')).status,200);
  assert.match(await (await fetch(origin+'/driver-service-worker.js')).text(),/DRIVER_CACHE_PREFIX}v45/);
  assert.match(await (await fetch(origin+'/sales/delivery-requests')).text(),/20261013-conversation/);
 }
 console.log(JSON.stringify({readOnly:true,estimateVerified:true,estimateLineCount:preview.lines.length,unitLabelsVerified:true,
  salesOrderVerified:true,salesOrderPdfBytes:pdf.buffer.length,driverCache:'v45',localHealth:200,publicHealth:200}));
}finally{await closeDb();}"""
    checks = json.loads(docker('exec', '-i', APP, 'node', '--input-type=module', input=script.encode()))
    base.save('result.json', {'deployed': True, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'image': base.IMAGE, 'imageId': data['services']['app']['candidateImageId'],
                             'configurationPreserved': True, 'otherServicesPreserved': True, **checks})
    print(json.dumps(checks), flush=True)


def apply():
    data = json.loads((RELEASE / 'manifest.json').read_text())
    checks = json.loads((OUT / 'results/evidence.json').read_text())
    assert all(row['exitCode'] == 0 for row in checks['layers']) and checks['coverage']['covered'] == checks['coverage']['total']
    assert checks['sourceHashes'][base.FILES[0]] == data['sourceHashes'][base.FILES[0]]
    assert (OUT / 'teardown.log').read_text().endswith('teardown_exit=0\n')
    current(data)
    base.release.config_check(data)
    active = json.loads(base.release.database("""BEGIN READ ONLY;
SELECT json_build_object(
 'operatorPosting',(SELECT count(*) FROM operator_netsuite_posting_commands WHERE status IN ('queued','posting','finalizing')),
 'driverExecuting',(SELECT count(*) FROM driver_foreground_action_receipts WHERE status='executing'),
 'specialCreating',(SELECT count(*) FROM sales_special_stock_cases WHERE sales_order_operation_status='creating' OR purchase_order_operation_status='creating'),
 'stockTransferConfirming',(SELECT count(*) FROM sales_stock_transfers WHERE confirmation_status IN ('creating','approving','hydrating','printing')),
 'regularExecuting',(SELECT count(*) FROM regular_stock_handoffs WHERE status='executing'),
 'deliveryOperations',(SELECT count(*) FROM regular_stock_delivery_operations WHERE status IN ('queued','running')),
 'scmExecuting',(SELECT count(*) FROM scm_smart_proposals WHERE status='executing'));
ROLLBACK;""").removeprefix('BEGIN\n').removesuffix('\nROLLBACK'))
    base.save('active-before-release.json', active)
    assert not any(active.values()), 'Wait for active operations: ' + json.dumps(active)
    current(data)
    try:
        with (RELEASE / 'publish.log').open('wb') as log:
            subprocess.run(base.release.compose(data) + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        verify()
    except Exception:
        with (RELEASE / 'rollback.log').open('wb') as log:
            subprocess.run(base.release.compose(data, 'compose.rollback.yml') + ['up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'app'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=60)
        base.release.core.ready(data['services']['app']['before']['imageId'])
        base.save('rollback-result.json', {'rolledBack': True})
        raise


if __name__ == '__main__':
    {'prepare': prepare, 'apply': apply, 'verify': verify}[sys.argv[1]]()

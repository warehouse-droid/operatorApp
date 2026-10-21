"""Verify the completed direct TO, live yard visibility, and protected records."""
import datetime
import importlib.util
import json
import os
import pathlib
import subprocess
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = pathlib.Path('/home/ubuntu/operatorapp-deploy-backups/to01208-delivery-prep')
ARTIFACT = ROOT / 'server/test-artifacts/operator-to-direct-customer'
spec = importlib.util.spec_from_file_location('direct_release', ROOT / 'server/tools/operator-to-direct-customer-deploy.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

SOURCE = r"""
import assert from 'node:assert/strict';
import {query,withTransaction,closeDb} from './src/db.js';
import {config} from './src/config.js';
import {listReceivingOrders,getReceivingOrder,getReceivableReceivingOrder} from './src/receiving-repository.js';
import {listDeliveryOrders} from './src/delivery-repository.js';
try {
 const result=await withTransaction(async()=>{
  await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const directAccessEnabled=config.netsuite.directAccessEnabled;
  config.netsuite.directAccessEnabled=false; // No remote reads or writes during local UI inspection.
  const order=(await query('SELECT * FROM transfer_orders WHERE netsuite_id=1045195')).rows[0];
  assert.equal(order.tranid,'TOB01208');assert.equal(order.status,'G');
  assert.equal(order.outbound_operator_status,'loaded');assert.equal(order.receiving_status,'received');
  assert.equal(order.local_yard_order_status,'Received');assert.equal(order.fulfillment_status,'fulfilled');
  assert.equal(order.last_item_fulfillment_tranid,'IF157104');assert.ok(order.last_item_receipt_id);
  const jobs=(await query('SELECT * FROM transfer_order_posting_jobs WHERE local_to_id=1045195')).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].transaction_type,'IR');assert.equal(jobs[0].status,'completed');
  assert.equal(jobs[0].operator_record_id,'326');
  const receipts=(await query('SELECT * FROM receiving_receipt_records WHERE order_id=1045195')).rows;
  assert.equal(receipts.length,1);assert.equal(receipts[0].id,'326');
  assert.equal(receipts[0].receipt_status,'local_direct_receipt');assert.equal(receipts[0].operator_id,null);
  const loads=(await query('SELECT * FROM operator_load_records WHERE order_id=1045195')).rows;
  assert.equal(loads.length,0);
  const dependencies=(await query("SELECT * FROM order_dependencies WHERE transfer_order_id=1045195 AND status<>'cancelled'")).rows;
  assert.equal(dependencies.length,1);assert.equal(dependencies[0].sales_order_ref,'SOA09895');
  assert.equal(dependencies[0].dependency_mode,'direct_to_customer');assert.equal(dependencies[0].reconciliation_status,'reconciled');
  const outbound=await listDeliveryOrders({orderType:'transfer_order'});
  assert.ok(!outbound.some(row=>row.tranid==='TOB01208'));
  assert.ok(!outbound.some(row=>row.status==='G'));
  assert.ok(!(await listReceivingOrders({orderType:'transfer_order',destinationLocationId:1,search:'TOB01208'})).some(row=>row.tranid==='TOB01208'));
  const receiving=[];
  for(const expected of [
    {ref:'TOB01134',yard:1,quantities:{2065:104.91,1784:1}},
    {ref:'TOB01200',yard:28,quantities:{426:1}},
    {ref:'TOB01224',yard:28,quantities:{8472:1568,1784:16}}
  ]) {
    const row=(await listReceivingOrders({orderType:'transfer_order',destinationLocationId:expected.yard,search:expected.ref})).find(row=>row.tranid===expected.ref);
    assert.ok(row);const detail=await getReceivingOrder(row.netsuite_id,{destinationLocationId:expected.yard});
    const quantities=Object.fromEntries(detail.lines.map(line=>[String(line.item_id),Number(line.quantity)]));
    assert.deepEqual(quantities,expected.quantities);
    const wrong=expected.yard===1?28:1;
    assert.equal((await listReceivingOrders({orderType:'transfer_order',destinationLocationId:wrong,search:expected.ref})).length,0);
    await assert.rejects(()=>getReceivingOrder(row.netsuite_id,{destinationLocationId:wrong}),error=>error.status===403);
    receiving.push({orderRef:expected.ref,locationId:expected.yard,quantities,wrongYardHidden:true});
  }
  const unloaded=(await query("SELECT netsuite_id,to_location_id FROM transfer_orders WHERE tranid='TOB01221'")).rows[0];
  assert.equal((await listReceivingOrders({orderType:'transfer_order',destinationLocationId:unloaded.to_location_id,search:'TOB01221'})).length,0);
  await assert.rejects(()=>getReceivableReceivingOrder(unloaded.netsuite_id),error=>error.code==='TRANSFER_NOT_LOADED');
  const lines=(await query('SELECT * FROM transfer_order_lines WHERE transfer_order_id=1045195 ORDER BY id')).rows;
  const driver=(await query('SELECT * FROM driver_job_records WHERE job_id=ANY($1::text[])',[BASELINE.driver.map(row=>row.job_id)])).rows;
  const events=(await query('SELECT * FROM dispatch_order_completion_events WHERE id=ANY($1::bigint[])',[BASELINE.events.map(row=>row.id)])).rows;
  const salesLoads=(await query('SELECT * FROM operator_load_records WHERE id=ANY($1::bigint[])',[BASELINE.loads.map(row=>row.id)])).rows;
  const dependencyLines=(await query('SELECT * FROM order_dependency_lines WHERE dependency_id=274')).rows;
  const counts=(await query('SELECT status,COUNT(*)::int AS count FROM transfer_orders GROUP BY status ORDER BY status')).rows;
  const posting=(await query('SELECT transaction_type,status,COUNT(*)::int AS count FROM transfer_order_posting_jobs GROUP BY transaction_type,status ORDER BY transaction_type,status')).rows;
  const gates=(await query("SELECT f.flag_key,f.enabled,f.revision,w.activation_event_id FROM mbt_feature_flags f LEFT JOIN dispatch_sales_order_if_gate_watermarks w ON w.gate_key=f.flag_key WHERE f.flag_key LIKE 'operator_netsuite_%_if_%' OR f.flag_key LIKE 'operator_netsuite_receiving_ir_%' OR f.flag_key LIKE 'dispatch_netsuite_sales_order_if_%' ORDER BY f.flag_key")).rows;
  assert.equal(gates.length,16);assert.ok(gates.every(row=>row.enabled));
  return {at:new Date().toISOString(),order,lines,loads,receipts,dependencies,driver,events,salesLoads,dependencyLines,
    receiving,counts,posting,gates,directAccessEnabled,netSuiteWrites:0};
 });console.log(JSON.stringify(result));
}finally{await closeDb();}
"""


def compare_rows(before, after, identity, ignored=()):
    assert len(before) == len(after), identity
    index = {row[identity]: row for row in after}
    changes = []
    for row in before:
        current = index[row[identity]]
        changes.extend(f'{identity}:{row[identity]}:{key}' for key, value in row.items()
                       if key not in ignored and current.get(key) != value)
    assert not changes, changes


if __name__ == '__main__':
    os.umask(0o077)
    linked = json.loads((STATE / 'linked-before.private.json').read_text())
    local = json.loads((STATE / 'local-before.private.json').read_text())
    program = SOURCE.replace('BASELINE', json.dumps(linked))
    result = subprocess.run(['sudo', '-n', 'docker', 'exec', '-i', '-w', '/app', 'mbbs-operator-app-app-1',
                             'node', '--input-type=module'], input=program, text=True, capture_output=True, cwd=ROOT)
    assert result.returncode == 0, result.stderr[:1200]
    data = json.loads(result.stdout)
    release.release.save(STATE / 'local-after.private.json', data)
    compare_rows(local['lines'], data['lines'], 'id', ['synced_at', 'netsuite_received_qty', 'netsuite_order_line_synced_at', 'raw'])
    compare_rows(local['loads'], data['loads'], 'id')
    compare_rows(local['receipts'], data['receipts'], 'id', ['response'])
    for old, new in zip(local['receipts'], data['receipts']):
        assert all(new['response'].get(key) == value for key, value in old['response'].items())
    compare_rows(local['dependencies'], data['dependencies'], 'id', ['reconciliation_status', 'reconciled_at', 'updated_by', 'updated_at'])
    compare_rows(linked['dependencyLines'], data['dependencyLines'], 'id')
    compare_rows(linked['driver'], data['driver'], 'job_id')
    compare_rows(linked['events'], data['events'], 'id')
    compare_rows(linked['loads'], data['salesLoads'], 'id')
    manifest = json.loads((ARTIFACT / 'manifest.json').read_text())
    before = json.loads((release.STATE / 'before.private.json').read_text())
    app = release.release.inspect('mbbs-operator-app-app-1')
    assert app['Image'] == manifest['candidateImage']
    assert app['State']['Health']['Status'] == 'healthy'
    assert dict(value.split('=', 1) for value in app['Config']['Env']) == dict(value.split('=', 1) for value in before['app']['Config']['Env'])
    assert release.release.runtime_hashes('mbbs-operator-app-app-1', list(manifest['changes'])) == {key: value['after'] for key, value in manifest['changes'].items()}
    for service in ['db', 'ollama', 'webhook-worker']:
        current = release.release.inspect(before[service]['Id'])
        assert current['State']['Running'] and current['Id'] == before[service]['Id']
    with urllib.request.urlopen('http://127.0.0.1:3000/health', timeout=5) as response:
        assert response.status == 200 and json.load(response)['ok']
    summary = {key: data[key] for key in ['at', 'receiving', 'counts', 'posting', 'gates', 'directAccessEnabled', 'netSuiteWrites']}
    summary.update({'orderRef': data['order']['tranid'], 'localStatus': 'completed', 'netSuiteStatus': data['order']['status_text'],
                    'itemFulfillmentRef': data['order']['last_item_fulfillment_tranid'], 'itemReceiptRef': data['order']['last_item_receipt_tranid'],
                    'preserved': ['direct link and allocations', 'Driver jobs and existing completion events', 'SO load records', 'packing and receiving drafts', 'real receipt 326 provenance'],
                    'newPhysicalRecords': 0, 'healthy': True, 'appImage': app['Image']})
    release.release.save(ARTIFACT / 'live-check.json', summary)
    print(json.dumps(summary, indent=2))

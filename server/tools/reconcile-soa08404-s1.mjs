// Executed on stdin in the running app by reconcile-soa08404-s1.py. Rollback by default.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { query, withTransaction, closeDb } from './src/db.js';
import { listDeliveryFulfillments, listDeliveryOrders, listControlLoadedOrders } from './src/delivery-repository.js';
import { listYardMovements } from './src/yard-movement-repository.js';

const APPLY = process.argv.includes('--apply');
const ORDER_ID = '-36096192843271';
const REF = 'SOA08404-S1';
const SOURCE = 'dispatch_order_completion_events';
const EVENT_ID = 15505;
const TYPE = 'historical_reconciliation';
const ACTION = 'delivery.order.historical_reconciliation';
const NOTE = 'Historical reconciliation of missing local yard history, approved by the user. '
  + 'Driver delivery completed on September 10, 2026. The September 15 cleanup had already '
  + 'marked this order Loaded and reconciled its loaded quantities. Original yard operator '
  + 'confirmation and yard photos were not recorded. This entry documents that reconciliation; '
  + 'it does not record a new physical load or a NetSuite fulfillment.';

async function protectedState() {
  return (await query(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY netsuite_id)::text) FROM sales_orders o
      WHERE tranid IN ('SOA08404','SOA08404-S1','SOA08404-S2')) AS headers,
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY l.id)::text) FROM sales_order_lines l JOIN sales_orders o
      ON o.netsuite_id=l.sales_order_id WHERE o.tranid IN ('SOA08404','SOA08404-S1','SOA08404-S2')) AS lines,
    (SELECT md5(jsonb_agg(to_jsonb(j) ORDER BY id)::text) FROM driver_job_records j
      WHERE order_refs ?| ARRAY['SOA08404','SOA08404-S1','SOA08404-S2']) AS driver,
    (SELECT md5(jsonb_agg(to_jsonb(e) ORDER BY id)::text) FROM dispatch_order_completion_events e
      WHERE order_ref IN ('SOA08404','SOA08404-S1','SOA08404-S2')) AS completion_events,
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM operator_load_records l
      WHERE order_ref IN ('SOA08404','SOA08404-S1','SOA08404-S2')
        AND (source_table,source_record_id) IS DISTINCT FROM ($1::text,$2::bigint)) AS prior_load_records,
    (SELECT md5(jsonb_agg(to_jsonb(f) ORDER BY id)::text) FROM delivery_fulfillment_records f
      WHERE order_id IN (985712,-36096192843271,-148211376291204)) AS fulfillments,
    (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY id)::text) FROM delivery_audit_log a
      WHERE order_id IN (985712,-36096192843271,-148211376291204) AND action<>$3) AS prior_audits`,
  [SOURCE, EVENT_ID, ACTION])).rows[0];
}

async function existing() {
  return (await query('SELECT * FROM operator_load_records WHERE source_table=$1 AND source_record_id=$2',
    [SOURCE, EVENT_ID])).rows[0] || null;
}

async function reconcile() {
  const header = (await query('SELECT * FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE', [ORDER_ID])).rows[0];
  assert.equal(header?.tranid, REF);
  assert.equal(header.operator_status, 'loaded');
  assert.equal(header.local_yard_order_status, 'Loaded');
  const event = (await query('SELECT * FROM dispatch_order_completion_events WHERE id=$1 FOR SHARE', [EVENT_ID])).rows[0];
  const driver = (await query(`SELECT id,job_id,status,stop_type,order_refs,completed_at,plan_id,load_id
    FROM driver_job_records WHERE id=3246 FOR SHARE`)).rows[0];
  assert.equal(event?.order_kind, 'SO');
  assert.equal(event.order_ref, REF);
  assert.equal(event.dispatch_completion_status, 'completed');
  assert.equal(event.completion_evidence_type, 'driver_job');
  assert.equal(Number(event.metadata.driverJobRecordId), 3246);
  assert.equal(event.completion_evidence_id, driver?.job_id);
  assert.equal(driver.status, 'complete');
  assert.equal(driver.stop_type, 'dropoff');
  assert.deepEqual(driver.order_refs, [REF]);
  assert.equal(event.dispatch_completed_at.toISOString(), '2026-09-10T17:47:36.878Z');
  assert.equal(driver.completed_at.toISOString(), event.dispatch_completed_at.toISOString());
  assert.equal(String(driver.plan_id), String(event.plan_id));
  assert.equal(driver.load_id, event.load_id);
  const latest = (await query(`SELECT id FROM dispatch_order_completion_events
    WHERE order_ref=$1 ORDER BY dispatch_completed_at DESC,id DESC LIMIT 1`, [REF])).rows[0];
  assert.equal(Number(latest.id), EVENT_ID);

  const lines = (await query(`SELECT * FROM sales_order_lines WHERE sales_order_id=$1
    ORDER BY line_id,id FOR UPDATE`, [ORDER_ID])).rows;
  const loaded = lines.filter(line => Number(line.loaded_qty) > 0);
  assert.deepEqual(loaded.map(line => [line.item_name,Number(line.quantity),Number(line.loaded_qty)]), [
    ['UNI-WIN70S-RDM-SAFARI',459.4,459.4], ['UNI-PISAS-STD/COR-SAFARI',96,96], ['PALLET',7,7],
  ]);
  const snapshot = loaded.map(line => ({
    lineId: String(line.line_id), itemId: String(line.item_id), itemName: line.item_name,
    description: line.item_description || '', quantity: Number(line.quantity), unit: line.unit,
    loadedQty: Number(line.loaded_qty), loadedUom: line.loaded_uom || line.unit,
    snapshotSource: 'existing_reconciled_loaded_quantities',
  }));
  let record = await existing();
  if (!record) {
    assert.equal((await query(`SELECT count(*)::int AS n FROM operator_load_records
      WHERE order_id=$1 OR order_ref=$2`, [ORDER_ID, REF])).rows[0].n, 0, 'A load record already exists; stop');
    assert.equal((await query(`SELECT count(*)::int AS n FROM delivery_audit_log
      WHERE order_id=$1 AND action IN ('delivery.order.load',$2)`, [ORDER_ID, ACTION])).rows[0].n, 0);
    record = (await query(`INSERT INTO operator_load_records (
      load_type,order_family,order_id,order_ref,source_table,source_record_id,operator_id,
      photo_data_url,photo_data_urls,loaded_qty,loaded_uom,line_snapshot,response)
      SELECT $1,'sales_order',$2,$3,$4,e.id,NULL,'','[]'::jsonb,NULL,NULL,$5::jsonb,
        jsonb_build_object('label','Historical reconciliation','recordType',$1::text,
          'localYardOrderStatus','Loaded','historicalReconciliation',true,
          'reconciledAt',transaction_timestamp(),'reconciledBy','Codex maintenance',
          'authorization','User approved historical reconciliation for SOA08404-S1',
          'evidenceSource',e.completion_evidence_type,'completionEventId',e.id,
          'driverJobRecordId',3246,'driverCompletedAt',e.dispatch_completed_at,
          'dispatchPlanDate',e.plan_date,'dispatchLoadName',e.metadata->>'loadName',
          'dispatchTruckPlate',e.metadata->>'truckPlate',
          'originalYardConfirmationRecorded',false,'yardPhotoCount',0,
          'newPhysicalLoad',false,'quantityChanged',false,'netSuiteWrite',false,'note',$6::text)
      FROM dispatch_order_completion_events e WHERE e.id=$7 RETURNING *`,
    [TYPE, ORDER_ID, REF, SOURCE, JSON.stringify(snapshot), NOTE, EVENT_ID])).rows[0];
    await query(`INSERT INTO delivery_audit_log(actor_type,actor_operator_id,source,action,order_id,details)
      VALUES ('system',NULL,'historical_reconciliation',$1,$2,$3::jsonb)`,
    [ACTION, ORDER_ID, JSON.stringify({ ...record.response, loadRecordId: record.id,
      sourceTable: SOURCE, sourceRecordId: EVENT_ID })]);
  }
  assert.equal(record.load_type, TYPE);
  assert.equal(record.order_family, 'sales_order');
  assert.equal(String(record.order_id), ORDER_ID);
  assert.equal(record.order_ref, REF);
  assert.equal(record.operator_id, null);
  assert.equal(record.photo_data_url, '');
  assert.deepEqual(record.photo_data_urls, []);
  assert.equal(record.loaded_qty, null);
  assert.equal(record.loaded_uom, null);
  assert.equal(record.reload_cycle_id, null);
  assert.equal(record.load_request_id, null);
  assert.deepEqual(record.line_snapshot, snapshot);
  assert.equal(record.response.label, 'Historical reconciliation');
  assert.equal(record.response.historicalReconciliation, true);
  assert.equal(record.response.originalYardConfirmationRecorded, false);
  assert.equal(record.response.newPhysicalLoad, false);
  assert.equal(record.response.netSuiteWrite, false);
  assert.equal(record.response.note, NOTE);
  assert.equal(Number(record.response.completionEventId), EVENT_ID);
  assert.equal(Number(record.response.driverJobRecordId), 3246);
  assert.equal(new Date(record.response.reconciledAt).toISOString(), record.created_at.toISOString());
  return record;
}

try {
  const initial = await existing();
  const result = await withTransaction(async () => {
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='20s'");
    await query("SELECT pg_advisory_xact_lock(hashtext('historical_reconciliation:SOA08404-S1'))");
    const before = await protectedState();
    const filters = {from:'2026-09-10',to:new Date().toISOString().slice(0,10),search:REF};
    const activeBefore = await listDeliveryOrders({orderType:'sales_order',status:'active'});
    const loadedBefore = await listControlLoadedOrders(filters);
    const movementBefore = await listYardMovements(filters);
    const record = await reconcile();
    assert.deepEqual(await reconcile(), record, 'Re-running must not update or duplicate the record');
    assert.deepEqual(await protectedState(), before, 'Protected order or completion data changed');
    assert.deepEqual(await listDeliveryOrders({orderType:'sales_order',status:'active'}), activeBefore);
    assert.deepEqual(await listControlLoadedOrders(filters), loadedBefore, 'Reconciliation counted as a new physical load');
    assert.deepEqual(await listYardMovements(filters), movementBefore, 'Physical movement evidence changed');
    const records = await listDeliveryFulfillments({limit:100});
    const visible = records.find(row => String(row.id) === String(record.id));
    assert.ok(visible, 'Historical reconciliation must be visible in Operator Load Records');
    assert.equal(visible.fulfillment_status, TYPE);
    assert.equal(visible.photo_count, 0);
    assert.equal(visible.operator_name, null);
    const control = await readFile('/app/public/control.js','utf8');
    const renderer = control.slice(control.indexOf('function renderFulfillmentSection()'), control.indexOf('function valueText('));
    const html = vm.runInNewContext(`(${renderer})()`, {
      fulfillmentRecords:[visible],t:(_key,fallback)=>fallback,formatDate:value=>String(value),
    });
    assert.ok(html.includes(REF) && html.includes(TYPE) && html.includes('Historical reconciliation'));
    const audits = (await query(`SELECT id,details FROM delivery_audit_log WHERE order_id=$1 AND action=$2`, [ORDER_ID,ACTION])).rows;
    assert.equal(audits.length, 1);
    assert.equal(String(audits[0].details.loadRecordId), String(record.id));
    return {applied:APPLY,created:!initial,recordId:record.id,auditId:audits[0].id,
      orderRef:REF,label:record.response.label,recordType:TYPE,reconciledAt:record.response.reconciledAt,
      driverCompletedAt:record.response.driverCompletedAt,completionEventId:EVENT_ID,driverJobRecordId:3246,
      protectedState:before,visibleInOperatorLoadRecords:true,idempotent:true,
      quantitiesAndCompletionUnchanged:true,physicalLoadAndMovementReportsUnchanged:true,netSuiteWrite:false};
  }, {rollback:!APPLY});
  const persisted = await existing();
  if (APPLY) assert.equal(String(persisted?.id), String(result.recordId));
  else assert.deepEqual(persisted, initial, 'Rollback did not restore the original records');
  console.log(JSON.stringify({...result,rollbackVerified:!APPLY}));
} finally { await closeDb(); }

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {after} from 'node:test';
import {beginRollbackContext, closeDb, query} from '../../../src/db.js';
import {getYardMovementDetail, listYardMovementCsvRows, listYardMovements} from '../../../src/yard-movement-repository.js';

after(closeDb);
const date = '2097-10-10';
const range = {from: date, to: date, yard: 'all'};

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const base = 9_200_000_000 + crypto.randomInt(100_000_000), suffix = crypto.randomUUID();
      const sourceRef = `POB-${suffix}`, savedSourceRef = `OLD-PO-${suffix}`, sourceAlias = `PARENT-ALIAS-${suffix}`;
      const parent = base, receiptChild = -base, driverChild = -base - 1, unprocessed = -base - 2, registered = -base - 3, unrelated = -base - 4;
      const refs = new Map([[parent, sourceRef], [receiptChild, `SN-A-${suffix}`], [driverChild, `INVOICE-B-${suffix}`],
        [unprocessed, `SN-NO-RECORD-${suffix}`], [registered, `GLOBAL-C-${suffix}`], [unrelated, `OTHER-D-${suffix}`]]);
      for (const [id, ref] of refs) {
        await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor,destination_location_id,destination_location,
          source_location,netsuite_active,receipt_status) VALUES($1,$2,$3,'TEST Vendor',$4,$5,'TEST Supplier',true,'received')`,
        [id, id === receiptChild ? `NS-CANON-${suffix}` : ref, id === parent ? sourceAlias : ref, id === driverChild ? 28 : 1, id === driverChild ? '2967' : '3445']);
      }
      for (const child of [receiptChild, driverChild, unprocessed]) {
        await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref,status)
          VALUES($1,$2,$3,$4,$5)`, [parent, savedSourceRef, child, refs.get(child), child === receiptChild ? 'cancelled' : 'active']);
      }
      // Multiple historical memberships must not multiply the child's evidence.
      await query(`INSERT INTO dispatch_scm_po_splits(source_po_id,source_po_ref,split_po_id,split_po_ref)
        VALUES($1,$2,$3,$4)`, [parent, savedSourceRef, receiptChild, `RETIRED-NAME-${suffix}`]);
      await query(`INSERT INTO dispatch_global_order_splits(split_ref,order_type,definition_kind,parent_order_ref,
        source_plan_date,full_order,card,active) VALUES($1,'PO','split',$2,$3,'{}','{}',false)`, [refs.get(registered), sourceRef, date]);
      for (const id of [receiptChild, registered, unrelated]) {
        await query(`INSERT INTO receiving_receipt_records(order_id,receipt_status,photo_data_urls,created_at)
          VALUES($1,'received','["data:image/png;base64,YQ==","data:image/png;base64,Yg=="]',$2::timestamptz)`, [id, date + 'T10:00:00Z']);
      }
      await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,
        stop_id,stop_type,order_refs,photo_data_urls,status,started_at,completed_at,job_details)
        VALUES($1,$2,'test-po-driver','TEST-TRUCK','TEST-123','TEST-LOAD','TEST Load','TEST-STOP','dropoff',$3,
          '[]','complete',$4,$5,'{}')`, [suffix, date, JSON.stringify([refs.get(driverChild)]), date + 'T11:00:00Z', date + 'T12:00:00Z']);
      // IDs overlap between order families; only PO movements inherit PO parents.
      await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,outbound_location,netsuite_active)
        VALUES($1,$2,1,'3445',true)`, [receiptChild, `SOB-UNRELATED-${suffix}`]);
      await query(`INSERT INTO operator_load_records(order_id,order_family,load_type,line_snapshot,photo_data_urls,created_at)
        VALUES($1,'sales_order','sales_order_delivery_load','[]','[]',$2)`, [receiptChild, date + 'T13:00:00Z']);
      await run({sourceRef, savedSourceRef, sourceAlias, receiptChild, driverChild, registered, unprocessed, unrelated, refs, suffix});
    });
  } finally { await rollback.rollback(); }
}

const ids = rows => rows.map(row => Number(row.order_id)).sort((a,b) => a-b);

test('parent PO search finds arbitrarily named receipt and driver split children, including historical and registered splits', async () => fixture(async f => {
  const expected = [f.receiptChild, f.driverChild, f.registered].sort((a,b) => a-b);
  const rows = await listYardMovements({...range, search: f.sourceRef.toLowerCase()});
  assert.deepEqual(ids(rows), expected);
  assert(rows.every(row => row.order_type === 'purchase_order'));
  const received = rows.find(row => Number(row.order_id) === f.receiptChild);
  assert.equal(received.tranid, f.refs.get(f.receiptChild));
  assert.equal(received.process_count, 1);
  assert.equal(received.yard_photo_count, 2);
  assert.equal(rows.find(row => Number(row.order_id) === f.driverChild).driver_only, true);
  assert(!ids(rows).includes(f.unprocessed));
  assert(!ids(rows).includes(f.unrelated));
  assert.deepEqual(ids(await listYardMovements({...range, search: f.savedSourceRef})), [f.driverChild, f.receiptChild].sort((a,b) => a-b));
  assert.deepEqual(ids(await listYardMovements({...range, search: f.sourceAlias})), [f.driverChild, f.receiptChild].sort((a,b) => a-b));
  assert.deepEqual(ids(await listYardMovements({...range, search: f.sourceRef.slice(0, 10)})), expected);
}));

test('parent PO matches retain physical yard authorization, direction, date and driver filters', async () => fixture(async f => {
  const search = {...range, search: f.sourceRef};
  const permitted = [f.receiptChild, f.registered].sort((a,b) => a-b);
  assert.deepEqual(ids(await listYardMovements({...search, allowedYardLocationIds: [1]})), permitted);
  assert.deepEqual(ids(await listYardMovements({...search, allowedSalesStoreLocationIds: [1]})), permitted);
  assert.deepEqual(await listYardMovements({...search, allowedSalesStoreLocationIds: []}), []);
  assert.deepEqual(await listYardMovements({...search, direction: 'outbound'}), []);
  assert.deepEqual(await listYardMovements({...search, orderType: 'sales_order'}), []);
  assert.deepEqual(await listYardMovements({...search, from: '2097-10-11', to: '2097-10-11'}), []);
  assert.deepEqual(ids(await listYardMovements({...search, driver: 'test-po-driver'})), [f.driverChild]);
}));

test('own child aliases stay searchable without siblings, and detail/CSV preserve the split identity', async () => fixture(async f => {
  for (const term of [f.refs.get(f.receiptChild), `NS-CANON-${f.suffix}`]) {
    assert.deepEqual(ids(await listYardMovements({...range, search: term})), [f.receiptChild]);
  }
  const detail = await getYardMovementDetail({...range, direction: 'inbound', orderType: 'purchase_order', orderId: f.driverChild, allowedSalesStoreLocationIds: [28]});
  assert.equal(Number(detail.order.order_id), f.driverChild);
  assert.equal(detail.order.tranid, f.refs.get(f.driverChild));
  assert.equal(detail.driverRecords.length, 1);
  assert.equal(await getYardMovementDetail({...range, direction: 'inbound', orderType: 'purchase_order', orderId: f.driverChild, allowedSalesStoreLocationIds: [1]}), null);
  const csv = await listYardMovementCsvRows({...range, search: f.sourceRef});
  assert.deepEqual([...new Set(csv.map(row => row.order_ref))].sort(), [f.receiptChild, f.driverChild, f.registered].map(id => f.refs.get(id)).sort());
}));

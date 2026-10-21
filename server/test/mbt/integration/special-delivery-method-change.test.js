import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { createSpecialFulfillmentService } from '../../../src/special-stock-fulfillment.js';
import { listSpecialDeliveryMethodAlerts, acknowledgeSpecialDeliveryMethodAlert } from '../../../src/special-delivery-method-alerts.js';
import { withBackorderWorkflow } from '../../../src/stock-case-workflow.js';

after(closeDb);
const sales = { operatorId: 'delivery-change-test', authorizedStoreLocationIds: [1] };
const scm = { operatorId: sales.operatorId, audience: 'scm' };
const dispatch = { ...scm, audience: 'dispatch' };
const input = { storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST pickup', vendorName: 'TEST vendor',
  fulfillmentMethod: 'vendor_pickup', lines: [{ productName: 'TEST stone', quantity: 3, uom: 'SQFT', rate: 42, requiredDate: '2099-02-01' }] };
const update = createSpecialFulfillmentService({ prepare: () => assert.fail('Both pickup methods use the same NetSuite method'), apply: () => assert.fail('Pickup location change must stay local') });
async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      for (const id of [sales.operatorId, 'delivery-other-test']) {
        await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','admin',ARRAY['admin'],ARRAY[1]) ON CONFLICT DO NOTHING", [id]);
      }
      await run();
    });
  } finally { await rollback.rollback(); }
}
async function linked() {
  const d = await repo.createSpecialStockCase(input, sales);
  await query("INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active,order_location_id,delivery_method_id,sales_order_type) VALUES(8899951,'TEST-DELIVERY-SO','B','Pending Fulfillment',true,1,1,'Pickup')");
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,netsuite_active) VALUES(8899952,'TEST-DELIVERY-PO','TEST-UPDATED-REF','B','Pending Receipt',true)");
  await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8899951,sales_order_ref='TEST-DELIVERY-SO',sales_order_approved=true,purchase_order_netsuite_id=8899952,purchase_order_ref='TEST-DELIVERY-PO',purchase_order_custom_linkage=true WHERE request_id=$1", [d.id]);
  await query("UPDATE sales_special_stock_lines SET supply_status='in_stock',sales_decision='accepted' WHERE request_id=$1", [d.id]);
  return repo.getSpecialStockCase(d.id, { audience: 'sales', authorizedStoreLocationIds: [1] });
}
const notifications = async id => (await query("SELECT id,details FROM sales_special_stock_events WHERE request_id=$1 AND event_type='special_delivery_method_updated' AND details->>'notifyTeams'='true' ORDER BY id", [id])).rows;
const canonical = async () => ({ so: (await query('SELECT * FROM sales_orders WHERE netsuite_id=8899951')).rows,
  po: (await query('SELECT * FROM purchase_orders WHERE netsuite_id=8899952')).rows });

test('linked SO, PO and updated PO Ref can switch vendor pickup to own yard with one durable team notice', () => fixture(async () => {
  let d = await linked(); const before = await canonical(), lines = d.lines;
  d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' }, sales);
  assert.equal(d.fulfillmentMethod, 'yard_pickup'); assert.equal(d.operationalYardLocationId, 1);
  assert.equal(d.purchaseOrderReference, 'TEST-UPDATED-REF'); assert.equal(d.purchaseOrderCustomLinkage, true);
  assert.deepEqual(await canonical(), before); assert.deepEqual(d.lines, lines);
  assert.equal(d.handoff.status, 'waiting_route'); assert.equal(d.stage, 'dispatch_arrangement');
  const notices = await notifications(d.id); assert.equal(notices.length, 1);
  assert.equal(notices[0].details.before, 'vendor_pickup'); assert.equal(notices[0].details.fulfillmentMethod, 'yard_pickup');
  for (const context of [scm, dispatch]) {
    const notice = (await listSpecialDeliveryMethodAlerts(context)).alerts.find(row => row.requestId === d.id);
    assert.ok(notice); assert.equal(notice.beforeMethod, 'vendor_pickup'); assert.equal(notice.fulfillmentMethod, 'yard_pickup');
    assert.equal(notice.yardName, '3445'); assert.equal(notice.salesOrderRef, 'TEST-DELIVERY-SO');
    assert.equal(notice.purchaseOrderRef, 'TEST-DELIVERY-PO'); assert.equal(notice.purchaseOrderReference, 'TEST-UPDATED-REF');
    assert.equal(notice.audience, context.audience);
  }
}));
test('acknowledgements persist per user and team, while later changes and completed cases remain visible', () => fixture(async () => {
  let d = await linked(); d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' }, sales);
  const first = (await listSpecialDeliveryMethodAlerts(scm)).alerts.find(row => row.requestId === d.id);
  assert.ok(first);
  assert.deepEqual(await acknowledgeSpecialDeliveryMethodAlert(first.id, {}, scm), { acknowledged: true });
  assert.deepEqual(await acknowledgeSpecialDeliveryMethodAlert(first.id, {}, scm), { acknowledged: true });
  assert.equal((await listSpecialDeliveryMethodAlerts(scm)).alerts.some(row => row.id === first.id), false);
  for (const context of [dispatch, { ...scm, operatorId: 'delivery-other-test' }]) {
    assert.equal((await listSpecialDeliveryMethodAlerts(context)).alerts.some(row => row.id === first.id), true);
  }
  d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'vendor_pickup' }, sales);
  await query("UPDATE sales_special_stock_cases SET close_status='closed',operationally_complete=true WHERE request_id=$1", [d.id]);
  assert.equal((await listSpecialDeliveryMethodAlerts(scm)).alerts.filter(row => row.requestId === d.id).length, 1);
  assert.equal((await listSpecialDeliveryMethodAlerts(dispatch)).alerts.filter(row => row.requestId === d.id).length, 2);
}));
test('failed changes publish nothing and retry preserves the saved target with a single notice', () => fixture(async () => {
  let d = await linked(); let fail = true;
  const service = createSpecialFulfillmentService({ prepare: () => assert.fail('Pickup is local'), apply: () => assert.fail('Pickup is local'),
    finish: async (...args) => { if (fail) { fail = false; throw Error('Save interrupted'); } return repo.finishSpecialFulfillmentChange(...args); } });
  await assert.rejects(() => service(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' }, sales), /Save interrupted/);
  assert.equal((await notifications(d.id)).length, 0);
  d = await repo.getSpecialStockCase(d.id); const changeId = d.fulfillmentChange.id;
  d = await service(d.id, { expectedRevision: d.revision, changeId, fulfillmentMethod: 'vendor_pickup' }, sales);
  assert.equal(d.fulfillmentMethod, 'yard_pickup'); assert.equal((await notifications(d.id)).length, 1);
  const revision = d.revision;
  d = await service(d.id, { expectedRevision: revision, changeId }, sales);
  assert.equal(d.revision, revision); assert.equal((await notifications(d.id)).length, 1);
}));
test('saving an unchanged method creates no team notice and historical events are not replayed', () => fixture(async () => {
  let d = await linked();
  await query("INSERT INTO sales_special_stock_events(request_id,event_type,details) VALUES($1,'special_delivery_method_updated','{\"before\":\"yard_pickup\",\"fulfillmentMethod\":\"vendor_pickup\"}')", [d.id]);
  d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'vendor_pickup' }, sales);
  assert.equal((await notifications(d.id)).length, 0);
  for (const context of [scm, dispatch]) { assert.equal((await listSpecialDeliveryMethodAlerts(context)).alerts.some(row => row.requestId === d.id), false); }
}));
test('pre-SO header method change alerts teams and a note-only save does not', () => fixture(async () => {
  let d = await repo.createSpecialStockCase(input, sales);
  d = await repo.updateSpecialStockHeader(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup', remarks: 'Call first' }, sales);
  assert.equal((await notifications(d.id)).length, 1);
  d = await repo.updateSpecialStockHeader(d.id, { expectedRevision: d.revision, remarks: 'Call again' }, sales);
  assert.equal((await notifications(d.id)).length, 1);
}));
test('wrong yard, stale revision, planned or closed fulfillment cannot create a notice', () => fixture(async () => {
  const d = await linked(); const change = { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' };
  await assert.rejects(() => update(d.id, change, { ...sales, authorizedStoreLocationIds: [28] }), { code: 'SPECIAL_CASE_STORE_FORBIDDEN' });
  await assert.rejects(() => update(d.id, { ...change, expectedRevision: d.revision + 1 }, sales), { code: 'SPECIAL_REVISION_CONFLICT' });
  await query('UPDATE sales_orders SET dispatch_planned=true WHERE netsuite_id=8899951');
  await assert.rejects(() => update(d.id, change, sales), { code: 'SPECIAL_FULFILLMENT_PLANNED' });
  await query('UPDATE sales_orders SET dispatch_planned=false WHERE netsuite_id=8899951');
  await query("UPDATE sales_special_stock_cases SET close_status='closed' WHERE request_id=$1", [d.id]);
  await assert.rejects(() => update(d.id, change, sales), { code: 'SPECIAL_FULFILLMENT_CLOSED' });
  assert.equal((await notifications(d.id)).length, 0); assert.equal((await repo.getSpecialStockCase(d.id)).fulfillmentMethod, 'vendor_pickup');
}));
test('invalid recipient and alert IDs fail without acknowledgement writes', () => fixture(async () => {
  for (const audience of ['sales', 'public', '', null]) { await assert.rejects(() => listSpecialDeliveryMethodAlerts({ ...scm, audience }), { status: 400 }); }
  await assert.rejects(() => listSpecialDeliveryMethodAlerts({ audience: 'scm' }), { status: 400 });
  for (const id of [0, -1, 1.5, '1 OR 1=1', null]) { await assert.rejects(() => acknowledgeSpecialDeliveryMethodAlert(id, {}, scm), { status: 400 }); }
  await assert.rejects(() => acknowledgeSpecialDeliveryMethodAlert(999999999, {}, scm), { status: 404 });
}));
test('property: nonpositive numeric IDs and malformed text can never acknowledge a team notice', () => fixture(async () => {
  await fc.assert(fc.asyncProperty(fc.oneof(fc.integer({ min: -1000000, max: 0 }), fc.string().filter(value => !/^\s*\d+\s*$/.test(value) && !Number.isSafeInteger(Number(value)))), async id => {
    await assert.rejects(() => acknowledgeSpecialDeliveryMethodAlert(id, {}, scm), { status: 400 });
  }), { numRuns: 60, seed: 410041 });
}));
test('notification write failure rolls back method, revision and handoff atomically', () => fixture(async () => {
  let d = await linked();
  d = await repo.claimSpecialFulfillmentChange(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' }, sales);
  const changeId = d.fulfillmentChange.id, revision = d.revision;
  await query("CREATE FUNCTION test_delivery_notice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.details->>'notifyTeams'='true' THEN RAISE EXCEPTION 'TEST alert unavailable'; END IF; RETURN NEW; END $$");
  await query('CREATE TRIGGER test_delivery_notice_failure BEFORE INSERT ON sales_special_stock_events FOR EACH ROW EXECUTE FUNCTION test_delivery_notice_failure()');
  await assert.rejects(() => repo.finishSpecialFulfillmentChange(d.id, changeId, {}, sales), /TEST alert unavailable/);
  d = await repo.getSpecialStockCase(d.id); assert.equal(d.fulfillmentMethod, 'vendor_pickup'); assert.equal(d.revision, revision);
  assert.equal(d.handoff, null); assert.equal((await notifications(d.id)).length, 0);
}));
test('the Backorder workflow does not emit Special team notices', () => fixture(() => withBackorderWorkflow(async () => {
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,raw,synced_at) VALUES(8899959,'TEST backorder stone','SQFT','{}',now()) ON CONFLICT DO NOTHING");
  let d = await repo.createSpecialStockCase({ ...input, lines: [{ ...input.lines[0], regularItemId: 8899959, regularItemCode: 'TEST' }] }, sales);
  d = await update(d.id, { expectedRevision: d.revision, fulfillmentMethod: 'yard_pickup' }, sales);
  assert.equal(d.fulfillmentMethod, 'yard_pickup'); assert.equal((await notifications(d.id)).length, 0);
})));

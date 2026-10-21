import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { beginRollbackContext, closeDb, query } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { submitBackorderRequest, runBackorderAction } from '../../../src/backorder-request-service.js';
import { torontoDate } from '../../../public/special-stock-workflow.js';
import { specialTransferAvailableDate } from '../../../public/special-stock-transfer-eta.js';

after(closeDb);
const context = { operatorId: 'special-transfer-test', authorizedStoreLocationIds: [1] };
const response = { supplyStatus: 'vendor_transfer', availabilityMode: 'no_projection', vendorId: 8899200, vendorName: 'TEST Vendor', vendorYard: 'TEST dock' };
async function isolated(fn) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const transaction = await beginRollbackContext();
  try { await transaction.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST Transfer Rep','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,trandate,status_text,netsuite_active) VALUES(8899211,'TEST-TRANSFER-SO','2026-10-09','Pending Fulfillment',true)");
    await fn();
  }); } finally { await transaction.rollback(); }
}
async function create(count = 1) {
  return repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Transfer', vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: Array.from({ length: count }, (_, i) => ({ productName: 'TEST slab ' + i, quantity: 2, uom: 'PCS', rate: 10, requiredDate: '2099-02-01' })) }, context);
}
const respond = (d, index = 0, patch = {}) => repo.respondSpecialStockLine(d.id, d.lines[index].id, { expectedRevision: d.revision, ...response, ...patch }, context);
const accept = (d, index = 0) => repo.decideSpecialStockLine(d.id, d.lines[index].id, { expectedRevision: d.revision, decision: 'accepted' }, context);
const link = (d, patch = {}) => repo.linkSpecialSalesOrder(d.id, { expectedRevision: d.revision, salesOrderRef: 'TEST-TRANSFER-SO', ...patch }, context);
const readiness = (d, patch = {}) => repo.checkSpecialStockReadiness(d.id, d.lines[0].id, { expectedRevision: d.revision, ready: false, ...patch }, context);

test('transfer acceptance and not-ready checks work before SO; failed links leave the ETA unset', () => isolated(async () => {
  let d = await create();
  await query("UPDATE sales_special_stock_lines SET reminder_due_date='2020-01-01' WHERE request_id=$1", [d.id]);
  d = await respond(d);
  assert.equal(d.lines[0].availabilityMode, 'so_placement');
  assert.equal(d.lines[0].availableDate, null);
  d = await accept(d);
  assert.equal(d.lines[0].salesDecision, 'accepted');
  assert.equal(d.lines[0].reminderDueDate, null);
  assert.deepEqual(d.readinessAlerts, []);
  d = await readiness(d, { eta: '2099-02-01' });
  assert.equal(d.lines[0].availableDate, null);
  assert.equal(d.lines[0].availabilityMode, 'so_placement');
  const before = d.revision;
  await assert.rejects(link(d, { salesOrderRef: 'DOES-NOT-EXIST' }), { code: 'SPECIAL_SO_NOT_FOUND' });
  d = await repo.getSpecialStockCase(d.id);
  assert.equal(d.revision, before);
  assert.equal(d.salesOrderPlacedDate, null);
  assert.equal(d.lines[0].availableDate, null);
  d = await readiness(d, { ready: true });
  assert.equal(d.lines[0].supplyStatus, 'in_stock');
  assert.equal(d.lines[0].availabilityMode, 'no_projection');
  assert.equal(d.lines[0].availableDate, null);
}));

test('manual SO link dates only active new-policy transfers and preserves legacy, production and declined lines', () => isolated(async () => {
  let d = await create(4);
  d = await respond(d); d = await accept(d);
  await query("UPDATE sales_special_stock_lines SET supply_status='vendor_transfer',availability_mode='dated',available_date='2020-01-10',sales_decision='accepted' WHERE id=$1", [d.lines[1].id]);
  d = await respond(d, 2, { supplyStatus: 'production', availabilityMode: 'dated', availableDate: '2099-02-01' });
  d = await respond(d, 3);
  d = await repo.decideSpecialStockLine(d.id, d.lines[3].id, { expectedRevision: d.revision, decision: 'declined', reason: 'TEST decline' }, context);
  d = await link(d);
  assert.equal(d.salesOrderPlacedDate, '2026-10-09');
  assert.deepEqual(d.lines.map(line => line.availableDate), ['2026-10-19', '2020-01-10', '2099-02-01', null]);
  assert.equal(d.lines[0].salesDecision, 'accepted');
  assert.equal(d.lines[0].availabilityMode, 'so_placement');
  assert.equal(d.lines[0].reminderDueDate, '2026-10-14');
  assert.ok(d.events.some(event => event.eventType === 'special_transfer_eta_scheduled' && event.details.availableDate === '2026-10-19'));
  await query("UPDATE sales_orders SET trandate='2026-10-16' WHERE netsuite_id=8899211");
  d = await link(d);
  assert.equal(d.salesOrderPlacedDate, '2026-10-09');
  assert.equal(d.lines[0].availableDate, '2026-10-19');
  d = await readiness(d, { eta: '2099-02-05' });
  assert.equal(d.lines[0].availableDate, '2099-02-05');
  assert.equal(d.lines[0].availabilityMode, 'dated');
  d = await link(d);
  assert.equal(d.lines[0].availableDate, '2099-02-05');
  d = await readiness(d, { ready: true });
  assert.equal(d.lines[0].availableDate, null);
  assert.equal(d.lines[0].reminderDueDate, null);
}));

test('automatic SO recovery anchors transfer ETA to original Toronto submission day, not recovery time', () => isolated(async () => {
  let d = await accept(await respond(await create()));
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit) VALUES(2055,'TEST Special','PCS') ON CONFLICT DO NOTHING");
  await query("UPDATE sales_special_stock_lines SET resolved_item_id=2055,resolved_item_name='TEST Special',sales_quantity=2,sales_uom='PCS' WHERE request_id=$1", [d.id]);
  await query("UPDATE sales_special_stock_cases SET pallet_total=0,sales_order_submission_started_at='2026-10-10T02:30:00Z' WHERE request_id=$1", [d.id]);
  d = await link(d, { source: 'standalone', salesOrderId: 8899211, verifiedRemote: true });
  assert.equal(d.salesOrderPlacedDate, '2026-10-09');
  assert.equal(d.lines[0].availableDate, '2026-10-19');
  d = await readiness(d);
  assert.equal(d.lines[0].availableDate, '2026-10-19');
  assert.equal(d.lines[0].availabilityMode, 'so_placement');
}));

test('manual SO without a transaction date saves its link day once', () => isolated(async () => {
  await query('UPDATE sales_orders SET trandate=NULL WHERE netsuite_id=8899211');
  let d = await link(await accept(await respond(await create())));
  assert.equal(d.salesOrderPlacedDate, torontoDate());
  assert.equal(d.lines[0].availableDate, specialTransferAvailableDate(torontoDate()));
  d = await link(d);
  assert.equal(d.salesOrderPlacedDate, torontoDate());
}));

test('Backorder transfer checks use the linked SO placement date even when the check is submitted later', () => isolated(async () => {
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,stock_unit,vendor,vendor_id) VALUES(8899221,'TEST-TRANSFER-REG','TEST material','EA','TEST Vendor',8899200)");
  let d = await submitBackorderRequest({ destinationLocationId: 1, vendorName: 'TEST Vendor', vendorId: 8899200, fulfillmentMethod: 'yard_pickup',
    lines: [{ itemId: 8899221, salesQty: 2, quantityMode: 'direct', requiredDate: '2099-02-01' }] }, { operatorId: context.operatorId, authorizedDestinationLocationIds: [1] });
  const action = (role, name, input) => runBackorderAction(d.id, name, { expectedRevision: d.revision, ...input }, { ...context, audience: role });
  d = await action('scm', `lines/${d.lines[0].id}/response`, response);
  d = await action('sales', `lines/${d.lines[0].id}/decision`, { decision: 'accepted' });
  assert.equal(d.lines[0].availableDate, null);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8899222,'TEST-TRANSFER-PO','Pending Receipt',true)");
  d = await action('scm', 'purchase-order/link', { purchaseOrderRef: 'TEST-TRANSFER-PO' });
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES('2099-04-10','draft') RETURNING id")).rows[0].id;
  await query("INSERT INTO dispatch_plan_snapshots(plan_id,orders,trucks,summary) VALUES($1,$2,$3,'{}')", [plan,
    JSON.stringify([{ id: 'TEST-TRANSFER-PO', type: 'PO' }]), JSON.stringify([{ plate: 'TEST TRANSFER', loads: [{ stops: [{ type: 'pickup', orderId: 'TEST-TRANSFER-PO' }] }] }])]);
  d = await action('sales', 'sales-order/link', { salesOrderRef: 'TEST-TRANSFER-SO' });
  assert.equal(d.lines[0].availableDate, '2026-10-19');
  await query('UPDATE sales_special_stock_cases SET sales_order_placed_date=NULL WHERE request_id=$1', [d.id]);
  d = await action('scm', `lines/${d.lines[0].id}/response`, { ...response, availableDate: '2099-12-30' });
  assert.equal(d.salesOrderPlacedDate, '2026-10-09');
  assert.equal(d.lines[0].availableDate, '2026-10-19');
  assert.equal(d.lines[0].salesDecision, 'pending');
  assert.equal(d.lines[0].availabilityMode, 'so_placement');
}));


test('a failure after scheduling transfer ETA rolls back the SO link, placement date, dates and audit events together', () => isolated(async () => {
  let d = await accept(await respond(await create()));
  const before = (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1', [d.id])).rows;
  const events = (await query('SELECT * FROM sales_special_stock_events WHERE request_id=$1 ORDER BY id', [d.id])).rows;
  await query("CREATE FUNCTION test_fail_transfer_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='special_sales_order_linked' THEN RAISE EXCEPTION 'TEST link failure'; END IF; RETURN NEW; END $$");
  await query('CREATE TRIGGER test_transfer_failure BEFORE INSERT ON sales_special_stock_events FOR EACH ROW EXECUTE FUNCTION test_fail_transfer_link()');
  await assert.rejects(link(d), /TEST link failure/);
  d = await repo.getSpecialStockCase(d.id);
  assert.equal(d.salesOrderId, null);
  assert.equal(d.salesOrderPlacedDate, null);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_events WHERE request_id=$1 ORDER BY id', [d.id])).rows, events);
  assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1', [d.id])).rows, before);
}));


test('production and legacy transfer readiness still require a valid explicit date and reject without changes', () => isolated(async () => {
  let d = await accept(await respond(await create(), 0, { supplyStatus: 'production', availabilityMode: 'dated', availableDate: '2099-02-01' }));
  for (const supply of ['production', 'vendor_transfer']) {
    await query('UPDATE sales_special_stock_lines SET supply_status=$2 WHERE request_id=$1', [d.id, supply]);
    d = await repo.getSpecialStockCase(d.id);
    const before = (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1', [d.id])).rows;
    for (const eta of [undefined, '2026-02-30', 'not-a-date']) await assert.rejects(readiness(d, { eta }), { code: 'SPECIAL_ETA_REQUIRED' });
    assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1', [d.id])).rows, before);
  }
}));

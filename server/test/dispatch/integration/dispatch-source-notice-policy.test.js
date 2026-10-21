import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { listDispatchOrders, createSalesOrderPoAllocation, upsertLocalCoOrder } from '../../../src/dispatch-repository.js';
import { createOrderDependency, enrichDispatchOrdersWithDependencies } from '../../../src/order-dependency-repository.js';
import { resolveDispatchSalesTarget } from '../../../src/dispatch-order-target-repository.js';
import { upsertSalesOrderLines } from '../../../src/order-sync-repository.js';
import { getDispatchSourceReviewPayload } from '../../../src/dispatch-executed-order-review-repository.js';

let fixture; let counter = 0;
before(async () => { fixture = await createDispatchV2Fixture(); });
after(async () => { await fixture?.close(); });

async function seed({ grouped = false } = {}) {
  const n = ++counter, id = 9979900 + n, ref = `SO-NOTICE-${n}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,sales_order_type,outbound_location_id,outbound_location,netsuite_active,dispatch_address)
    VALUES($1,$2,'B','Sales Order : Pending Fulfillment','Delivery',1,'3445',true,'Recorded address')`, [id, ref]);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,piece_qty,to_pcs,netsuite_backordered_qty,netsuite_active)
    VALUES($1,7,12,'CARGO','CARGO','InvtPart',10,'PC',10,1,10,true)`, [id]);
  const [source] = await listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true });
  const root = grouped ? { ...source, id: `GO-NOTICE-${n}`, childOrders: [ref], childOrderDetails: [source] } : source;
  const plan = await fixture.seedPlan({ date: `2093-10-${String(n + 1).padStart(2, '0')}`, refs: [root.id] });
  const trucks = [{ id: 'notice-truck', plate: 'TEST', loads: [{ id: `notice-load-${n}`, stops: [{ id: `notice-pick-${n}`, type: 'pick', orderId: root.id }] }] }];
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb WHERE plan_id=$1', [plan.id, JSON.stringify([root]), JSON.stringify(trucks)]);
  const jobs = (await query('SELECT * FROM driver_job_records WHERE plan_id=$1', [plan.id])).rows;
  return { id, ref, plan, root, trucks, jobs };
}
async function receipt(f, lines, extra = {}) {
  await query(`INSERT INTO netsuite_order_webhook_inbox(entity_key,record_type,netsuite_order_id,event_type,payload_hash,payload,raw_body,status,received_at,completed_at)
    VALUES($1,'sales_order',$2,'edit',$3,$4::jsonb,'{}','succeeded',now(),now()+interval '1 day')`,
  [`sales_order:${f.id}`, String(f.id), `notice-${f.id}-${++counter}`, JSON.stringify({ id: f.id, lines, ...extra })]);
}
const visible = payload => payload.reviews.filter(review => review.notifyDispatcher);
async function current(f) { return (await listDispatchOrders({ exactOrderRefs: [f.ref], includeHiddenScm: true, includeInactiveSalesOrderLines: false }))[0]; }

test('a planned order with a real NetSuite sync line update keeps its notice and read access remains authenticated', async () => {
  const f = await seed();
  await upsertSalesOrderLines(f.id, [{ line_id: 7, item_id: 12, item_name: 'CARGO', sku: 'CARGO', quantity: 11, unit: 'PC' }]);
  const path = `/api/dispatch/plans/${f.plan.id}/executed-order-reviews`;
  assert.equal((await fixture.request(path, { token: '' })).response.status, 401);
  const result = await fixture.request(path);
  assert.equal(result.response.status, 200);
  const notices = visible(result.payload);
  assert.equal(notices.length, 1);
  assert.ok(notices[0].noticeChanges.some(change => change.field === 'quantity' && change.after === 11));
  assert.deepEqual((await query('SELECT * FROM driver_job_records WHERE plan_id=$1', [f.plan.id])).rows, f.jobs);
});

test('a native edit with no NetSuite evidence produces no visible notice or forced acknowledgement', async () => {
  const f = await seed();
  await query('UPDATE sales_order_lines SET quantity=11 WHERE sales_order_id=$1', [f.id]);
  const payload = await getDispatchSourceReviewPayload(f.plan.id);
  assert.deepEqual(visible(payload), []);
  assert.ok(payload.reviews.every(review => review.notifyDispatcher === false));
  assert.equal(Number((await query('SELECT revision FROM dispatch_plans WHERE id=$1', [f.plan.id])).rows[0].revision), f.plan.revision);
});

test('an unrelated successful receipt cannot turn a dispatcher pickup override into a source notice', async () => {
  const f = await seed();
  await query("UPDATE sales_orders SET dispatch_pickup_address='Dispatcher pickup address' WHERE netsuite_id=$1", [f.id]);
  await receipt(f, f.root.items);
  const payload = await getDispatchSourceReviewPayload(f.plan.id);
  assert.deepEqual(visible(payload), []);
  assert.ok(payload.reviews.every(review => review.notifyDispatcher === false));
});

test('a mixed planned group notice displays only NetSuite cargo and omits the local pickup address change', async () => {
  const f = await seed({ grouped: true });
  await query('UPDATE sales_order_lines SET quantity=11 WHERE sales_order_id=$1', [f.id]);
  await query("UPDATE sales_orders SET dispatch_pickup_address='Dispatcher pickup address' WHERE netsuite_id=$1", [f.id]);
  await receipt(f, (await current(f)).items);
  const payload = await getDispatchSourceReviewPayload(f.plan.id), notices = visible(payload);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].groupRef, f.root.id);
  assert.ok(notices[0].noticeChanges.some(change => change.field === 'quantity'));
  assert.ok(notices[0].noticeChanges.every(change => !['sourceAddress', 'sourceYard', 'pickupLocations'].includes(change.field)));
});

test('unplanning hides a stored pending source notice without deleting or acknowledging its ledger', async () => {
  const f = await seed();
  await upsertSalesOrderLines(f.id, [{ line_id: 7, item_id: 12, item_name: 'CARGO', quantity: 11, unit: 'PC' }]);
  assert.equal(visible(await getDispatchSourceReviewPayload(f.plan.id)).length, 1);
  const ledger = (await query('SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1 ORDER BY token', [f.plan.id])).rows;
  await query("UPDATE dispatch_plan_snapshots SET trucks='[]'::jsonb WHERE plan_id=$1", [f.plan.id]);
  assert.deepEqual(visible(await getDispatchSourceReviewPayload(f.plan.id)), []);
  assert.deepEqual((await query('SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1 ORDER BY token', [f.plan.id])).rows, ledger);
});

test('a stale receipt cannot produce a notice for a different later mirror edit', async () => {
  const f = await seed();
  await receipt(f, f.root.items);
  await query('UPDATE sales_order_lines SET quantity=11 WHERE sales_order_id=$1', [f.id]);
  assert.deepEqual(visible(await getDispatchSourceReviewPayload(f.plan.id)), []);
});

test('a dispatcher PO allocation changes the pickup list without needing source acknowledgement', async () => {
  const f = await seed(), poId = f.id + 100000, poRef = `PO-NOTICE-${f.id}`;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,vendor_id,vendor,status,status_text,source_location_id,source_location,
    destination_location_id,destination_location,dispatch_vendor_yard,receipt_status,netsuite_active)
    VALUES($1,$2,1,'Notice vendor','pendingReceipt','Purchase Order : Pending Receipt',1,'3445',1,'3445','Notice vendor','not_received',true)`, [poId, poRef]);
  const line = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,piece_qty,to_pcs,netsuite_active)
    VALUES($1,8,12,'CARGO','CARGO','InvtPart',10,'PC',10,1,true) RETURNING id`, [poId])).rows[0];
  const target = await resolveDispatchSalesTarget({ dispatchTargetRef: f.ref });
  const allocation = await createSalesOrderPoAllocation({ dispatchTargetRef: f.ref, salesOrderRef: f.ref,
    targetLineKey: target.lines[0].targetLineKey, poLineId: line.id, poRef, quantities: { pieces: 5 } });
  assert.equal(allocation.salesQty, 5);
  const fresh = await current(f);
  assert.notDeepEqual(fresh.pickupLocations, f.root.pickupLocations);
  assert.deepEqual(visible(await getDispatchSourceReviewPayload(f.plan.id)), []);
});

test('a dispatcher TO link and its saved pickup manifest do not need source acknowledgement', async () => {
  const f = await seed(), toId = f.id + 200000, toRef = `TO-NOTICE-${f.id}`;
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,status,status_text,from_location_id,from_location,to_location_id,to_location,
    outbound_operator_status,local_yard_order_status,fulfillment_status,receiving_status,netsuite_active)
    VALUES($1,$2,'B','Transfer Order : Pending Fulfillment',28,'2967',1,'3445','open','Open','not_fulfilled','pending',true)`, [toId, toRef]);
  await query(`INSERT INTO transfer_order_lines(transfer_order_id,line_id,item_id,item_name,sku,item_type,quantity,unit,piece_qty,to_pcs,netsuite_active,line_stage)
    SELECT $1,9,12,'CARGO','CARGO','InvtPart',10,'PC',10,1,true,stage FROM unnest(ARRAY['outbound','receiving']) stage`, [toId]);
  const target = await resolveDispatchSalesTarget({ dispatchTargetRef: f.ref });
  await createOrderDependency({ dispatchTargetRef: f.ref, transferOrderRef: toRef, mode: 'direct_to_customer',
    allocations: [{ targetLineKey: target.lines[0].targetLineKey, quantities: { pieces: 5 } }] });
  const [linked] = await enrichDispatchOrdersWithDependencies([await current(f)]);
  assert.ok(linked.pickupLocations.includes('2967'));
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [f.plan.id, JSON.stringify([linked])]);
  await receipt(f, linked.items);
  assert.deepEqual(visible(await getDispatchSourceReviewPayload(f.plan.id)), []);
});

test('a dispatcher CO creation changes the SO pickup without needing source acknowledgement', async () => {
  const f = await seed();
  const co = await upsertLocalCoOrder({ sourceOrderRef: f.ref, fromYard: '3445', toYard: '150', order: f.root, requestedBy: 'notice-test' });
  assert.ok(co.co_ref);
  assert.equal(co.to_location, '150');
  // Dispatch immediately saves its chosen transit pickup. The pending-load
  // source mirror still has the original yard until the CO progresses.
  const linked = { ...f.root, sourceYard: co.to_location, pickupLocations: [co.to_location],
    transitCo: { id: co.co_ref, fromYard: co.from_location, toYard: co.to_location } };
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [f.plan.id, JSON.stringify([linked])]);
  await receipt(f, f.root.items);
  assert.deepEqual(visible(await getDispatchSourceReviewPayload(f.plan.id)), []);
});

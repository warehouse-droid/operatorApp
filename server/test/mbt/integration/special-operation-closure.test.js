import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { beginRollbackContext, query, closeDb } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { createSpecialClosureService } from '../../../src/special-stock-closure-service.js';
import { prepareSpecialClosurePlan, applySpecialClosurePlan } from '../../../src/special-stock-closure-adapter.js';

after(closeDb);
const context = { operatorId: 'TEST-SO-ONLY-CLOSE', authorizedStoreLocationIds: [1] };
async function fixture(run) {
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES($1,$1,'TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1]) ON CONFLICT DO NOTHING", [context.operatorId]);
    const created = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST', vendorName: 'TEST', fulfillmentMethod: 'yard_pickup', lines: [{ productName: 'TEST', quantity: 5, uom: 'Pcs', rate: 20, requiredDate: '2099-02-01' }] }, context);
    await query("INSERT INTO sales_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(8877791,'TEST-SO-ONLY','Pending Fulfillment',true)");
    await query("INSERT INTO inventory_items(item_id,item_name,raw,synced_at) VALUES(2055,'MBBS-Special Order','{}',now()) ON CONFLICT DO NOTHING");
    await query("INSERT INTO sales_special_stock_order_lines(request_id,case_line_id,order_kind,item_id,description,quantity,uom,unit_rate,remote_line_id) VALUES($1,$2,'sales_order',2055,'TEST',5,'PC',20,791)", [created.id, created.lines[0].id]);
    await query("UPDATE sales_special_stock_cases SET sales_order_netsuite_id=8877791,sales_order_ref='TEST-SO-ONLY',sales_order_approved=true WHERE request_id=$1", [created.id]);
    let closed = false, lost = false, executions = 0; const writes = [], plans = [];
    const boundary = {
      queryAll: async () => [{ uniquekey: 791, rest_line_id: 1, item: 2055, execution_quantity: executions, billed_quantity: 0, line_closed: closed ? 'T' : 'F', status_text: closed ? 'Closed' : 'Pending Fulfillment' }],
      rest: async (path, options = {}) => {
        assert.match(path, /salesOrder\/8877791/);
        if (options.method === 'PATCH') {
          assert.deepEqual(options.body, { item: { items: [{ line: 1, isClosed: true }] } });
          writes.push(path); closed = true;
          if (lost) { lost = false; throw Error('Lost close response'); }
        }
        return { data: { item: { items: [{ line: 1, item: { id: 2055 }, quantity: 5, description: 'TEST', units: '865', rate: 20, isClosed: closed }] } } };
      }
    };
    const service = createSpecialClosureService({readClosedOrders:async()=>null, resolveOrderUnits: async lines => lines.map(line => ({ ...line, unitId: 865 })),
      preparePlan: async input => { plans.push(input); return prepareSpecialClosurePlan(input, boundary); }, applyPlan: plan => applySpecialClosurePlan(plan, boundary) });
    await run({ detail: await repo.getSpecialStockCase(created.id), service, writes, plans, loseResponse: () => { lost = true; }, execute: () => { executions = 1; } });
  }); } finally { await tx.rollback(); }
}
const input = detail => ({ expectedRevision: detail.revision, reason: 'Customer cancelled' });

test('Sales SO-only closure closes and verifies NetSuite before cancelling locally', () => fixture(async ({ detail, service, writes, plans }) => {
  assert.equal(typeof service.requestClosure, 'function', 'Sales closure must call the remote closure service');
  const result = await service.requestClosure(detail.id, input(detail), context);
  assert.equal(result.status, 'cancelled'); assert.equal(result.closeStatus, 'closed');
  assert.equal(result.closureReview.status, 'approved'); assert.equal(result.closureReviewPlan, undefined);
  assert.equal(result.purchaseOrderId, null); assert.equal(result.purchaseOrderStatus, null);
  assert.equal(writes.length, 1); assert.equal(plans[0].orders.length, 1);
  assert.equal((await query('SELECT status_text FROM sales_orders WHERE netsuite_id=8877791')).rows[0].status_text, 'Closed');
  await assert.rejects(service.requestClosure(detail.id, input(result), context), { status: 409 });
  assert.equal(writes.length, 1);
}));

test('legacy SO-only closure resumes; lost response retains the plan and retry does not write twice', () => fixture(async ({ detail, service, writes, plans, loseResponse }) => {
  await query("UPDATE sales_special_stock_cases SET close_status='closure_pending',closure_reason='Customer cancelled',closure_requested_by=$2,closure_requested_at=now() WHERE request_id=$1", [detail.id, context.operatorId]);
  loseResponse();
  await assert.rejects(service.requestClosure(detail.id, input(detail), context), /Lost close response/);
  let pending = await repo.getSpecialStockCase(detail.id);
  assert.equal(pending.closeStatus, 'closure_pending'); assert.equal(pending.closureReview.status, 'attention');
  assert.equal((await query('SELECT status_text FROM sales_orders WHERE netsuite_id=8877791')).rows[0].status_text, 'Pending Fulfillment');
  const reviewId = pending.closureReview.id;
  pending = await service.requestClosure(detail.id, input(pending), context);
  assert.equal(pending.closeStatus, 'closed'); assert.equal(pending.closureReview.id, reviewId);
  assert.equal(writes.length, 1); assert.equal(plans.length, 1);
}));

test('Sales closure with an issued PO only requests SCM approval, including repeated attempts', () => fixture(async ({ detail, service, writes, plans }) => {
  await query("UPDATE sales_special_stock_cases SET purchase_order_netsuite_id=8877792,purchase_order_ref='TEST-PO' WHERE request_id=$1", [detail.id]);
  const pending = await service.requestClosure(detail.id, input(detail), context);
  assert.equal(pending.closeStatus, 'closure_pending'); assert.equal(pending.closureReview.status, 'pending');
  await assert.rejects(repo.claimSpecialClosureReview(detail.id, { expectedRevision: pending.revision, reviewId: pending.closureReview.id }, { ...context, salesClosure: true }), { code: 'SPECIAL_CLOSURE_SCM_REQUIRED' });
  await assert.rejects(service.requestClosure(detail.id, input(pending), context), { status: 409 });
  assert.deepEqual(writes, []); assert.deepEqual(plans, []);
}));

test('SO-only closure retains scope, stale revision and executed-order protection', () => fixture(async ({ detail, service, writes, execute }) => {
  await assert.rejects(service.requestClosure(detail.id, input(detail), { ...context, authorizedStoreLocationIds: [28] }), { status: 403 });
  await assert.rejects(service.requestClosure(detail.id, { ...input(detail), expectedRevision: detail.revision + 1 }, context), { status: 409 });
  execute(); await assert.rejects(service.requestClosure(detail.id, input(detail), context), { status: 409 });
  assert.deepEqual(writes, []); assert.equal((await repo.getSpecialStockCase(detail.id)).status, 'active');
}));

test('an unverified SO never cancels locally', () => fixture(async ({ detail }) => {
  const service = createSpecialClosureService({readClosedOrders:async()=>null, resolveOrderUnits: async lines => lines, preparePlan: async () => ({ version: 1, orders: [] }), applyPlan: async () => ({ verifiedOrderIds: [] }) });
  await assert.rejects(service.requestClosure(detail.id, input(detail), context), { code: 'SPECIAL_CLOSURE_UNVERIFIED' });
  assert.equal((await repo.getSpecialStockCase(detail.id)).closeStatus, 'closure_pending');
  assert.equal((await query('SELECT status_text FROM sales_orders WHERE netsuite_id=8877791')).rows[0].status_text, 'Pending Fulfillment');
}));

test('an SO status update during reviewed closure waits for final remote verification', () => fixture(async ({ detail }) => {
  const pending = await repo.requestSpecialCaseClosure(detail.id, input(detail), context);
  await repo.setSpecialSalesOrderStatus(detail.id, { salesOrderStatus: 'Closed', active: false });
  const updated = await repo.getSpecialStockCase(detail.id);
  assert.equal(updated.closeStatus, 'closure_pending'); assert.equal(updated.status, 'active');
  assert.equal(updated.closureReview.id, pending.closureReview.id);
}));

test('a case without linked orders closes locally without NetSuite work', () => fixture(async ({ detail, service, writes, plans }) => {
  await query('UPDATE sales_special_stock_cases SET sales_order_netsuite_id=NULL,sales_order_ref=NULL WHERE request_id=$1', [detail.id]);
  const result = await service.requestClosure(detail.id, input(detail), context);
  assert.equal(result.closeStatus, 'closed'); assert.equal(result.status, 'cancelled');
  assert.deepEqual(writes, []); assert.deepEqual(plans, []);
}));

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { beginRollbackContext, query, closeDb } from '../../../src/db.js';
import * as repository from '../../../src/special-stock-request-repository.js';
import { getSpecialStockAlertCounts, getSpecialSalesAlertCounts } from '../../../src/special-stock-alerts.js';

const users = {}, requests = [];
let server, base, originalFlag;
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
const sqlStage = async id => (await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1', [id])).rows[0].stage;

async function call(role, path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + users[role].token, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

async function fixture(statuses = ['in_stock', 'in_stock', 'vendor_transfer', 'vendor_transfer', 'vendor_transfer']) {
  let detail = await repository.createSpecialStockCase({
    storeLocationId: 1, inquiryDate: '2099-01-01', customerName: 'TEST Customer Confirmation',
    vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: statuses.map((_, index) => ({ productName: 'TEST Material ' + index, quantity: 1, uom: 'PCS', rate: 25, requiredDate: '2099-02-01' }))
  }, context());
  requests.push(detail.id);
  detail = await repository.saveSpecialStockChecks(detail.id, {
    expectedRevision: detail.revision,
    lines: detail.lines.map((line, index) => ({
      lineId: line.id, kind: 'response', supplyStatus: statuses[index],
      availabilityMode: 'dated', availableDate: '2099-02-01',
      vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'TEST Yard'
    }))
  }, { operatorId: users.scm.id });
  return detail;
}

const decide = (detail, decisions) => call('sales', `/api/sales/special-stock-requests/${detail.id}/customer-decisions`, {
  expectedRevision: detail.revision,
  lines: decisions.map((decision, index) => ({ lineId: detail.lines[index].id, decision,
    ...(decision === 'accepted' ? { customerNote: 'Customer accepts stock or ETA' } : { reason: 'Customer requested an update or rejected this line' }) }))
});

async function linkedFixture(method = 'yard_pickup') {
  const detail = await decide(await fixture(['in_stock']), ['accepted']);
  const so = 9_600_000 + detail.id * 2, po = so + 1;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,fulfillment_status,netsuite_active)
    VALUES($1,$2,'B','Sales Order : Pending Fulfillment','not_fulfilled',true)`, [so, 'TEST-SO-' + detail.id]);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,receipt_status,netsuite_active)
    VALUES($1,$2,$3,'B','Purchase Order : Pending Receipt','not_received',true)`, [po, 'TEST-PO-' + detail.id, 'TEST-PO-ALIAS-' + detail.id]);
  await query(`UPDATE sales_special_stock_cases SET fulfillment_method=$2,delivery_address='TEST Delivery address',sales_order_netsuite_id=$3,sales_order_ref=$4,
    purchase_order_netsuite_id=$5,purchase_order_ref=$6 WHERE request_id=$1`,
  [detail.id, method, so, 'TEST-SO-' + detail.id, po, 'TEST-PO-' + detail.id]);
  return repository.getSpecialStockCase(detail.id);
}

async function delivered(kind, reference) {
  await query(`SELECT dispatch_record_order_completion($1,$2,'2099-02-02T12:00:00Z','reconciliation',$3)`,
    [kind, reference, 'TEST-completion-' + crypto.randomUUID()]);
}

async function assertProjections(detail, stage) {
  assert.equal(detail.stage, stage);
  assert.equal(await sqlStage(detail.id), stage);
  for (const audience of ['sales', 'scm']) {
    const loaded = await call(audience, `/api/${audience}/special-stock-requests/${detail.id}`);
    assert.equal(loaded.stage, stage);
    const list = await call(audience, `/api/${audience}/special-stock-requests?stages=${stage}&search=${detail.requestRef}`);
    assert.ok(list.requests.some(row => row.id === detail.id && row.stage === stage));
    if (stage === 'confirmed') {
      const waiting = await call(audience, `/api/${audience}/special-stock-requests?stages=wait_for_production&search=${detail.requestRef}`);
      assert.ok(waiting.requests.every(row => row.id !== detail.id));
    }
  }
}

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
  originalFlag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  for (const role of ['sales', 'scm']) {
    const username = 'special-confirmation-' + role + '-' + crypto.randomUUID(), password = crypto.randomUUID();
    users[role] = await createOperator({ username, password, displayName: 'TEST ' + role, role, roles: [role], yardLocationIds: [1] });
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 200);
    users[role].token = (await login.json()).token;
  }
});

after(async () => {
  try {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [requests]);
    for (const user of Object.values(users)) {
      await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1', [user.id]);
      await query('DELETE FROM operators WHERE id=$1', [user.id]);
    }
    if (originalFlag !== undefined) { await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [originalFlag]); }
  } finally { await closeDb(); }
});

test('five lines: one rejected, one in-stock accepted and three accepted transfer ETAs await the SO everywhere', async () => {
  const scmBefore = await getSpecialStockAlertCounts(), salesBefore = await getSpecialSalesAlertCounts(context());
  let detail = await fixture();
  detail = await decide(detail, ['declined', 'accepted', 'accepted', 'accepted']);
  await assertProjections(detail, 'await_customer_confirmation');
  assert.equal((await getSpecialSalesAlertCounts(context())).awaitCustomerConfirmation, salesBefore.awaitCustomerConfirmation + 1);
  detail = await call('sales', `/api/sales/special-stock-requests/${detail.id}/customer-decisions`, {
    expectedRevision: detail.revision, lines: [{ lineId: detail.lines[4].id, decision: 'accepted', customerNote: 'ETA accepted' }]
  });
  await assertProjections(detail, 'await_customer_confirmation');
  assert.equal(detail.salesOrderId, null);
  assert.equal(detail.purchaseOrderId, null);
  assert.deepEqual(detail.lines.map(line => line.salesDecision), ['declined', 'accepted', 'accepted', 'accepted', 'accepted']);
  assert.deepEqual(detail.lines.map(line => line.supplyStatus), ['in_stock', 'in_stock', 'vendor_transfer', 'vendor_transfer', 'vendor_transfer']);
  assert.ok(detail.lines.slice(2).every(line => line.availableDate === '2099-02-01'));
  assert.equal((await getSpecialStockAlertCounts()).confirmedOrders, scmBefore.confirmedOrders);
  assert.deepEqual(await getSpecialSalesAlertCounts(context()), {...salesBefore,awaitCustomerConfirmation:salesBefore.awaitCustomerConfirmation+1});
});

test('resolved accepted and rejected materials still await the SO, including a production ETA', async () => {
  for (const status of ['in_stock', 'low_inventory', 'vendor_transfer', 'production']) {
    const detail = await decide(await fixture([status, 'in_stock', 'vendor_transfer', 'production', 'in_stock']), ['accepted', 'declined', 'declined', 'declined', 'declined']);
    await assertProjections(detail, 'await_customer_confirmation');
    assert.equal(detail.lines[0].supplyStatus, status);
  }
});

test('all accepted transfer and production ETAs still await the SO', async () => {
  const detail = await decide(await fixture(['vendor_transfer', 'production']), ['accepted', 'accepted']);
  await assertProjections(detail, 'await_customer_confirmation');
});

test('pending decisions, requested updates, unanswered stock checks and all rejected lines do not confirm', async () => {
  let detail = await fixture(['in_stock', 'production']);
  detail = await decide(detail, ['accepted']);
  await assertProjections(detail, 'await_customer_confirmation');
  detail = await decide(detail, ['accepted', 'request_update']);
  await assertProjections(detail, 'new_enquiry');
  await query("UPDATE sales_special_stock_lines SET supply_status=NULL,sales_decision='pending' WHERE id=$1", [detail.lines[1].id]);
  await assertProjections(await repository.getSpecialStockCase(detail.id), 'new_enquiry');
  detail = await decide(await fixture(['in_stock', 'production']), ['declined', 'declined']);
  await assertProjections(detail, 'await_customer_confirmation');
});

test('legacy saved edit stages cannot hide awaiting SO after customer decisions', async () => {
  let detail = await decide(await fixture(['in_stock', 'production']), ['accepted', 'accepted']);
  for (const stage of ['new_enquiry', 'await_customer_confirmation', 'wait_for_production']) {
    await query('UPDATE sales_special_stock_cases SET line_edit_state=$2::jsonb WHERE request_id=$1', [detail.id, JSON.stringify({ revision: detail.revision, stage })]);
    detail = await repository.getSpecialStockCase(detail.id);
    await assertProjections(detail, 'await_customer_confirmation');
  }
});

test('migration reclassifies existing accepted requests without changing business rows', async () => {
  const detail = await decide(await fixture(['vendor_transfer', 'production']), ['accepted', 'accepted']);
  const snapshot = async () => (await query(`SELECT to_jsonb(request) AS request,to_jsonb(special) AS special,
    (SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) FROM sales_special_stock_lines line WHERE line.request_id=request.id) AS lines
    FROM sales_stock_requests request JOIN sales_special_stock_cases special ON special.request_id=request.id WHERE request.id=$1`, [detail.id])).rows[0];
  const transaction = await beginRollbackContext();
  try {
    await transaction.run(async () => {
      await query(readFileSync(new URL('../../../migrations/276_special_stock_check_revisions.sql', import.meta.url), 'utf8'));
      assert.equal(await sqlStage(detail.id), 'wait_for_production');
      const beforeRows = await snapshot();
      await query(readFileSync(new URL('../../../migrations/289_special_po_dispatch_stage.sql', import.meta.url), 'utf8'));
      assert.equal(await sqlStage(detail.id), 'confirmed');
      assert.deepEqual(await snapshot(), beforeRows);
    });
  } finally { await transaction.rollback(); }
});

test('SPREQ-000041 yard-pickup evidence: locally received PO plus NetSuite Pending Billing SO is Completed', async () => {
  let detail = await linkedFixture();
  await query("UPDATE sales_orders SET status='F',status_text='Sales Order : Pending Billing' WHERE netsuite_id=$1", [detail.salesOrderId]);
  await query("UPDATE purchase_orders SET receipt_status='received',received_at='2099-02-02T10:00:00Z' WHERE netsuite_id=$1", [detail.purchaseOrderId]);
  detail = await repository.getSpecialStockCase(detail.id);
  await assertProjections(detail, 'completed');
  assert.equal(detail.operationallyComplete, true);
  assert.equal(detail.operationalCompletionSource, 'linked_order_completion');
  assert.equal(detail.operationallyCompletedAt, null);
  assert.equal(detail.salesOrderFulfillmentStatus, 'not_fulfilled');
});

test('all 48 local and NetSuite evidence combinations obey the three delivery-method completion rules', async () => {
  for (const method of ['mbt_delivery', 'yard_pickup', 'vendor_pickup']) {
    const initial = await linkedFixture(method);
    for (let flags = 0; flags < 16; flags += 1) {
      const netsuiteSo = Boolean(flags & 1), netsuitePo = Boolean(flags & 2);
      const localSo = Boolean(flags & 4), localPo = Boolean(flags & 8);
      const expected = method === 'mbt_delivery' ? localSo && localPo
        : method === 'yard_pickup' ? localPo && (localSo || netsuiteSo) : netsuiteSo && netsuitePo;
      const transaction = await beginRollbackContext();
      try {
        await transaction.run(async () => {
          await query(`UPDATE sales_orders SET status_text=$2,fulfillment_status=$3 WHERE netsuite_id=$1`,
            [initial.salesOrderId, netsuiteSo ? 'Sales Order : Pending Billing' : 'Sales Order : Pending Fulfillment', localSo ? 'fulfilled' : 'not_fulfilled']);
          await query(`UPDATE purchase_orders SET status_text=$2,receipt_status=$3 WHERE netsuite_id=$1`,
            [initial.purchaseOrderId, netsuitePo ? 'Purchase Order : Pending Bill' : 'Purchase Order : Pending Receipt', localPo ? 'received' : 'not_received']);
          if (method === 'mbt_delivery' && localSo) { await delivered('SO', initial.salesOrderRef); }
          if (method === 'mbt_delivery' && localPo) { await delivered('PO', 'TEST-PO-ALIAS-' + initial.id); }
          const detail = await repository.getSpecialStockCase(initial.id);
          assert.equal(detail.operationallyComplete, expected, method + ':' + flags);
          assert.equal(detail.stage === 'completed', expected, method + ':' + flags);
          assert.equal(await sqlStage(initial.id), detail.stage);
        });
      } finally { await transaction.rollback(); }
    }
  }
});

test('delivery completion uses both current local order records and survives renamed PO references', async () => {
  let detail = await linkedFixture('mbt_delivery');
  await delivered('SO', detail.salesOrderRef);
  detail = await repository.getSpecialStockCase(detail.id);
  assert.equal(detail.operationallyComplete, false);
  await delivered('PO', 'TEST-PO-ALIAS-' + detail.id);
  detail = await repository.getSpecialStockCase(detail.id);
  await assertProjections(detail, 'completed');
  assert.equal(new Date(detail.operationallyCompletedAt).toISOString(), '2099-02-02T12:00:00.000Z');
  assert.equal(detail.operationalCompletionSource, 'dispatch_completion');
});

test('yard pickup also accepts full local customer collection with a local PO arrival', async () => {
  let detail = await linkedFixture();
  await query("INSERT INTO operator_load_records(load_type,order_family,order_id,response) VALUES('customer_pickup_load','SO',$1,'{\"pickupStatus\":\"loaded\"}')", [detail.salesOrderId]);
  assert.notEqual((await repository.getSpecialStockCase(detail.id)).stage, 'completed');
  await query("UPDATE purchase_orders SET receipt_status='received',received_at=now() WHERE netsuite_id=$1", [detail.purchaseOrderId]);
  detail = await repository.getSpecialStockCase(detail.id);
  await assertProjections(detail, 'completed');
  assert.equal(detail.operationalCompletionSource, 'yard_pickup');
});

test('vendor pickup requires NetSuite receipt and fulfillment, excluding partial or cancelled native orders', async () => {
  let detail = await linkedFixture('vendor_pickup');
  await query("UPDATE sales_orders SET status_text='Sales Order : Pending Billing' WHERE netsuite_id=$1", [detail.salesOrderId]);
  await query("UPDATE purchase_orders SET status_text='Purchase Order : Pending Bill' WHERE netsuite_id=$1", [detail.purchaseOrderId]);
  detail = await repository.getSpecialStockCase(detail.id);
  await assertProjections(detail, 'completed');
  assert.equal(detail.operationalCompletionSource, 'netsuite_order_completion');
  for (const status of ['Purchase Order : Pending Billing/Partially Received', 'Closed', 'Cancelled', 'Pending Receipt']) {
    await query('UPDATE purchase_orders SET status_text=$2 WHERE netsuite_id=$1', [detail.purchaseOrderId, status]);
    assert.notEqual((await repository.getSpecialStockCase(detail.id)).stage, 'completed');
    assert.notEqual(await sqlStage(detail.id), 'completed');
  }
});

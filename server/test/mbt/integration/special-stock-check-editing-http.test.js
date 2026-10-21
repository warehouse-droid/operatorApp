import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { query, closeDb, beginRollbackContext } from '../../../src/db.js';
import * as repo from '../../../src/special-stock-request-repository.js';
import { getSpecialSalesAlertCounts } from '../../../src/special-stock-alerts.js';

const users = {}, ids = [];
let server, base, flag;
const context = () => ({ operatorId: users.sales.id, authorizedStoreLocationIds: [1] });
const response = line => ({ lineId: line.id, kind: 'response', supplyStatus: 'in_stock',
  availabilityMode: 'no_projection', vendorId: 331, vendorName: 'TEST Vendor', vendorYard: 'TEST Yard' });
async function call(detail, lines, role = 'scm', revision = detail.revision) {
  const result = await fetch(`${base}/api/scm/special-stock-requests/${detail.id}/stock-check`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(users[role]?.token ? { authorization: 'Bearer ' + users[role].token } : {}) },
    body: JSON.stringify({ expectedRevision: revision, lines })
  });
  return { status: result.status, body: await result.json() };
}
async function fixture(count = 3) {
  const detail = await repo.createSpecialStockCase({ storeLocationId: 1, inquiryDate: '2099-01-01',
    customerName: 'TEST Stock Check', vendorId: 331, vendorName: 'TEST Vendor', fulfillmentMethod: 'yard_pickup',
    lines: Array.from({ length: count }, (_, index) => ({ productName: index === count - 1 ? 'Split PALLET FEE for BLU 600MM HD2' : 'TEST Slab ' + index,
      quantity: 1, uom: 'PCS', rate: 25, requiredDate: '2099-02-01' })) }, context());
  ids.push(detail.id);
  const last = detail.lines.at(-1);
  await query(`UPDATE sales_special_stock_lines SET sales_decision='declined',sales_decision_reason='Original decline',
    sales_customer_note='Old decision',decided_by=$3,decided_at=now(),decision_revision=1,
    decline_restore='{"decision":"pending","responseRevision":0}' WHERE request_id=$1 AND id=$2`,
  [detail.id, last.id, users.sales.id]);
  return repo.getSpecialStockCase(detail.id, { audience: 'scm' });
}
const snapshot = async id => ({
  lines: (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id', [id])).rows,
  events: (await query('SELECT * FROM sales_special_stock_events WHERE request_id=$1 ORDER BY id', [id])).rows,
  request: (await query('SELECT revision,updated_at FROM sales_stock_requests WHERE id=$1', [id])).rows[0]
});
const sqlStage = async id => (await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1', [id])).rows[0].stage;
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'mbbs-special-review-db');
  flag = (await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  for (const role of ['sales', 'scm']) {
    const username = 'stock-check-' + role + '-' + crypto.randomUUID(), password = crypto.randomUUID();
    users[role] = await createOperator({ username, password, displayName: 'TEST ' + role, role, roles: [role], yardLocationIds: [1] });
    const result = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(result.status, 200);
    users[role].token = (await result.json()).token;
  }
});
after(async () => {
  try {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])', [ids]);
    for (const user of Object.values(users)) {
      await query('DELETE FROM delivery_audit_log WHERE actor_operator_id=$1', [user.id]);
      await query('DELETE FROM operators WHERE id=$1', [user.id]);
    }
    if (flag !== undefined) { await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'", [flag]); }
  } finally { await closeDb(); }
});

test('replied active lines plus an unanswered declined pallet fee await customer confirmation in API, SQL, filters and alerts', async () => {
  const initial = await fixture(11), initialAlerts = await getSpecialSalesAlertCounts(context());
  const saved = await call(initial, initial.lines.slice(0, -1).map(response));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.stage, 'await_customer_confirmation');
  assert.equal(saved.body.lines.at(-1).salesDecision, 'declined');
  assert.equal(saved.body.lines.at(-1).supplyStatus, null);
  assert.equal(await sqlStage(initial.id), 'await_customer_confirmation');
  assert.ok((await repo.listSpecialStockCases({ stages: ['await_customer_confirmation'], audience: 'scm', limit: 150 })).some(detail => detail.id === initial.id));
  assert.equal((await getSpecialSalesAlertCounts(context())).awaitCustomerConfirmation, initialAlerts.awaitCustomerConfirmation + 1);
});

test('SCM revised decline becomes pending, clears decline metadata, preserves other lines and records actor and previous reason', async () => {
  const initial = await fixture(), before = await snapshot(initial.id), target = initial.lines.at(-1);
  const result = await call(initial, [{ ...response(target), supplyStatus: 'vendor_transfer', availabilityMode: 'dated', availableDate: '2099-02-02', salesVisibleNote: 'Revised transfer reply' }]);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const saved = result.body.lines.at(-1), current = await snapshot(initial.id);
  assert.equal(saved.salesDecision, 'pending');
  assert.equal(saved.supplyStatus, 'vendor_transfer');
  assert.equal(saved.salesDecisionReason, '');
  assert.equal(saved.salesCustomerNote, '');
  assert.deepEqual(saved.declineRestore, {});
  assert.equal(current.lines.at(-1).decided_by, null);
  assert.equal(current.lines.at(-1).decided_at, null);
  assert.equal(saved.decisionRevision, target.decisionRevision + 1);
  assert.equal(saved.responseRevision, target.responseRevision + 1);
  assert.equal(result.body.revision, initial.revision + 1);
  assert.deepEqual(current.lines.slice(0, -1), before.lines.slice(0, -1));
  const audit = result.body.events.find(event => event.eventType === 'special_declined_line_reopened');
  assert.ok(audit);
  assert.equal(audit.actorId, users.scm.id);
  assert.equal(audit.lineId, target.id);
  assert.equal(audit.details.previousReason, 'Original decline');
});

test('Sales and unauthenticated callers cannot revise a declined stock check', async () => {
  const detail = await fixture(), before = await snapshot(detail.id);
  for (const [role, status] of [['sales', 403], ['anonymous', 401]]) {
    assert.equal((await call(detail, [response(detail.lines.at(-1))], role)).status, status);
    assert.deepEqual(await snapshot(detail.id), before);
  }
});

test('closed lines cannot be reopened by a crafted SCM response', async () => {
  const detail = await fixture();
  await query("UPDATE sales_special_stock_lines SET sales_decision='closed' WHERE id=$1", [detail.lines.at(-1).id]);
  const before = await snapshot(detail.id), result = await call(detail, [response(detail.lines.at(-1))]);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SPECIAL_RESPONSE_LINE_CLOSED');
  assert.deepEqual(await snapshot(detail.id), before);
});

test('closed, pending-information, linked/skipped-order and busy cases cannot reopen a decline', async () => {
  for (const assignment of ["close_status='closed'", "information_request='{" + '"status":"pending"' + "}'", "sales_order_netsuite_id=99887766,sales_order_ref='TEST-SO'",
    "purchase_order_netsuite_id=99887767,purchase_order_ref='TEST-PO'", 'sales_order_skipped=true', 'sales_order_skipped=true,purchase_order_skipped=true',
    "sales_order_operation_status='creating'", "purchase_order_operation_status='attention'"]) {
    const detail = await fixture();
    await query('UPDATE sales_special_stock_cases SET ' + assignment + ' WHERE request_id=$1', [detail.id]);
    const before = await snapshot(detail.id), result = await call(detail, [response(detail.lines.at(-1))]);
    assert.equal(result.status, 409, assignment + ': ' + JSON.stringify(result.body));
    assert.deepEqual(await snapshot(detail.id), before);
  }
});

test('invalid batch after a declined-line revision rolls back the reopened decision, stock and audit', async () => {
  const detail = await fixture(), before = await snapshot(detail.id);
  const result = await call(detail, [response(detail.lines.at(-1)), { ...response(detail.lines[0]), supplyStatus: 'production', availabilityMode: 'dated' }]);
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'SPECIAL_RESPONSE_DATE_REQUIRED');
  assert.deepEqual(await snapshot(detail.id), before);
});

test('concurrent SCM revisions of a decline allow exactly one save and one reopen event', async () => {
  const detail = await fixture(), target = detail.lines.at(-1);
  const replies = await Promise.all([call(detail, [{ ...response(target), salesVisibleNote: 'First' }]), call(detail, [{ ...response(target), salesVisibleNote: 'Second' }])]);
  assert.deepEqual(replies.map(result => result.status).sort(), [200, 409]);
  assert.equal(replies.find(result => result.status === 409).body.code, 'SPECIAL_REVISION_CONFLICT');
  const saved = await repo.getSpecialStockCase(detail.id, { audience: 'scm' });
  assert.equal(saved.revision, detail.revision + 1);
  assert.equal(saved.lines.at(-1).salesDecision, 'pending');
  assert.equal(saved.events.filter(event => event.eventType === 'special_declined_line_reopened').length, 1);
});

test('property: JavaScript and SQL stages agree when declined/closed lines are unanswered but open lines need a reply', async () => {
  const transaction = await beginRollbackContext();
  try {
    await transaction.run(async () => {
      const detail = await fixture(4);
      await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('pending', 'request_update', 'declined', 'closed'), { minLength: 4, maxLength: 4 }),
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), async (decisions, replied) => {
          for (const [index, line] of detail.lines.entries()) {
            await query('UPDATE sales_special_stock_lines SET sales_decision=$2,supply_status=$3 WHERE id=$1', [line.id, decisions[index], replied[index] ? 'in_stock' : null]);
          }
          const expected = decisions.some((decision, index) => !['declined', 'closed'].includes(decision) && (!replied[index] || decision === 'request_update'))
            ? 'new_enquiry' : 'await_customer_confirmation';
          assert.equal((await repo.getSpecialStockCase(detail.id)).stage, expected);
          assert.equal(await sqlStage(detail.id), expected);
        }), { seed: 20261009, numRuns: 50 });
    });
  } finally { await transaction.rollback(); }
});

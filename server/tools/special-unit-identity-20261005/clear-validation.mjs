import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { resolveSpecialOrderUnitsFromNetSuite } from './src/netsuite.js';

const apply = process.argv.includes('--apply');
const requestId = 109;
const operationId = '103a0b2b-5883-41b1-b7cf-0a5ca9bdd859';
const message = 'A valid NetSuite identity is required.';
const changedFields = new Set(['purchase_order_operation_status', 'purchase_order_operation_error',
  'attention', 'attention_reason', 'updated_at']);
const retained = row => Object.fromEntries(Object.entries(row).filter(([key]) => !changedFields.has(key)));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
  const [unit] = await resolveSpecialOrderUnitsFromNetSuite([{ itemId: 2055, uom: 'SQFT', quantity: 120 }]);
  assert.equal(unit.unitId, 866, 'Live unit lookup must be repaired before clearing the failure');
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='15s'");
    const requests = (await query('SELECT * FROM sales_stock_requests WHERE id=$1 FOR UPDATE', [requestId])).rows;
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.request_ref, 'SPREQ-000032');
    assert.equal(request.revision, 23);
    assert.equal(request.status, 'active');
    const before = (await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1 FOR UPDATE', [requestId])).rows[0];
    assert.equal(before.purchase_order_operation_status, 'attention');
    assert.equal(before.purchase_order_operation_id, operationId);
    assert.equal(before.purchase_order_operation_error, message);
    assert.equal(before.attention_reason, message);
    assert.equal(before.attention, true);
    assert.equal(before.purchase_order_submission_started_at, null);
    assert.equal(before.purchase_order_netsuite_id, null);
    assert.equal(before.sales_order_operation_status, 'linked');
    assert.equal(before.sales_order_approved, true);
    assert.equal(before.close_status, 'active');
    assert.equal(Number(before.sales_order_netsuite_id), 1036614);
    assert.equal(before.sales_order_ref, 'SOB121972');
    assert.ok(!['pending', 'applying', 'attention'].includes(before.quantity_review?.status));
    assert.ok(!['applying', 'attention'].includes(before.fulfillment_change?.status));
    const lines = (await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id', [requestId])).rows;
    const auditBefore = (await query('SELECT count(*)::int AS count FROM sales_special_stock_events WHERE request_id=$1', [requestId])).rows[0].count;
    assert.equal((await query(`UPDATE sales_special_stock_cases
      SET purchase_order_operation_status='idle',purchase_order_operation_error=NULL,
        attention=false,attention_reason=NULL,updated_at=now()
      WHERE request_id=$1 AND purchase_order_operation_id=$2
        AND purchase_order_operation_status='attention' AND purchase_order_operation_error=$3
        AND purchase_order_submission_started_at IS NULL AND purchase_order_netsuite_id IS NULL`,
    [requestId, operationId, message])).rowCount, 1);
    assert.equal((await query('UPDATE sales_stock_requests SET revision=revision+1,updated_at=now() WHERE id=$1 AND revision=23', [requestId])).rowCount, 1);
    await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
      VALUES($1,'special_purchase_order_validation_repaired',NULL,'scm',$2::jsonb)`, [requestId, JSON.stringify({
      operationId, beforeStatus: 'attention', afterStatus: 'idle', clearedError: message,
      reason: 'Native SQFT unit lookup repaired; user will manually link existing POB03988.',
      manualLinkByUser: true, netSuiteWrites: 0, purchaseOrderLinked: false
    })]);
    const after = (await query('SELECT * FROM sales_special_stock_cases WHERE request_id=$1', [requestId])).rows[0];
    assert.deepEqual(retained(after), retained(before));
    assert.deepEqual((await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id', [requestId])).rows, lines);
    const updatedRequest = (await query('SELECT * FROM sales_stock_requests WHERE id=$1', [requestId])).rows[0];
    assert.deepEqual(updatedRequest, { ...request, revision: 24, updated_at: updatedRequest.updated_at });
    assert.equal(after.purchase_order_operation_status, 'idle');
    assert.equal(after.purchase_order_operation_error, null);
    assert.equal(after.attention, false);
    assert.equal(after.attention_reason, null);
    assert.equal((await query('SELECT count(*)::int AS count FROM sales_special_stock_events WHERE request_id=$1', [requestId])).rows[0].count, auditBefore + 1);
    return { apply, requestRef: 'SPREQ-000032', revision: 24, operationStatus: 'idle', staleErrorCleared: true,
      businessFieldsUnchanged: true, orderLinesUnchanged: true, businessFieldsHash: sha(retained(before)),
      manualLinkByUser: true, purchaseOrderLinked: false, netSuiteWrites: 0 };
  }, { rollback: !apply });
  const actual = (await query('SELECT revision FROM sales_stock_requests WHERE id=$1', [requestId])).rows[0];
  assert.equal(actual.revision, apply ? 24 : 23);
  console.log(JSON.stringify({ ...result, committed: apply, rollbackVerified: !apply }));
} finally { await closeDb(); }

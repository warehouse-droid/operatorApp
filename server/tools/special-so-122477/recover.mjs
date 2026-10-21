import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { createSpecialStockRequestService } from './src/special-stock-request-service.js';
import { findSpecialStockOrdersByMarkerFromNetSuite, fetchSalesOrderReferenceFromNetSuite } from './src/netsuite.js';

const mode = process.env.SO122477_RECOVERY_MODE;
assert.ok(['preflight', 'recover', 'verify'].includes(mode));
const requestId = 162, remoteId = 1052318;
const operationId = 'b505a587-f2ff-4b4d-984a-d2f7ce77843e';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let netSuiteWriteAttempts = 0;
const prohibited = async () => { netSuiteWriteAttempts++; assert.fail('Existing SO recovery must never submit, transform, update, or validate NetSuite content'); };
async function state() {
  const saved = (await query(`SELECT jsonb_build_object('request',to_jsonb(r),'case',to_jsonb(c),
    'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=r.id),
    'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=r.id),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM sales_special_stock_events e WHERE request_id=r.id)) AS data
    FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=$1`, [requestId])).rows[0].data;
  assert.equal(saved.request.request_ref, 'SPREQ-000063');
  return saved;
}
try {
  // Confirmation uses the unique request marker and existing SO number only.
  const rows = await findSpecialStockOrdersByMarkerFromNetSuite({ caseId: requestId, orderKind: 'sales_order', entityId: null });
  assert.equal(rows.length, 1, 'Expected one existing request-marked SO; never create a replacement');
  assert.equal(Number(rows[0].id), remoteId);
  const reference = await fetchSalesOrderReferenceFromNetSuite(remoteId);
  assert.equal(Number(reference.id), remoteId);
  assert.equal(reference.tranid, 'SOB122477');
  const before = await withTransaction(async () => { await query('SET TRANSACTION READ ONLY'); return state(); });
  assert.equal(before.case.sales_order_operation_id, operationId);
  assert.ok(before.case.sales_order_submission_started_at);
  if (mode === 'verify') {
    assert.equal(Number(before.case.sales_order_netsuite_id), remoteId);
    assert.equal(before.case.sales_order_ref, 'SOB122477');
    assert.equal(before.case.sales_order_operation_status, 'linked');
    assert.equal(before.case.attention, false);
    assert.equal(before.case.sales_order_operation_error, null);
    console.log(JSON.stringify({ kind: 'special-so-122477-verified', at: new Date().toISOString(), reference, state: before,
      summary: { verified: true, requestRef: 'SPREQ-000063', salesOrderRef: 'SOB122477', salesOrderId: remoteId,
        operationStatus: 'linked', attention: false, creationConfirmed: true, contentVerification: false, netSuiteWrites: 0, applicationWrites: 0 } }));
  } else {
    assert.equal(before.case.sales_order_netsuite_id, null);
    assert.equal(before.case.sales_order_operation_status, 'attention');
    assert.equal(before.case.purchase_order_netsuite_id, null);
    assert.equal(before.case.close_status, 'active');
    if (mode === 'preflight') {
      console.log(JSON.stringify({ kind: 'special-so-122477-preflight', at: new Date().toISOString(), reference, before,
        summary: { ready: true, requestRef: 'SPREQ-000063', revision: before.request.revision, salesOrderRef: 'SOB122477',
          salesOrderId: remoteId, contentVerification: false, netSuiteWrites: 0, applicationWrites: 0 } }));
    } else {
      const result = await withTransaction(async () => {
        await query("SET LOCAL lock_timeout='5s'");
        const locked = await query(`SELECT r.id FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
          WHERE r.id=$1 AND r.revision=$2 AND c.sales_order_operation_status='attention'
            AND c.sales_order_operation_id=$3 AND c.sales_order_netsuite_id IS NULL FOR UPDATE OF r,c`,
          [requestId, before.request.revision, operationId]);
        assert.equal(locked.rowCount, 1, 'The request or its operation ownership changed');
        const service = createSpecialStockRequestService({
          findMarkerOrders: async input => { assert.equal(input.caseId, requestId); assert.equal(input.entityId, null); return rows; },
          fetchSalesOrderReference: async id => { assert.equal(id, remoteId); return reference; },
          createSalesOrder: prohibited, createDiscountSalesOrder: prohibited, transformEstimate: prohibited,
          markSubmitted: prohibited, resolveLocations: prohibited, resolveOrderUnits: prohibited,
          verifyDiscountSalesOrder: prohibited, selectSalesRep: prohibited,
          sleep: async () => assert.fail('The confirmed SO should not need retry polling')
        });
        const linked = await service.createSalesOrder(requestId, { expectedRevision: Number(before.request.revision), operationId,
          source: 'standalone' }, { authorizedStoreLocationIds: [1] });
        assert.equal(linked.salesOrderId, remoteId);
        assert.equal(linked.salesOrderRef, 'SOB122477');
        assert.equal(linked.salesOrderOperationStatus, 'linked');
        assert.equal(linked.attention, false);
        const after = await state();
        assert.equal(digest(after.caseLines), digest(before.caseLines), 'Historical product rows changed');
        assert.equal(digest(after.orderLines), digest(before.orderLines), 'Historical order draft changed');
        assert.equal(after.case.sales_order_submission_started_at, before.case.sales_order_submission_started_at);
        assert.equal(after.case.purchase_order_netsuite_id, null);
        assert.equal(netSuiteWriteAttempts, 0);
        await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
          VALUES($1,'special_sales_order_existing_identity_recovery',NULL,'all',$2::jsonb)`, [requestId, JSON.stringify({
          salesOrderId: remoteId, salesOrderRef: reference.tranid, operationId, creationConfirmed: true,
          contentVerification: false, historicalDraftPreserved: true, netSuiteWrites: 0,
          userInstruction: 'Once the SO is generated, confirm its sales order number and successful creation; do not check content.'
        })]);
        return { linked, after: await state() };
      });
      console.log(JSON.stringify({ kind: 'special-so-122477-recovered', at: new Date().toISOString(), before, reference, ...result,
        summary: { recovered: true, requestRef: 'SPREQ-000063', revision: result.linked.revision,
          salesOrderRef: result.linked.salesOrderRef, salesOrderId: result.linked.salesOrderId,
          operationStatus: result.linked.salesOrderOperationStatus, attention: result.linked.attention,
          contentVerification: false, netSuiteWrites: 0, historicalDraftPreserved: true, originalSubmissionPreserved: true } }));
    }
  }
} finally { await closeDb(); }

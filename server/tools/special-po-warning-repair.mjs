// Run inside the deployed app with: docker exec -i ... node --input-type=module < this-file
import assert from 'node:assert/strict';
import { closeDb, query, withTransaction } from './src/db.js';
import { getSpecialStockCase, reconcileSpecialOrderWebhook } from './src/special-stock-request-repository.js';
import { assertSpecialPurchaseRelease } from './src/special-stock-request-domain.js';
import { assertSpecialStockRemoteOrderAllowed } from './src/special-stock-request-policy.js';

function summary(detail) {
  return { id: detail.id, requestRef: detail.requestRef, revision: detail.revision,
    salesOrderId: detail.salesOrderId, salesOrderRef: detail.salesOrderRef,
    salesOrderOperationStatus: detail.salesOrderOperationStatus, salesOrderApproved: detail.salesOrderApproved,
    purchaseOrderId: detail.purchaseOrderId, purchaseOrderOperationStatus: detail.purchaseOrderOperationStatus,
    purchaseOrderSubmissionStartedAt: detail.purchaseOrderSubmissionStartedAt,
    quantityReviewPending: detail.quantityReviewPending, localAdjustedAt: detail.localAdjustedAt,
    attention: detail.attention, attentionReason: detail.attentionReason,
    purchaseLines: detail.purchaseOrderLines.map(line => ({ itemId: line.itemId, quantity: line.quantity, uom: line.uom })) };
}

try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='3s'");
    await query("SET LOCAL statement_timeout='15s'");
    const rows = await query(`SELECT r.id FROM sales_stock_requests r JOIN sales_special_stock_cases s ON s.request_id=r.id
      WHERE r.request_ref='SPREQ-000111' FOR UPDATE OF r,s`);
    assert.equal(rows.rowCount, 1);
    const id = Number(rows.rows[0].id);
    const before = await getSpecialStockCase(id, { audience: 'scm' });
    assert.equal(before.salesOrderId, 1072622);
    assert.equal(before.salesOrderRef, 'SOB122946');
    assert.equal(before.salesOrderOperationStatus, 'linked');
    assert.equal(before.purchaseOrderId, null);
    assert.equal(before.purchaseOrderOperationStatus, 'idle');
    assert.equal(before.purchaseOrderSubmissionStartedAt, null);
    assert.equal(before.quantityReviewPending, false);
    assert.ok(before.localAdjustedAt);
    assert.equal(before.closeStatus, 'active');
    if (before.attention) assert.match(before.attentionReason, /^Sales Order does not contain the exact reviewed item, quantity, UOM, and description/);
    assert.equal((await query('SELECT request_id FROM sales_special_stock_cases WHERE sales_order_netsuite_id=$1', [before.salesOrderId])).rowCount, 1);
    await reconcileSpecialOrderWebhook({ orderKind: 'sales_order', orderId: before.salesOrderId });
    const after = await getSpecialStockCase(id, { audience: 'scm' });
    assert.equal(after.attention, false);
    assert.equal(after.salesOrderApproved, true);
    assert.equal(after.dispatchPlanned, false);
    assert.equal(after.vendorDiscountReview?.mode, 'per_line');
    assert.equal(after.informationRequest?.status === 'pending', false);
    assertSpecialStockRemoteOrderAllowed(after);
    assertSpecialPurchaseRelease(after.lines);
    assert.equal(after.purchaseOrderOperationStatus, 'idle');
    assert.equal(after.purchaseOrderId, null);
    assert.deepEqual(after.salesOrderLines, before.salesOrderLines);
    assert.deepEqual(after.purchaseOrderLines, before.purchaseOrderLines);
    await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
      VALUES($1,'special_sales_order_warning_released',NULL,'all',$2::jsonb)`, [id, JSON.stringify({
      reason: 'User requested release after SCM-approved local quantity correction',
      previousWarning: before.attentionReason, salesOrderRef: before.salesOrderRef,
      release: 'special-po-warning-20261019', ordersUnchanged: true, createdPurchaseOrder: false
    })]);
    return { repaired: true, readyForPurchaseOrder: true, before: summary(before), after: summary(after) };
  });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }

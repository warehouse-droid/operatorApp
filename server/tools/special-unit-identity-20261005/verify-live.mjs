import assert from 'node:assert/strict';
import { resolveSpecialOrderUnitsFromNetSuite, fetchOperatorNetSuiteSourceItemLinesFromNetSuite } from './src/netsuite.js';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';

try {
  const identity = (await query(`SELECT r.id,r.request_ref,s.sales_order_netsuite_id,s.sales_order_ref,
    s.purchase_order_netsuite_id,s.purchase_order_operation_status,s.purchase_order_operation_error
    FROM sales_stock_requests r JOIN sales_special_stock_cases s ON s.request_id=r.id WHERE r.request_ref='SPREQ-000032'`)).rows;
  assert.equal(identity.length, 1);
  assert.equal(Number(identity[0].id), 109);
  assert.equal(identity[0].sales_order_ref, 'SOB121972');
  const resolved = await resolveSpecialOrderUnitsFromNetSuite([
    { itemId: 2055, uom: 'SQFT', quantity: 120, rate: 22.88 },
    { itemId: 2055, uom: 'PC', quantity: 120, rate: 22.88 },
    { itemId: 1784, uom: 'EACH', quantity: 2, rate: 15 }
  ]);
  assert.deepEqual(resolved.map(line => [line.itemId, line.unitId, line.quantity, line.rate]),
    [[2055, 866, 120, 22.88], [2055, 865, 120, 22.88], [1784, 246, 2, 15]]);
  const sales = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('SO', 1036614);
  const purchase = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('PO', 1038450);
  const salesLine = sales.find(line => Number(line.item?.id) === 2055);
  const purchaseLine = purchase.find(line => Number(line.item?.id) === 2055);
  assert.equal(Number(salesLine.createdPo?.id), 1038450);
  assert.equal(Number(salesLine.quantity), 120);
  assert.equal(Number(salesLine.rate), 22.88);
  assert.equal(Number(purchaseLine.quantity), 120);
  assert.equal(Number(purchaseLine.rate), 18.88);
  const health = await fetch('http://127.0.0.1:3000/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const manualLink = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const detail = await getSpecialStockCase(109, { audience: 'scm' });
    assert.equal(detail.requestRef, 'SPREQ-000032');
    assert.equal(detail.attention, false);
    assert.equal(detail.purchaseOrderOperationError, '');
    assert.ok(['idle', 'linked'].includes(detail.purchaseOrderOperationStatus));
    assert.ok(!detail.purchaseOrderId || detail.purchaseOrderId === 1038450);
    const flags = (await query('SELECT information_request,quantity_review,fulfillment_change FROM sales_special_stock_cases WHERE request_id=109')).rows[0];
    assert.notEqual(flags.information_request?.status, 'pending');
    assert.ok(!['pending', 'applying', 'attention'].includes(flags.quantity_review?.status));
    assert.ok(!['applying', 'attention'].includes(flags.fulfillment_change?.status));
    return { revision: detail.revision, operationStatus: detail.purchaseOrderOperationStatus,
      manualLinkBlockCleared: true, purchaseOrderId: detail.purchaseOrderId };
  });
  console.log(JSON.stringify({ requestRef: identity[0].request_ref, resolvedUnits: resolved,
    existingSalesOrder: 'SOB121972', existingPurchaseOrder: 'POB03988', health: 'healthy',
    requestWrites: 0, netSuiteWrites: 0, storedOperationError: identity[0].purchase_order_operation_error, manualLink }));
} finally { await closeDb(); }

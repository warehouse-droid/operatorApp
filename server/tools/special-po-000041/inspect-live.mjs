// Read-only diagnostic; run through stdin in the live application's /app directory.
import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { suiteqlAll } from './src/netsuite.js';
import { withOperatorNetSuitePriority } from './src/operator-netsuite-request-pool.js';

try {
  const state = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const ids = await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000041'");
    assert.equal(ids.rowCount, 1);
    const detail = await getSpecialStockCase(Number(ids.rows[0].id), { audience: 'scm', dispatchPlans: [] });
    const keys = ['id','requestRef','revision','status','vendorId','operationalYardLocationId',
      'salesOrderId','salesOrderRef','salesOrderSource','salesOrderStatus','salesOrderApproved','salesOrderOperationStatus',
      'purchaseOrderId','purchaseOrderRef','purchaseOrderStatus','purchaseOrderOperationId','purchaseOrderOperationStatus',
      'purchaseOrderOperationError','purchaseOrderSubmissionStartedAt','purchaseOrderCustomLinkage','purchaseOrderSkipped',
      'salesOrderSkipped','attention','attentionReason','quantityReviewPending','quantityReview','fulfillmentChange',
      'closeStatus','operationallyComplete','controls','actions','lineEditState','remotelyReconciled'];
    const caseState = Object.fromEntries(keys.filter(key => key in detail).map(key => [key, detail[key]]));
    const lineKeys = ['id','caseLineId','itemId','itemName','description','quantity','uom','rate','unitPurchaseCost',
      'ancillary','remoteLineId','decision','stockCheckStatus','purchaseCheckStatus','scmDecision','nativeDiscountPercent'];
    for (const name of ['lines','salesOrderLines','purchaseOrderLines']) {
      caseState[name] = (detail[name] || []).map(line => Object.fromEntries(lineKeys.filter(key => key in line).map(key => [key,line[key]])));
    }
    const events = await query(`SELECT event_type,created_at,details FROM sales_special_stock_events
      WHERE request_id=$1 ORDER BY id DESC LIMIT 12`, [detail.id]);
    const mirror = await query(`SELECT netsuite_id,tranid,vendor_id,destination_location_id,netsuite_active,status,status_text
      FROM purchase_orders WHERE lower(tranid)=lower('POB03999')`);
    const operations = await query(`SELECT purchase_order_submission_started_at,sales_order_operation_error
      FROM sales_special_stock_cases WHERE request_id=$1`,[detail.id]);
    return { case:caseState, events:events.rows, purchaseOrderMirror:mirror.rows, operations:operations.rows };
  });
  const remote = await withOperatorNetSuitePriority(async () => {
    const orders = await suiteqlAll("SELECT id,tranid,entity,status,externalid FROM transaction WHERE type='PurchOrd' AND tranid='POB03999'");
    assert.ok(orders.length <= 1);
    const links = orders.length ? await suiteqlAll(`SELECT previousdoc,previousline,nextdoc,nextline,linktype
      FROM NextTransactionLineLink WHERE nextdoc=${Number(orders[0].id)}`) : [];
    const markers = await suiteqlAll(`SELECT id,tranid,entity,status,externalid FROM transaction
      WHERE type='PurchOrd' AND externalid='MBBS-SPECIAL-PO:${Number(state.case.id)}'`);
    return { orders, nativeLinks:links, requestPurchaseOrderMarkers:markers };
  });
  console.log(JSON.stringify({ at:new Date().toISOString(),...state,remote,applicationWrites:0,netSuiteWrites:0 }));
} finally { await closeDb(); }

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from './src/db.js';
import { getSpecialStockCase, linkSpecialSalesOrder } from './src/special-stock-request-repository.js';
import { readSpecialRestOrder } from './src/special-stock-rest-orders.js';
import { createSpecialOrderDocumentService } from './src/special-stock-documents.js';
import { withOperatorNetSuitePriority } from './src/operator-netsuite-request-pool.js';

const approved = APPROVED_SNAPSHOT;
const mode = process.argv.at(-1);
assert.ok(['preflight', 'apply'].includes(mode));
const temporary = `/tmp/special-so-000030-recovery-${process.pid}.mjs`;
const backupFile = '/tmp/special-so-000030-recovery-before.json';
const pdfFile = '/tmp/special-so-000030-preview.pdf';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source = readFileSync('/app/src/netsuite.js', 'utf8').replace(
  /((?:from\s+|import\s*\()\s*)(['"])(\.\.?\/[^'"]+)\2/g,
  (_, prefix, quote, relative) => `${prefix}${quote}${pathToFileURL(resolve('/app/src', relative)).href}${quote}`
);
writeFileSync(temporary, `${source}\nexport { netsuiteRest as diagnosticRest };\n`, { mode: 0o600 });
try {
  const ns = await import(pathToFileURL(temporary).href);
  await withOperatorNetSuitePriority(async () => {
    const remote = await readSpecialRestOrder({ id: 1041956, kind: 'sales_order' }, { rest: ns.diagnosticRest, queryAll: ns.suiteqlAll });
    assert.equal(remote.record.tranId, 'SOB122131');
    assert.equal(remote.record.externalId, 'MBBS-SPECIAL-SO:106');
    assert.equal(remote.snapshot.header.entity, '5409'); assert.equal(remote.snapshot.header.location, '1');
    assert.equal(remote.snapshot.header.discountItem, '');
    const approvedLines = approved.lines.map(line => line.actual);
    const commercialLines = lines => lines.map(({ createdPoId, createPo, ...line }) => line);
    assert.deepEqual(commercialLines(remote.snapshot.lines), commercialLines(approvedLines), 'The confirmed NetSuite commercial lines changed');
    const addedPurchaseOrderIds = new Set();
    remote.snapshot.lines.forEach((line, index) => {
      const prior = approvedLines[index];
      if (line.createdPoId === prior.createdPoId && line.createPo === prior.createPo) return;
      assert.equal(prior.createdPoId, null); assert.equal(prior.createPo, '');
      assert.ok(Number.isSafeInteger(line.createdPoId) && line.createdPoId > 0);
      assert.equal(line.createPo, 'SpecOrd');
      addedPurchaseOrderIds.add(line.createdPoId);
    });
    const purchaseOrders = [];
    for (const purchaseOrderId of addedPurchaseOrderIds) {
      const rows = await ns.suiteqlAll(`SELECT id,tranid,type FROM transaction WHERE id=${purchaseOrderId}`);
      assert.equal(rows.length, 1); assert.equal(rows[0].type, 'PurchOrd');
      purchaseOrders.push({ id: purchaseOrderId, ref: rows[0].tranid });
    }
    let originalDraftRows;
    const before = await withTransaction(async () => {
      await query('SET TRANSACTION READ ONLY');
      const detail = await getSpecialStockCase(106, { audience: 'scm', dispatchPlans: [] });
      assert.equal(detail.requestRef, 'SPREQ-000030'); assert.equal(detail.revision, 20);
      assert.equal(detail.salesOrderId, null); assert.equal(detail.purchaseOrderId, null);
      assert.equal(detail.salesOrderOperationId, 'c431c03e-0635-4155-8004-7430279fb407');
      assert.equal(detail.salesOrderOperationStatus, 'attention');
      assert.match(detail.salesOrderOperationError, /existing SO does not match/);
      assert.equal(detail.closeStatus, 'active'); assert.equal(detail.operationallyComplete, false);
      assert.equal(detail.salesOrderSkipped, false); assert.equal(detail.purchaseOrderSkipped, false);
      assert.equal(detail.quantityReviewPending, false);
      assert.ok(!['applying', 'attention'].includes(detail.fulfillmentChange?.status));
      const owners = await query('SELECT request_id FROM sales_special_stock_cases WHERE sales_order_netsuite_id=1041956');
      assert.equal(owners.rowCount, 0);
      const backup = (await query(`SELECT jsonb_build_object('request',to_jsonb(r),'case',to_jsonb(c),
        'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=r.id),
        'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=r.id),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM sales_special_stock_events e WHERE request_id=r.id)) AS state
        FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=106`)).rows[0].state;
      writeFileSync(backupFile, JSON.stringify({ at: new Date().toISOString(), application: backup, remote }), { mode: 0o600 });
      originalDraftRows = { caseLines: backup.caseLines, orderLines: backup.orderLines };
      return detail;
    });
    if (mode === 'preflight') {
      console.log(JSON.stringify({ ready: true, requestRef: before.requestRef, revision: before.revision, salesOrderRef: 'SOB122131',
        recovery: 'manual_reference', keepNetSuiteLines: true, sqFtUnits: 866, unitlessDeliveryFee: true,
        confirmedDifferences: ['Removed extra Special Order delivery line at 235', 'Retained reversed delivery fee at -100'],
        existingNetSuitePurchaseOrdersPreserved: purchaseOrders,
        netSuiteWrites: 0, applicationWrites: 0 }));
      return;
    }
    const linked = await withTransaction(async () => {
      await query("SET LOCAL lock_timeout='5s'");
      const locked = await query(`SELECT r.id FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
        WHERE r.id=106 AND r.request_ref='SPREQ-000030' AND r.revision=20 AND c.sales_order_netsuite_id IS NULL
        AND c.sales_order_operation_status='attention' AND c.sales_order_operation_id=$1 FOR UPDATE OF r,c`, [before.salesOrderOperationId]);
      assert.equal(locked.rowCount, 1, 'The authorized request changed');
      const current = await getSpecialStockCase(106, { audience: 'scm', dispatchPlans: [] });
      assert.equal(digest(current), digest(before), 'Request data changed during preflight');
      await query(`UPDATE sales_special_stock_cases SET sales_order_operation_status='idle',sales_order_operation_error=NULL,
        attention=false,attention_reason=NULL,updated_at=now() WHERE request_id=106`);
      await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
        VALUES(106,'special_sales_order_existing_reference_recovery',NULL,'all',$1::jsonb)`, [JSON.stringify({
        salesOrderId: 1041956, salesOrderRef: 'SOB122131', operationId: before.salesOrderOperationId,
        userInstruction: 'Keep the current NetSuite lines', reason: 'Original verification incorrectly compared unitless Delivery Charge; current SO also contains confirmed charge-line edits.',
        reviewedDraftRetainedAsHistory: true, currentNetSuiteLinesHash: digest(remote.snapshot.lines),
        existingNetSuitePurchaseOrdersPreserved: purchaseOrders,
        differences: { removed: { itemId: 2055, description: 'DELIVERY CHARGE', quantity: 1, rate: 235 },
          added: { itemId: 4646, description: 'reversed delivery fee', quantity: 1, rate: -100 } }, netSuiteWrites: 0 })]);
      const result = await linkSpecialSalesOrder(106, { expectedRevision: 20, salesOrderRef: 'SOB122131', source: 'manual_link' });
      assert.equal(result.salesOrderId, 1041956); assert.equal(result.salesOrderOperationStatus, 'linked');
      assert.equal(result.attention, false); assert.equal(result.purchaseOrderId, null);
      const retained = await getSpecialStockCase(106, { audience: 'scm', dispatchPlans: [] });
      assert.deepEqual(retained.salesOrderLines, before.salesOrderLines, 'Historical draft must remain unchanged');
      assert.deepEqual(retained.purchaseOrderLines, before.purchaseOrderLines);
      assert.deepEqual(retained.lines, before.lines);
      const retainedRows = (await query(`SELECT jsonb_build_object(
        'caseLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=106),
        'orderLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_order_lines l WHERE request_id=106)) AS state`)).rows[0].state;
      assert.deepEqual(retainedRows, originalDraftRows, 'The complete stored material and order drafts must remain unchanged');
      return result;
    });
    const after = await readSpecialRestOrder({ id: 1041956, kind: 'sales_order' }, { rest: ns.diagnosticRest, queryAll: ns.suiteqlAll });
    assert.deepEqual(after.snapshot, remote.snapshot, 'NetSuite changed during reference recovery');
    const document = await createSpecialOrderDocumentService().preview(106, 'sales_order', { audience: 'sales', authorizedStoreLocationIds: [1] });
    writeFileSync(pdfFile, document.buffer, { mode: 0o600 });
    console.log(JSON.stringify({ recovered: true, requestRef: linked.requestRef, revision: linked.revision,
      salesOrderRef: linked.salesOrderRef, salesOrderId: linked.salesOrderId, source: linked.salesOrderSource,
      operationStatus: linked.salesOrderOperationStatus, attention: linked.attention, purchaseOrderId: linked.purchaseOrderId,
      netSuiteWrites: 0, currentNetSuiteLinesPreserved: true, historicalDraftPreserved: true,
      existingNetSuitePurchaseOrdersPreserved: purchaseOrders,
      preview: { bytes: document.buffer.length, filename: document.filename, sha256: createHash('sha256').update(document.buffer).digest('hex') } }));
  });
} finally {
  unlinkSync(temporary);
  await closeDb();
}

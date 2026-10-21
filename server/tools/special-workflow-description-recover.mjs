// Recover only the already-created PO for SPREQ-000007. No NetSuite write
// transport is imported; there is no create, PATCH or submission rearm path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const { query, closeDb, withTransaction } = await import(`${process.cwd()}/src/db.js`);
const { getSpecialStockCase, linkSpecialPurchaseOrder } = await import(`${process.cwd()}/src/special-stock-request-repository.js`);
const { findSpecialStockOrdersByMarkerFromNetSuite, fetchOperatorNetSuiteSourceItemLinesFromNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite } = await import(`${process.cwd()}/src/netsuite.js`);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function protectedCase() {
  return withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const rows = (await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000006'")).rows;
    assert.equal(rows.length, 1);
    return hash(await getSpecialStockCase(rows[0].id, { audience: 'scm' }));
  });
}
const description = 'Unilock Ltd Endura Coping Lineo Buff 123test';
const operationId = '5ce7d0cd-e730-4706-a13b-f35e0cc07d25';
try {
  const protectedBefore = await protectedCase();
  const d = await getSpecialStockCase(62, { audience: 'scm' });
  assert.equal(d.requestRef, 'SPREQ-000007');
  assert.equal(d.salesOrderId, 1017068);
  assert.equal(d.salesOrderApproved, true);
  assert.equal(d.purchaseOrderOperationId, operationId);
  assert.equal(d.purchaseOrderId, null);
  assert.equal(d.purchaseOrderOperationStatus, 'creating');
  assert.equal(d.revision, 26);
  assert.ok(d.purchaseOrderSubmissionStartedAt);
  assert.deepEqual(d.purchaseOrderLines.map(l => [l.itemId, l.quantity, l.uom, l.unitPurchaseCost, l.description]), [[2055, 500, 'PC', 5, description]]);
  const markers = await findSpecialStockOrdersByMarkerFromNetSuite({ caseId: 62, orderKind: 'purchase_order' });
  assert.equal(markers.length, 1);
  assert.equal(Number(markers[0].id), 1017168);
  assert.equal(Number(markers[0].entity_id), 331);
  assert.equal(markers[0].tranid, 'POB03934');
  const so = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('SO', 1017068);
  const po = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('PO', 1017168);
  const values = rows => rows.map(l => [Number(l.item.id), Number(l.quantity), String(l.units), Number(l.rate), l.description]);
  assert.deepEqual(values(so), [[2055, 500, '865', 17, description], [1784, 11, '246', 40, 'PALLET']]);
  assert.deepEqual(values(po), [[2055, 500, '865', 5, description]]);
  const reference = await fetchPurchaseOrderReferenceFromNetSuite(1017168);
  assert.equal(reference.tranid, 'POB03934');
  const history = await query('SELECT id FROM scm_netsuite_po_history WHERE netsuite_purchase_order_id=1017168');
  assert.equal(history.rowCount, 1);
  const evidence = { before: d, protectedBefore, so: values(so), po: values(po), markerCount: markers.length };
  if (process.argv.at(-1) === '--apply') {
    writeFileSync('/tmp/spreq-000007-po-link-before.private.json', JSON.stringify(evidence), { mode: 0o600, flag: 'wx' });
    const linked = await linkSpecialPurchaseOrder(62, { expectedRevision: 26, operationId,
      purchaseOrderId: 1017168, purchaseOrderRef: 'POB03934',
      purchaseOrderStatus: reference.status_text || reference.status, verifiedRemote: true });
    assert.equal(linked.purchaseOrderId, 1017168);
    assert.equal(linked.purchaseOrderOperationStatus, 'linked');
    assert.equal(linked.attention, false);
    assert.equal(await protectedCase(), protectedBefore);
    console.log(JSON.stringify({ recovered: true, requestRef: linked.requestRef, revision: linked.revision,
      salesOrderRef: linked.salesOrderRef, purchaseOrderRef: linked.purchaseOrderRef,
      purchaseOrderStatus: linked.purchaseOrderStatus, description, so: values(so), po: values(po),
      markerCount: markers.length, netSuiteWrites: 0, protectedRequestUnchanged: true }));
  } else console.log(JSON.stringify({ readOnly: true, requestRef: d.requestRef, revision: d.revision,
    purchaseOrderId: 1017168, purchaseOrderRef: 'POB03934', so: values(so), po: values(po), markerCount: markers.length,
    protectedFingerprint: protectedBefore }));
} finally { await closeDb(); }

// Final readback only: this script imports no NetSuite write transport.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.cwd();
const { query, withTransaction, closeDb } = await import(`${root}/src/db.js`);
const { getSpecialStockCase } = await import(`${root}/src/special-stock-request-repository.js`);
const { fetchOperatorNetSuiteSourceItemLinesFromNetSuite, findSpecialStockOrdersByMarkerFromNetSuite, suiteqlAll } = await import(`${root}/src/netsuite.js`);
try {
  const protectedFingerprint = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const { rows } = await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000006'");
    assert.equal(rows.length, 1);
    return createHash('sha256').update(JSON.stringify(await getSpecialStockCase(rows[0].id, { audience: 'scm' }))).digest('hex');
  });
  assert.equal(protectedFingerprint, '096eb965548b9bd078ec4bae5d1078efc97c52eba14e7cd2aa2089449efb58ef');
  const d = await getSpecialStockCase(62, { audience: 'scm' });
  assert.equal(d.requestRef, 'SPREQ-000007'); assert.equal(d.salesOrderId, 1017068); assert.equal(d.purchaseOrderId, 1017168);
  assert.equal(d.purchaseOrderOperationStatus, 'linked'); assert.equal(d.attention, false);
  const markers = await findSpecialStockOrdersByMarkerFromNetSuite({ caseId: 62, orderKind: 'purchase_order' });
  assert.equal(markers.length, 1); assert.equal(Number(markers[0].id), 1017168);
  const so = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('SO', d.salesOrderId);
  const po = await fetchOperatorNetSuiteSourceItemLinesFromNetSuite('PO', d.purchaseOrderId);
  const values = ls => ls.map(l => [Number(l.item.id), Number(l.quantity), String(l.units), Number(l.rate), l.description]);
  assert.deepEqual(values(so), [[2055,500,'865',17,'Unilock Ltd Endura Coping Lineo Buff 123test'],[1784,11,'246',40,'PALLET']]);
  assert.deepEqual(values(po), [[2055,500,'865',5,'Unilock Ltd Endura Coping Lineo Buff 123test']]);
  const native = await suiteqlAll('SELECT previousdoc,previousline,nextdoc,nextline,linktype FROM NextTransactionLineLink WHERE previousdoc=1017068 AND nextdoc=1017168');
  console.log(JSON.stringify({ readOnly: true, requestRef: d.requestRef, salesOrderRef: d.salesOrderRef, purchaseOrderRef: d.purchaseOrderRef,
    purchaseOrderStatus: d.purchaseOrderStatus, appLinked: true, nativeLinks: native.length,
    markerCount: markers.length, reviewedLinesVerified: true, salesRate: 17, purchaseCost: 5, quantity: 500, units: '865',
    protectedRequestUnchanged: true, protectedFingerprint }));
} finally { await closeDb(); }

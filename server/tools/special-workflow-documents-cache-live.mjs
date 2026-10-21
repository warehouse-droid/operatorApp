// Populate and verify only the requested case's read-only document previews.
// This imports no NetSuite writer and changes no business order or case data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root = process.cwd();
const { query, withTransaction, closeDb } = await import(`${root}/src/db.js`);
const { getSpecialStockCase } = await import(`${root}/src/special-stock-request-repository.js`);
const { createSpecialOrderDocumentService } = await import(`${root}/src/special-stock-documents.js`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedHash = async () => withTransaction(async () => {
  await query('SET TRANSACTION READ ONLY');
  const { rows: [request] } = await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000006'");
  return hash(JSON.stringify(await getSpecialStockCase(request.id, { audience: 'scm' })));
});
try {
  const expected = '096eb965548b9bd078ec4bae5d1078efc97c52eba14e7cd2aa2089449efb58ef';
  assert.equal(await protectedHash(), expected);
  const before = await getSpecialStockCase(62, { audience: 'scm' });
  assert.equal(before.requestRef, 'SPREQ-000007'); assert.equal(before.quantityReview.status, 'approved');
  assert.equal(before.salesOrderId, 1017068); assert.equal(before.purchaseOrderId, 1017168);
  assert.equal(before.salesOrderLines.find(line => line.itemId === 2055).quantity, 50);
  assert.equal(before.purchaseOrderLines[0].quantity, 50);
  const service = createSpecialOrderDocumentService(), previews = [];
  for (const audience of ['sales','scm']) {
    for (const kind of ['sales_order','purchase_order']) {
      const context = { audience, authorizedStoreLocationIds: [before.storeLocationId] };
      const first = await service.preview(62, kind, context), repeat = await service.preview(62, kind, context);
      assert.equal(repeat.cached, true); assert.deepEqual(repeat.buffer, first.buffer);
      assert.equal(first.buffer.subarray(0,5).toString(), '%PDF-'); assert.ok(first.buffer.length > 1000);
      previews.push({ audience, kind, initiallyCached: first.cached, repeatCached: repeat.cached, bytes: first.buffer.length, sha256: hash(first.buffer) });
    }
  }
  assert.notEqual(previews[1].sha256, previews[3].sha256);
  assert.equal(await protectedHash(), expected);
  assert.deepEqual(await getSpecialStockCase(62, { audience: 'scm' }), before);
  console.log(JSON.stringify({ requestRef: before.requestRef, savedPreviews: previews, businessCaseUnchanged: true, protectedRequestUnchanged: true }));
} finally { await closeDb(); }

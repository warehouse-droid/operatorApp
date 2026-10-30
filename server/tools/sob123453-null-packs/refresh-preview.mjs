// User-authorized maintenance: regenerate only SOB123453's in-app SO preview cache.
// Execute through the production app connection; no SO write or print is queued.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { query, withTransaction, closeDb } from '/app/src/db.js';
import { getSpecialStockCase } from '/app/src/special-stock-request-repository.js';
import { createSpecialOrderDocumentService } from '/app/src/special-stock-documents.js';

const requestId = 348;
const kind = 'sales_order';
const service = createSpecialOrderDocumentService();
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const cacheSummary = row => ({ requestId: row.request_id, kind: row.order_kind, audience: row.audience,
  filename: row.filename, snapshotHash: row.snapshot_hash, pdfHash: digest(row.pdf),
  bytes: row.pdf.length, generatedAt: row.generated_at });
const auditDir = '/app/data/operational-audit/sob123453-null-packs-20261026';
const auditId = `preview-refresh-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });

try {
  const detail = await getSpecialStockCase(requestId, { audience: 'sales', authorizedStoreLocationIds: [1], dispatchPlans: [] });
  assert.equal(detail.salesOrderId, 1091569);
  assert.equal(detail.salesOrderRef, 'SOB123453');
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='10s'");
    for (const audience of ['sales', 'scm']) {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`special-order-pdf:${requestId}:${kind}:${audience}`]);
    }
    const identity = (await query(`SELECT sales_order_netsuite_id,sales_order_ref FROM sales_special_stock_cases WHERE request_id=$1`, [requestId])).rows[0];
    assert.equal(String(identity.sales_order_netsuite_id), '1091569');
    assert.equal(identity.sales_order_ref, 'SOB123453');
    const rows = (await query(`SELECT * FROM sales_special_stock_document_cache WHERE request_id=$1 AND order_kind=$2 ORDER BY audience`, [requestId, kind])).rows;
    const before = rows.map(cacheSummary);
    const audiences = [...new Set(['sales', ...rows.map(row => row.audience)])].sort();
    assert(audiences.every(audience => ['sales', 'scm'].includes(audience)));
    fs.writeFileSync(`${auditDir}/${auditId}-before.json`, JSON.stringify({ order: 'SOB123453', before }, null, 2), { mode: 0o600, flag: 'wx' });
    const removed = await query(`DELETE FROM sales_special_stock_document_cache WHERE request_id=$1 AND order_kind=$2`, [requestId, kind]);
    assert.equal(removed.rowCount, rows.length);
    const generated = [];
    for (const audience of audiences) {
      const document = await service.preview(requestId, kind, { audience, authorizedStoreLocationIds: [1] });
      assert.equal(document.cached, false);
      assert.equal(document.buffer.subarray(0, 5).toString(), '%PDF-');
      generated.push({ audience, filename: document.filename, pdfHash: digest(document.buffer), bytes: document.buffer.length,
        generatedAt: document.generatedAt });
    }
    return { before, generated, audiences };
  });
  let preview;
  for (const audience of result.audiences) {
    const document = await service.preview(requestId, kind, { audience, authorizedStoreLocationIds: [1] });
    assert.equal(document.cached, true);
    assert.equal(digest(document.buffer), result.generated.find(row => row.audience === audience).pdfHash);
    if (audience === 'sales') preview = document.buffer;
  }
  const report = { order: 'SOB123453', requestId, refreshed: true, cacheReadbackVerified: true, ...result, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(`${auditDir}/${auditId}-after.json`, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  console.error(JSON.stringify(report));
  process.stdout.write(preview);
} finally { await closeDb(); }

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hashes = RELEASE_HASHES;
const checks = [];
for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
  const health = await fetch(base + '/health', { signal: AbortSignal.timeout(15000) });
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  for (const [file, hash] of Object.entries(hashes)) {
    if (!file.startsWith('public/')) continue;
    const path = file === 'public/sales-stock-requests.html' ? '/sales/stock-requests' : '/' + file.slice(7);
    const response = await fetch(base + path + '?requestCorrections=20261003-v1', { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const body = (await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g, '');
    assert.equal(createHash('sha256').update(body).digest('hex'), hash, path);
  }
  const denied = await fetch(base + '/api/sales/special-stock-requests/0/case-lines', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
  assert.equal(denied.status, 401);
  checks.push({ base, health: true, assets: true, lineEditRequiresAuthentication: true });
}
const { query, closeDb } = await import('./src/db.js');
try {
  const { projectSpecialStockCase } = await import('./src/special-stock-request-policy.js');
  const sentinel = 'INTERNAL-REMARK-PRIVACY-PROBE';
  for (const audience of ['scm', 'dispatch']) assert.ok(!JSON.stringify(projectSpecialStockCase({ salesInternalRemark: sentinel, lines: [], events: [{ eventType: 'special_sales_internal_remark_updated', details: { before: { salesInternalRemark: sentinel } } }] }, audience)).includes(sentinel));
  const { getSpecialStockCase } = await import('./src/special-stock-request-repository.js');
  const { buildSpecialQuote } = await import('./src/special-stock-documents.js');
  const detail = await getSpecialStockCase(103, { audience: 'sales' });
  assert.equal(detail.requestRef, 'SPREQ-000028'); assert.equal(detail.closeStatus, 'closed'); assert.equal(detail.revision, 5);
  const company = (await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0].data.companies.MBBS;
  const quote = buildSpecialQuote(detail, company);
  assert.equal(quote.snapshot.lines.length, 1); assert.equal(quote.snapshot.subtotalMinor, 274560);
  assert.equal(quote.snapshot.totalMinor, 310253);
  const { specialRequestLineNotes } = await import('./public/special-stock-line-notes.js');
  assert.match(specialRequestLineNotes(detail), /need full skid/);
  const { specialCaseEditDraft, planSpecialCaseEdits } = await import('./public/special-stock-case-edits.js');
  const synthetic = { revision: 1, fulfillmentMethod: 'mbt_delivery', deliveryFeeRate: 235, palletTotal: 0, palletRate: null, lines: [] };
  assert.equal(specialCaseEditDraft(synthetic).deliveryFeeRate, 235);
  assert.deepEqual(planSpecialCaseEdits(synthetic, { pallet: { quantity: 2, rate: 40 }, deliveryFeeRate: 0 }),
    { lines: [], pallet: { quantity: 2, rate: 40 }, deliveryFeeRate: 0, restart: false });
  console.log(JSON.stringify({ checks, salesOnlyProjection: true, request000028: { readOnly: true, closed: true, revision: detail.revision,
    eligibleQuoteLines: quote.snapshot.lines.length, subtotal: quote.snapshot.subtotalMinor / 100, total: quote.snapshot.totalMinor / 100, savedDecisionNoteVisible: true }, chargeEditPlanVerified: true }));
} finally { await closeDb(); }

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
    const response = await fetch(base + path + '?lineDecline=20261003-v1', { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
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
  const columns = (await query("SELECT column_name FROM information_schema.columns WHERE (table_name='sales_special_stock_cases' AND column_name='line_edit_state') OR (table_name='sales_special_stock_lines' AND column_name='decline_restore')")).rows;
  assert.equal(columns.length, 2);
  const { specialCaseEditDraft, planSpecialCaseEdits, revokeSpecialLineDecision, specialCaseStageAfterEdits } = await import('./public/special-stock-case-edits.js');
  const synthetic = { revision: 3, lineEditState: { stage: 'wait_for_production', revision: 3 }, palletTotal: 0, palletRate: null,
    lines: [{ id: 1, quantity: 2, originalRate: 40, salesDecision: 'accepted' }] };
  assert.deepEqual(specialCaseEditDraft(synthetic).decisions, [{ lineId: 1, declined: false }]);
  assert.deepEqual(planSpecialCaseEdits(synthetic, { decisions: [{ lineId: 1, declined: true }] }),
    { lines: [], pallet: null, decisions: [{ lineId: 1, declined: true }], restart: false });
  assert.equal(specialCaseStageAfterEdits(synthetic, 'await_customer_confirmation'), 'wait_for_production');
  assert.equal(revokeSpecialLineDecision({ responseRevision: 2, declineRestore: { decision: 'accepted', responseRevision: 2 } }), 'accepted');
  assert.equal(revokeSpecialLineDecision({ responseRevision: 3, declineRestore: { decision: 'accepted', responseRevision: 2 } }), 'pending');
  console.log(JSON.stringify({ checks, salesOnlyProjection: true, schemaVerified: true, reversibleDecisionsVerified: true, liveBusinessRecordsModified: false }));
} finally { await closeDb(); }

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
    const response = await fetch(base + path + '?internalRemark=20261003-v1', { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const body = (await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g, '');
    assert.equal(createHash('sha256').update(body).digest('hex'), hash, path);
  }
  const denied = await fetch(base + '/api/sales/special-stock-requests/0/internal-remark', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
  assert.equal(denied.status, 401);
  checks.push({ base, health: true, assets: true, remarkRequiresAuthentication: true });
}
const { query, closeDb } = await import('./src/db.js');
try {
  const column = (await query("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_special_stock_cases' AND column_name='sales_internal_remark'")).rows[0];
  assert.equal(column.is_nullable, 'NO'); assert.equal(column.column_default, "''::text");
  const constraint = (await query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='sales_special_stock_events'::regclass AND conname='sales_special_stock_event_audience_check'")).rows[0].definition;
  assert.match(constraint, /'sales'::text/);
  const { projectSpecialStockCase } = await import('./src/special-stock-request-policy.js');
  const sentinel = 'INTERNAL-REMARK-PRIVACY-PROBE';
  for (const audience of ['scm', 'dispatch']) assert.ok(!JSON.stringify(projectSpecialStockCase({ salesInternalRemark: sentinel, lines: [], events: [{ eventType: 'special_sales_internal_remark_updated', details: { before: { salesInternalRemark: sentinel } } }] }, audience)).includes(sentinel));
  console.log(JSON.stringify({ checks, schemaReady: true, salesOnlyProjection: true }));
} finally { await closeDb(); }

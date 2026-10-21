import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const hashes = RELEASE_HASHES;
const pages = { 'public/sales-stock-requests.html': '/sales/stock-requests', 'public/scm-stock-requests.html': '/scm/stock-requests' };
const results = [];
async function read(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetch(url, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch (error) { if (attempt === 2) throw error; }
  }
}
for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
  const health = await read(base + '/health'); assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  for (const [file, hash] of Object.entries(hashes)) {
    if (!file.startsWith('public/')) continue;
    const path = pages[file] || '/' + file.slice(7);
    const response = await read(base + path + '?stockUpdates=20261002-v1', { headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0' } });
    assert.equal(response.status, 200, path);
    const body = (await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g, '');
    assert.equal(createHash('sha256').update(body).digest('hex'), hash, path);
  }
  for (const path of ['/api/scm/special-stock-requests/0/request-information', '/api/sales/special-stock-requests/0/information-update']) {
    const response = await read(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401, path);
  }
  results.push({ base, health: true, versionedAssets: true, informationRoutesProtected: true });
}
const { query, closeDb } = await import('./src/db.js');
try {
  assert.equal((await query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_special_stock_cases' AND column_name='information_request'")).rows[0].count, 1);
  const constraint = (await query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='sales_special_stock_lines'::regclass AND conname='sales_special_stock_line_supply_check'")).rows[0].definition;
  assert.match(constraint, /low_inventory/);
  const view = (await query("SELECT pg_get_viewdef('special_stock_workflow_stages'::regclass) AS definition")).rows[0].definition;
  assert.match(view, /pending_update/); assert.match(view, /low_inventory/);
  await query('SELECT count(*) FROM special_stock_workflow_stages');
  console.log(JSON.stringify({ checks: results, informationColumn: true, lowInventoryConstraint: true, workflowView: true }));
} finally { await closeDb(); }

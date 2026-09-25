import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { listAggregateRequests } from './src/aggregate-request-repository.js';
import { query, withTransaction, closeDb } from './src/db.js';

const assets = EXPECTED_ASSETS;
const http = [];
try {
  for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
    const options = { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) };
    const health = await fetch(`${base}/health`, options);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    for (const path of ['/aggregate-requests', '/scm/stock-requests?tab=aggregate']) {
      const response = await fetch(base + path, options);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /aggregate-requests\.js/);
    }
    for (const path of ['/api/aggregate-requests', '/api/scm/aggregate-requests']) {
      assert.equal((await fetch(base + path, options)).status, 401);
    }
    for (const [file, expected] of Object.entries(assets)) {
      const response = await fetch(`${base}/${file.replace(/^public\//, '')}?v=20260922-aggregate-v1`, options);
      assert.equal(response.status, 200, file);
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, file);
    }
    http.push({ base, health: 200, pages: 2, protectedApis: 2, verifiedAssets: Object.keys(assets).length });
  }
  const database = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const listing = await listAggregateRequests({ id: 'aggregate-release-read-only-check', role: 'admin' });
    assert.equal(listing.materials.length, 7);
    assert.equal(listing.materials.filter(item => item.direction === 'inbound').length, 4);
    assert.equal(listing.materials.filter(item => item.direction === 'outbound').length, 3);
    assert.equal(listing.yards.length, 4);
    assert.equal(listing.canManage, true);
    const rows = await query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('aggregate_requests','aggregate_request_lines','aggregate_request_events')");
    assert.equal(rows.rows[0].n, 3);
    return { readOnly: true, tables: 3, materials: 7, yards: 4, serviceDate: listing.serviceDate };
  });
  console.log(JSON.stringify({ passed: true, http, database }));
} finally {
  await closeDb();
}

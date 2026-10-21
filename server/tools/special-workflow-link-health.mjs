import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const asset = await fetch(`${base}/scm-special-stock-requests.js?v=special-so-po-link-20260926`, { headers: { 'Cache-Control': 'no-cache' } });
  assert.equal(asset.status, 200);
  assert.equal(hash(Buffer.from(await asset.arrayBuffer())), hash(readFileSync('/app/public/scm-special-stock-requests.js')));
}
console.log(JSON.stringify({ localHealth: 200, publicHealth: 200, reviewGuidanceServed: true }));

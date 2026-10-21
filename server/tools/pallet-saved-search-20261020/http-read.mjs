// Run via Node stdin in /app. Read-only health and unauthenticated access probes.
import assert from 'node:assert/strict';
const checks = [];
for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const balance = await fetch(`${base}/api/returns/customers/5240/pallet-balance?receivingLocationId=26`,
    { signal: AbortSignal.timeout(15000) });
  assert.equal(balance.status, 401);
  checks.push({ base, health: health.status, anonymousPalletBalance: balance.status });
}
console.log(JSON.stringify({ observedAt: new Date().toISOString(), checks }));

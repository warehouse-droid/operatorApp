import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileFunction } from 'node:vm';
import { config } from './src/config.js';
import { query, withTransaction, closeDb } from './src/db.js';
import { googleMapsAdmissionDecision } from './src/google-maps-usage-policy.js';

const source = await readFile('/app/src/server.js', 'utf8');
const names = ['normalizedOperatorRoles', 'operatorHasAnyRole', 'requireDispatchAccess'];
const functions = names.map(name => {
  const value = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, 'm'))?.[0];
  assert.ok(value, name);
  return value;
}).join('\n');
const guard = compileFunction(functions + '\nreturn requireDispatchAccess;', ['sendRoleForbidden'])(() => 403);
let cases = 0;
for (const [role, method, path, allowed] of [
  ['sales', 'POST', '/maps/browser-session', true], ['sales', 'GET', '/monitor', true],
  ['sales', 'POST', '/plans', false], ['sales', 'POST', '/maps/route-estimate', false],
  ['sales', 'POST', '/maps/monitor-eta', false], ['sales', 'POST', '/maps/browser-session/extra', false],
  ['sales', 'PUT', '/maps/browser-session', false], ['operator', 'POST', '/maps/browser-session', false],
  ['scm', 'POST', '/maps/browser-session', false], ['yard_manager', 'POST', '/maps/browser-session', false],
  ['dispatcher', 'POST', '/maps/browser-session', true], ['admin', 'POST', '/maps/browser-session', true]
]) {
  let nextCalls = 0;
  const result = guard({ operator: { role }, method, path }, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, allowed ? 1 : 0, `${role} ${method} ${path}`);
  if (!allowed) { assert.equal(result, 403); }
  cases += 1;
}
const http = [];
for (const base of ['http://127.0.0.1:3000', 'https://test.mbbsoperation.com']) {
  const options = { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) };
  const health = await fetch(base + '/health', options);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(base + '/sales/monitor', options);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /dispatch-monitor\.js/);
  const denied = await fetch(base + '/api/dispatch/maps/browser-session', { ...options, method: 'POST',
    headers: { ...options.headers, 'content-type': 'application/json', 'x-mbbs-sales-public': '1' }, body: '{}' });
  assert.equal(denied.status, 401);
  http.push({ base, health: 200, salesMonitorPage: 200, anonymousMapDenied: 401 });
}
let policy;
try {
  const usage = await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    return (await query(`SELECT coalesce(sum(admitted_units),0)::int AS total,
      coalesce(sum(admitted_units) FILTER (WHERE subsystem='dynamic_map'),0)::int AS maps
      FROM google_maps_usage_ledger WHERE admitted AND requested_at>=now()-interval '30 days'`)).rows[0];
  });
  const decision = googleMapsAdmissionDecision({ mode: config.googleMaps?.mode, rollingUsage: usage.total,
    subsystemUsage: usage.maps, subsystem: 'dynamic_map', automatic: true, reason: 'browser_page_load' });
  policy = { rollingUsage: usage.total, mapUsage: usage.maps, allowed: decision.admitted, reason: decision.reason };
} finally { await closeDb(); }
console.log(JSON.stringify({ passed: true, readOnly: true, deployedGuardCases: cases,
  mapsMode: config.googleMaps?.mode, browserKeyConfigured: Boolean(config.googleMaps?.browserApiKey), policy, http }));

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import crypto from 'node:crypto';
import { createOperator } from '../../../src/auth-repository.js';
import { closeDb } from '../../../src/db.js';
import { app } from '../../../src/server.js';
after(closeDb);

test('U1/U2 actual Admin settings HTTP endpoint authorizes, validates, persists, and reloads the independent schedule', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const cleanup = { restore: async () => {} };
  t.after(async () => {
    try { await cleanup.restore(); } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/control/scm-reconciliation/settings';
  const call = (url, body, token) => fetch(`${base}${url}`, { method: body ? 'PUT' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const tokens = {};
  for (const role of ['admin', 'operator']) {
    const username = `aggregate-${role}-${crypto.randomUUID()}`;
    const password = crypto.randomUUID();
    await createOperator({ username, password, role, roles: [role], displayName: username });
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); tokens[role] = (await response.json()).token;
  }
  assert.equal((await call(path, { aggregateNightlyEnabled: true })).status, 401);
  assert.equal((await call(path, { aggregateNightlyEnabled: true }, tokens.operator)).status, 403);
  assert.equal((await call(path, { aggregateNightlyTime: '99:99' }, tokens.admin)).status, 400);
  const before = (await (await call(path, null, tokens.admin)).json()).settings;
  cleanup.restore = () => call(path, { aggregateNightlyEnabled: before.aggregateNightlyEnabled, aggregateNightlyTime: before.aggregateNightlyTime }, tokens.admin);
  const saved = await call(path, { aggregateNightlyEnabled: true, aggregateNightlyTime: '22:10' }, tokens.admin);
  assert.equal(saved.status, 200);
  const afterSave = (await (await call(path, null, tokens.admin)).json()).settings;
  assert.equal(afterSave.aggregateNightlyEnabled, true); assert.equal(afterSave.aggregateNightlyTime, '22:10');
  assert.equal(afterSave.nightlyEnabled, before.nightlyEnabled); assert.equal(afterSave.nightlyTime, before.nightlyTime);
  assert.ok(afterSave.aggregateNightlySchedule);
  const page = await fetch(`${base}/admin/reconciliation`); assert.equal(page.status, 200);
  assert.match(await page.text(), /control\.js/);
});

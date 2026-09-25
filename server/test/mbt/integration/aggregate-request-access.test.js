import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, beforeEach, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from '../../../src/server.js';
import { createOperator, getOperatorByToken, updateOperatorRoles, setOperatorActive, updateOperatorPassword } from '../../../src/auth-repository.js';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { aggregateDates, AGGREGATE_MATERIALS } from '../../../src/aggregate-request-domain.js';
import { createAggregateRequest, changeAggregateRequest, getAggregateRequesterWorkspace } from '../../../src/aggregate-request-repository.js';
import { listAggregateRequestAccess, updateAggregateRequestAccess } from '../../../src/aggregate-request-access-repository.js';

let server, base;
const accounts = {}, tokens = {};
const input = () => ({ yardLocationId: 1, serviceDate: aggregateDates().serviceDate, operationId: crypto.randomUUID(),
  loads: Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, m.code === 'gravel' ? 2 : 0])) });
const versions = result => Object.fromEntries(result.assignments.map(row => [row.yardLocationId, row.revision]));
async function http(path, name = 'admin', method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(name ? { authorization: `Bearer ${tokens[name]}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
async function assign(name, yards) {
  const snapshot = await listAggregateRequestAccess(accounts.admin);
  return updateAggregateRequestAccess(accounts[name].id, { yardLocationIds: yards, expectedRevisions: versions(snapshot) }, accounts.admin);
}
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, role] of [['admin', 'admin'], ['operator', 'operator'], ['other', 'operator'], ['sales', 'sales'], ['manager', 'yard_manager'], ['scm', 'scm']]) {
    accounts[name] = await createOperator({ username: `aggregate-access-${name}-${crypto.randomUUID()}`, displayName: name,
      password: 'aggregate-access-test', role, yardLocationIds: [15], operatorYardLocationIds: [28] });
    const login = await http('/api/auth/login', null, 'POST', { username: accounts[name].username, password: 'aggregate-access-test' });
    assert.equal(login.status, 200);
    tokens[name] = login.body.token;
  }
});
beforeEach(async () => {
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=NULL,revision=0,updated_by=NULL');
  await query('DELETE FROM aggregate_request_events');
  await query('DELETE FROM aggregate_request_lines');
  await query('DELETE FROM aggregate_requests');
});
after(async () => { if (server) { await new Promise(resolve => server.close(resolve)); } await closeDb(); });

test('only Admin can grant Aggregate access; ordinary yards and forged request grants cannot submit', async () => {
  assert.equal((await http('/api/admin/aggregate-request-access', null)).status, 401);
  for (const actor of [null, accounts.operator, { ...accounts.admin, publicSales: true }]) {
    await assert.rejects(() => listAggregateRequestAccess(actor), { code: 'AGGREGATE_ACCESS_ADMIN_REQUIRED' });
    await assert.rejects(() => updateAggregateRequestAccess(accounts.operator.id, {}, actor), { code: 'AGGREGATE_ACCESS_ADMIN_REQUIRED' });
  }
  for (const role of ['operator', 'sales', 'manager', 'scm']) {
    assert.equal((await http('/api/admin/aggregate-request-access', role)).status, 403);
    assert.equal((await http(`/api/admin/aggregate-request-access/${accounts[role].id}`, role, 'PUT', {})).status, 403);
    assert.equal((await http('/api/aggregate-requests', role, 'POST', { ...input(), aggregateRequestYardLocationIds: [1] })).status, 403);
  }
  assert.equal((await http('/api/aggregate-requests', 'admin', 'POST', input())).status, 403);
  assert.equal((await http('/api/scm/aggregate-requests', 'scm')).status, 200);
  const initial = await http('/api/admin/aggregate-request-access');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.assignments.length, 4);
  assert.ok(initial.body.assignments.every(row => row.operatorId === null));
});
test('independent grants reach existing sessions and leave normal roles and yards unchanged', async () => {
  for (const name of ['operator', 'sales', 'manager']) {
    await assign(name, [1]);
    const me = (await http('/api/auth/me', name)).body.operator;
    assert.deepEqual(me.aggregateRequestYardLocationIds, [1]);
    assert.deepEqual(me.yardLocationIds, [15]);
    assert.deepEqual(me.operatorYardLocationIds, [28]);
    assert.equal(me.role, accounts[name].role);
    const workspace = await http('/api/aggregate-requests/workspace', name);
    assert.equal(workspace.status, 200);
    assert.deepEqual(workspace.body.yards.map(row => row.locationId), [1]);
    assert.equal((await http('/api/aggregate-requests/workspace?yardLocationId=28', name)).status, 403);
  }
  assert.equal((await http('/api/aggregate-requests', 'operator', 'POST', input())).status, 403);
  assert.equal((await http('/api/aggregate-requests', 'manager', 'POST', input())).status, 201);
});
test('two concurrent Admin edits have one winner and one conflict with exactly one submitter', async () => {
  const expectedRevisions = versions(await listAggregateRequestAccess(accounts.admin));
  const results = await Promise.all(['operator', 'sales'].map(name => http(`/api/admin/aggregate-request-access/${accounts[name].id}`, 'admin', 'PUT', { yardLocationIds: [1], expectedRevisions })));
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  const stored = (await listAggregateRequestAccess(accounts.admin)).assignments.find(row => row.yardLocationId === 1);
  assert.equal(stored.revision, 1);
  assert.ok([accounts.operator.id, accounts.sales.id].includes(stored.operatorId));
  assert.equal((await query('SELECT count(*)::int AS count FROM aggregate_request_yard_assignments WHERE yard_location_id=1')).rows[0].count, 1);
});
test('hostile assignment payloads and ineligible targets leave all permissions unchanged', async () => {
  const snapshot = await listAggregateRequestAccess(accounts.admin), expectedRevisions = versions(snapshot);
  for (const yardLocationIds of [[999], ['1'], [1, 1], null, {}, [true]]) {
    assert.equal((await http(`/api/admin/aggregate-request-access/${accounts.operator.id}`, 'admin', 'PUT', { yardLocationIds, expectedRevisions })).status, 400);
  }
  for (const revision of [null, {}, { 1: -1, 28: 0, 15: 0, 26: 0 }, { 1: '0', 28: 0, 15: 0, 26: 0 }]) {
    assert.equal((await http(`/api/admin/aggregate-request-access/${accounts.operator.id}`, 'admin', 'PUT', { yardLocationIds: [1], expectedRevisions: revision })).status, 400);
  }
  assert.equal((await http(`/api/admin/aggregate-request-access/${accounts.scm.id}`, 'admin', 'PUT', { yardLocationIds: [1], expectedRevisions })).status, 400);
  assert.equal((await http('/api/admin/aggregate-request-access/missing', 'admin', 'PUT', { yardLocationIds: [1], expectedRevisions })).status, 404);
  await setOperatorActive(accounts.other.id, false);
  assert.equal((await http(`/api/admin/aggregate-request-access/${accounts.other.id}`, 'admin', 'PUT', { yardLocationIds: [1], expectedRevisions })).status, 400);
  await setOperatorActive(accounts.other.id, true);
  assert.deepEqual(await listAggregateRequestAccess(accounts.admin), snapshot);
});
test('revocation rejects stale actors and retries while preserving requests and SCM review', async () => {
  await assign('operator', [1]);
  const stale = await getOperatorByToken(tokens.operator), body = input();
  const created = await createAggregateRequest(body, stale);
  await assign('operator', []);
  await assert.rejects(() => createAggregateRequest(body, stale), { code: 'AGGREGATE_ACCESS_REQUIRED' });
  assert.equal((await http(`/api/aggregate-requests/${created.id}/edit`, 'operator', 'POST', { ...body, expectedRevision: 1 })).status, 403);
  assert.equal((await http(`/api/scm/aggregate-requests/${created.id}`, 'scm')).status, 200);
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_request_events')).rows[0].n, 1);
});
test('a submission waiting behind revocation is denied after the grant changes', async () => {
  await assign('operator', [1]);
  const stale = await getOperatorByToken(tokens.operator);
  let release, locked;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { locked = resolve; });
  const revoking = withTransaction(async () => {
    await query('UPDATE aggregate_request_yard_assignments SET operator_id=NULL WHERE yard_location_id=1');
    locked(); await gate;
  });
  await started;
  let finished = false;
  const attempt = createAggregateRequest(input(), stale).finally(() => { finished = true; });
  const rejection = assert.rejects(attempt, { status: 403, code: 'AGGREGATE_ACCESS_REQUIRED' });
  try { await delay(40); assert.equal(finished, false); } finally { release(); }
  await revoking; await rejection;
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_requests')).rows[0].n, 0);
});
test('an audit failure rolls back every assignment change', async () => {
  const snapshot = await listAggregateRequestAccess(accounts.admin);
  await query(`CREATE FUNCTION pg_temp.reject_aggregate_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='aggregate_access.updated' THEN RAISE EXCEPTION 'access audit failed'; END IF; RETURN NEW; END $$`);
  await query('CREATE TRIGGER aggregate_access_test_failure BEFORE INSERT ON delivery_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_aggregate_access_audit()');
  try { await assert.rejects(() => assign('operator', [1, 28]), /access audit failed/); }
  finally { await query('DROP TRIGGER aggregate_access_test_failure ON delivery_audit_log'); }
  assert.deepEqual(await listAggregateRequestAccess(accounts.admin), snapshot);
});
test('changing an account role preserves separate grant data but cannot retain submission authority', async () => {
  await assign('other', [1]);
  await updateOperatorRoles(accounts.other.id, { role: 'dispatcher', roles: ['dispatcher'], operatorYardLocationIds: [28], yardLocationIds: [15] });
  assert.deepEqual((await getOperatorByToken(tokens.other)).aggregateRequestYardLocationIds, [1]);
  assert.equal((await http('/api/aggregate-requests', 'other', 'POST', input())).status, 403);
  await updateOperatorRoles(accounts.other.id, { role: 'operator', roles: ['operator'] });
});

test('reassignment rejects former submitter retries and edits even when the old session claimed access', async () => {
  await assign('operator', [1]);
  const stale = await getOperatorByToken(tokens.operator), body = input();
  const row = await createAggregateRequest(body, stale);
  await assign('other', [1]);
  await assert.rejects(() => createAggregateRequest(body, stale), { code: 'AGGREGATE_ACCESS_REQUIRED' });
  await assert.rejects(() => changeAggregateRequest(row.id, 'edit', { ...body, operationId: crypto.randomUUID(), expectedRevision: row.revision }, stale), { code: 'AGGREGATE_ACCESS_REQUIRED' });
  const view = (await http('/api/aggregate-requests/workspace', 'other')).body;
  assert.equal(view.request.id, row.id);
  assert.equal(view.request.requestedBy, stale.id);
  const denied = await http(`/api/aggregate-requests/${row.id}/edit`, 'other', 'POST', { ...body, expectedRevision: row.revision });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'AGGREGATE_OWNER_REQUIRED');
});

test('workspace selects the oldest outstanding request, respects the yard and clears resolved past requests', async () => {
  await assign('operator', [1, 28]);
  const actor = await getOperatorByToken(tokens.operator);
  const earlier = new Date(Date.now() - 5 * 86400000);
  const old = await createAggregateRequest({ ...input(), yardLocationId: 28, serviceDate: aggregateDates(earlier).serviceDate }, actor, { now: earlier });
  const current = await createAggregateRequest(input(), actor);
  assert.equal((await getAggregateRequesterWorkspace(actor)).request.id, old.id);
  assert.equal((await getAggregateRequesterWorkspace(actor, { yardLocationId: '1' })).request.id, current.id);
  const confirmed = await changeAggregateRequest(old.id, 'confirm', { expectedRevision: old.revision, loads: input().loads, operationId: crypto.randomUUID() }, accounts.scm);
  assert.equal((await getAggregateRequesterWorkspace(actor)).request.status, 'confirmed');
  await changeAggregateRequest(old.id, 'report', { expectedRevision: confirmed.revision, loads: input().loads, operationId: crypto.randomUUID() }, actor);
  assert.equal((await getAggregateRequesterWorkspace(actor)).request.id, current.id);
  assert.equal((await getAggregateRequesterWorkspace(actor, { yardLocationId: 28 })).request, null);
  await changeAggregateRequest(current.id, 'reject', { expectedRevision: current.revision, reason: 'Yard closed', operationId: crypto.randomUUID() }, accounts.scm);
  assert.equal((await getAggregateRequesterWorkspace(actor)).request, null);
  const tomorrow = new Date(Date.now() + 86400000);
  assert.equal((await getAggregateRequesterWorkspace(actor, {}, { now: tomorrow })).request, null);
});

test('password reset preserves independent grants and normal yards while invalidating the old session', async () => {
  await assign('sales', [1]);
  const changed = await updateOperatorPassword(accounts.sales.id, 'aggregate-access-new-password');
  assert.deepEqual(changed.aggregateRequestYardLocationIds, [1]);
  assert.deepEqual(changed.yardLocationIds, [15]);
  assert.equal(await getOperatorByToken(tokens.sales), null);
  const login = await http('/api/auth/login', null, 'POST', { username: accounts.sales.username, password: 'aggregate-access-new-password' });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.operator.aggregateRequestYardLocationIds, [1]);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { createOperator } from '../../../src/auth-repository.js';
import { closeDb, query } from '../../../src/db.js';
import { aggregateDates, AGGREGATE_MATERIALS } from '../../../src/aggregate-request-domain.js';
import { createAggregateRequest } from '../../../src/aggregate-request-repository.js';

const actors = {};
const tokens = {};
let server;
let base;
const loads = (n = 3) => Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, m.code === 'gravel' ? n : 0]));
async function http(path, role, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    ...(role ? { authorization: `Bearer ${tokens[role]}` } : { 'x-mbbs-sales-public': '1' }),
    'content-type': 'application/json'
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
before(async () => {
  await query('DELETE FROM aggregate_request_events');
  await query('DELETE FROM aggregate_request_lines');
  await query('DELETE FROM aggregate_requests');
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=NULL');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, role, yards, operatorYards] of [
    ['sales', 'sales', [1, 28], []], ['other', 'sales', [1], []], ['operator', 'operator', [], [15]],
    ['manager', 'yard_manager', [26], []], ['scm', 'scm', [], []], ['dispatcher', 'dispatcher', [], []], ['empty', 'operator', [], []]
  ]) {
    const username = `aggregate-http-${name}-${crypto.randomUUID()}`;
    actors[name] = await createOperator({ username, displayName: name, password: 'aggregate-test-password', role, yardLocationIds: yards, operatorYardLocationIds: operatorYards });
    const granted = name === 'sales' ? [1, 28] : name === 'operator' ? [15] : name === 'manager' ? [26] : [];
    actors[name].aggregateRequestYardLocationIds = granted;
    await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id=ANY($2::int[])', [actors[name].id, granted]);
    const login = await http('/api/auth/login', null, 'POST', { username, password: 'aggregate-test-password' });
    assert.equal(login.status, 200);
    tokens[name] = login.body.token;
  }
});
after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await closeDb();
});

test('confirmation date HTTP validates the optional field and keeps requester writes and retries compatible', async () => {
  const created = await http('/api/aggregate-requests', 'operator', 'POST', {
    yardLocationId: 15, serviceDate: aggregateDates().serviceDate, loads: loads(), operationId: crypto.randomUUID()
  });
  assert.equal(created.status, 201);
  const row = created.body;
  const path = `/api/scm/aggregate-requests/${row.id}/confirm`;
  const body = { expectedRevision: row.revision, serviceDate: '2028-02-29', loads: loads(8), operationId: crypto.randomUUID() };
  for (const role of [null, 'sales', 'operator', 'dispatcher']) {
    assert.equal((await http(path, role, 'POST', body)).status, role ? 403 : 401);
  }
  const invalid = await http(path, 'scm', 'POST', { ...body, serviceDate: '2027-02-29' });
  assert.equal(invalid.status, 400);
  const saved = await http(path, 'scm', 'POST', body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.serviceDate, '2028-02-29');
  assert.equal(saved.body.reportDueDate, '2028-03-01');
  assert.deepEqual((await http(path, 'scm', 'POST', body)).body, saved.body);
  const legacy = await http(path, 'scm', 'POST', { expectedRevision: saved.body.revision, loads: loads(7), operationId: crypto.randomUUID() });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.serviceDate, '2028-02-29');
  const fetched = await http(`/api/aggregate-requests/${row.id}`, 'operator');
  assert.equal(fetched.body.reportDueDate, '2028-03-01');
  assert.equal(fetched.body.createdAt, row.createdAt);
  assert.equal((await http(`/api/scm/aggregate-requests/${row.id}/report`, 'scm', 'POST', {
    expectedRevision: legacy.body.revision, loads: loads(7), operationId: crypto.randomUUID()
  })).status, 200);
});
test('aggregate APIs require staff and enforce requester/SCM boundaries', async () => {
  assert.equal((await http('/api/aggregate-requests')).status, 401);
  for (const role of ['dispatcher', 'empty']) { assert.equal((await http('/api/aggregate-requests', role)).status, 403); }
  assert.equal((await http('/api/scm/aggregate-requests', 'sales')).status, 403);
  assert.equal((await http('/api/scm/aggregate-requests', 'dispatcher')).status, 403);
  for (const [role, yard] of [['sales', 1], ['operator', 15], ['manager', 26]]) {
    const listing = await http('/api/aggregate-requests', role);
    assert.equal(listing.status, 200);
    const created = await http('/api/aggregate-requests', role, 'POST', {
      yardLocationId: yard, serviceDate: listing.body.serviceDate, loads: loads(), operationId: crypto.randomUUID()
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await http(`/api/aggregate-requests/${created.body.id}`, 'scm')).status, 200);
    assert.equal((await http(`/api/aggregate-requests/${created.body.id}`, role === 'sales' ? 'operator' : 'sales')).status, 403);
    assert.equal((await http(`/api/aggregate-requests/${created.body.id}/confirm`, role, 'POST', {})).status, 404);
    assert.equal((await http(`/api/aggregate-requests/${created.body.id}/report`, role, 'POST', {
      expectedRevision: created.body.revision, loads: loads(), operationId: crypto.randomUUID()
    })).status, 409, 'SCM confirmation is still required before reporting.');
    const confirmed = await http(`/api/scm/aggregate-requests/${created.body.id}/confirm`, 'scm', 'POST', {
      expectedRevision: created.body.revision, loads: loads(), operationId: crypto.randomUUID()
    });
    assert.equal(confirmed.status, 200);
    assert.ok(confirmed.body.reportDueDate > aggregateDates().today);
    const reportBody = { expectedRevision: confirmed.body.revision, loads: loads(), operationId: crypto.randomUUID() };
    const reported = await http(`/api/aggregate-requests/${created.body.id}/report`, role, 'POST', reportBody);
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    assert.equal(reported.body.status, 'reported');
    assert.deepEqual((await http(`/api/aggregate-requests/${created.body.id}/report`, role, 'POST', reportBody)).body, reported.body);
  }
});
test('HTTP overdue gate, proxy actuals, variance review and retry responses persist', async () => {
  const earlier = new Date(Date.now() - 3 * 86400000);
  const pending = await createAggregateRequest({ yardLocationId: 28, serviceDate: aggregateDates(earlier).serviceDate, loads: loads(), operationId: crypto.randomUUID() }, actors.sales, { now: earlier });
  const newBody = { yardLocationId: 28, serviceDate: aggregateDates().serviceDate, loads: loads(1), operationId: crypto.randomUUID() };
  const blocked = await http('/api/aggregate-requests', 'sales', 'POST', newBody);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'AGGREGATE_REPORT_REQUIRED');
  assert.deepEqual(blocked.body.blockingRequestIds, [pending.id]);
  const confirmation = await http(`/api/scm/aggregate-requests/${pending.id}/confirm`, 'scm', 'POST', {
    expectedRevision: pending.revision, loads: loads(3), operationId: crypto.randomUUID()
  });
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
  const reportBody = { expectedRevision: confirmation.body.revision, loads: loads(2), operationId: crypto.randomUUID() };
  const report = await http(`/api/scm/aggregate-requests/${pending.id}/report`, 'scm', 'POST', reportBody);
  assert.equal(report.status, 200);
  assert.equal(report.body.needsReview, true);
  assert.deepEqual((await http(`/api/scm/aggregate-requests/${pending.id}/report`, 'scm', 'POST', reportBody)).body, report.body);
  assert.equal((await http('/api/aggregate-requests', 'sales', 'POST', newBody)).status, 201);
  const queue = await http('/api/scm/aggregate-requests?queue=needs_review', 'scm');
  assert.equal(queue.body.needsReviewCount, 1);
  assert.equal(queue.body.requests[0].id, pending.id);
  const acknowledged = await http(`/api/scm/aggregate-requests/${pending.id}/acknowledge`, 'scm', 'POST', {
    expectedRevision: report.body.revision, operationId: crypto.randomUUID()
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.needsReview, false);
  assert.equal((await http(`/api/scm/aggregate-requests/${pending.id}/confirm`, 'scm', 'POST', {
    expectedRevision: acknowledged.body.revision, operationId: crypto.randomUUID(), loads: loads()
  })).status, 409);
});

test('HTTP material memos are SCM-only, persist on completed requests and keep loads unchanged', async () => {
  const listing = await http('/api/scm/aggregate-requests?yardLocationId=1', 'scm');
  const row = listing.body.requests[0];
  const memos = Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, m.code === 'gravel' ? 'Afternoon delivery 下午送货' : '']));
  const command = { expectedRevision: row.revision, memos, operationId: crypto.randomUUID() };
  assert.equal((await http(`/api/scm/aggregate-requests/${row.id}/memo`, 'sales', 'POST', command)).status, 403);
  assert.equal((await http(`/api/aggregate-requests/${row.id}/memo`, 'sales', 'POST', command)).status, 404);
  assert.equal((await http(`/api/scm/aggregate-requests/${row.id}/memo`, null, 'POST', command)).status, 401);
  const saved = await http(`/api/scm/aggregate-requests/${row.id}/memo`, 'scm', 'POST', command);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.lines[0].scmMemo, memos.gravel);
  assert.equal(saved.body.status, row.status);
  assert.deepEqual(saved.body.lines.map(({ scmMemo: _memo, ...line }) => line), row.lines.map(({ scmMemo: _memo, ...line }) => line));
  const reloaded = await http(`/api/scm/aggregate-requests/${row.id}`, 'scm');
  assert.equal(reloaded.body.lines[0].scmMemo, memos.gravel);
  assert.equal(reloaded.body.events.at(-1).action, 'memo');
});

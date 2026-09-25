import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { before, beforeEach, after } from 'node:test';
import fc from 'fast-check';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { AGGREGATE_MATERIALS } from '../../../src/aggregate-request-domain.js';
import { createAggregateRequest, changeAggregateRequest, getAggregateRequest, listAggregateRequests, getAggregateRequesterWorkspace } from '../../../src/aggregate-request-repository.js';

const suffix = crypto.randomUUID();
const sales = { id: `aggregate-sales-${suffix}`, role: 'sales', yardLocationIds: [1, 28], aggregateRequestYardLocationIds: [1, 28] };
const other = { ...sales, id: `aggregate-other-${suffix}` };
const scm = { id: `aggregate-scm-${suffix}`, role: 'scm' };
const monday = new Date('2026-09-21T12:00:00Z');
const wednesday = new Date('2026-09-23T12:00:00Z');
const loads = (gravel = 3, soil = 0) => Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, m.code === 'gravel' ? gravel : m.code === 'dump_soil' ? soil : 0]));
const body = (overrides = {}) => ({ operationId: crypto.randomUUID(), yardLocationId: 1, serviceDate: '2026-09-22', loads: loads(), ...overrides });
const create = (input = body(), actor = sales, now = monday) => createAggregateRequest(input, actor, { now });
const change = (row, action, input = {}, actor = scm, now = wednesday) => changeAggregateRequest(row.id, action, { operationId: crypto.randomUUID(), expectedRevision: row.revision, ...input }, actor, { now });

before(async () => {
  for (const actor of [sales, other, scm]) {
    await query(`INSERT INTO operators (id, username, display_name, password_hash, password_salt, role, roles)
      VALUES ($1,$1,$1,'test','test',$2,ARRAY[$2]::text[])`, [actor.id, actor.role]);
  }
});
beforeEach(async () => {
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=NULL');
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id IN (1,28)', [sales.id]);
  // A fresh feature namespace per test; no existing business records are changed.
  if ((await query("SELECT to_regclass('aggregate_requests') AS table_name")).rows[0].table_name) {
    await query('DELETE FROM aggregate_request_events');
    await query('DELETE FROM aggregate_request_lines');
    await query('DELETE FROM aggregate_requests');
  }
});
after(closeDb);

test('confirmation date persists both dates, audit snapshots, retry identity and yard blocking', async () => {
  const pending = await create();
  const input = { expectedRevision: pending.revision, operationId: crypto.randomUUID(), loads: loads(7), serviceDate: '2028-02-29' };
  const confirmed = await changeAggregateRequest(pending.id, 'confirm', input, scm, { now: wednesday });
  const saved = await getAggregateRequest(pending.id, sales);
  assert.equal(saved.serviceDate, '2028-02-29');
  assert.equal(saved.reportDueDate, '2028-03-01');
  assert.equal(saved.createdAt, pending.createdAt);
  assert.equal(saved.lines[0].requestedLoads, pending.lines[0].requestedLoads);
  assert.equal(saved.lines[0].confirmedLoads, 7);
  assert.equal(saved.events.at(-1).before.serviceDate, pending.serviceDate);
  assert.equal(saved.events.at(-1).after.serviceDate, '2028-02-29');
  assert.equal(saved.events.at(-1).after.reportDueDate, '2028-03-01');
  assert.equal((await getAggregateRequesterWorkspace(sales, { yardLocationId: 1 }, { now: monday })).request.serviceDate, '2028-02-29');
  assert.equal((await listAggregateRequests(scm, { serviceDate: '2028-02-29' })).requests[0].id, pending.id);
  assert.deepEqual(await changeAggregateRequest(pending.id, 'confirm', input, scm), confirmed);
  await assert.rejects(() => changeAggregateRequest(pending.id, 'confirm', { ...input, serviceDate: '2028-03-02' }, scm), { code: 'AGGREGATE_RETRY_CONFLICT' });
  await assert.rejects(() => create(), { code: 'AGGREGATE_ACTIVE_REQUEST_EXISTS' });
  const revised = await change(confirmed, 'confirm', { serviceDate: '2029-12-31', loads: loads(8) });
  assert.equal((await getAggregateRequest(revised.id, sales)).reportDueDate, '2030-01-01');
});

test('confirmation date invalid writes and stale saves preserve the complete saved request', async () => {
  const pending = await create();
  const snapshotBefore = await getAggregateRequest(pending.id, scm);
  for (const serviceDate of [null, '', '2027-02-29', '2026-04-31', '0000-01-01', '9999-12-31']) {
    await assert.rejects(() => change(pending, 'confirm', { serviceDate, loads: loads(9) }), { status: 400 });
    assert.deepEqual(await getAggregateRequest(pending.id, scm), snapshotBefore);
  }
  const confirmed = await change(pending, 'confirm', { serviceDate: '2028-02-29', loads: loads(4) });
  const snapshot = await getAggregateRequest(confirmed.id, scm);
  await assert.rejects(() => change(pending, 'confirm', { serviceDate: '2029-02-28', loads: loads(5) }), { code: 'AGGREGATE_STALE_REVISION' });
  assert.deepEqual(await getAggregateRequest(confirmed.id, scm), snapshot);
});

test('confirmation date races save one matching date and quantity set', async () => {
  const pending = await create();
  const commands = [{ serviceDate: '2028-02-29', loads: loads(4) }, { serviceDate: '2029-12-31', loads: loads(9) }];
  const results = await Promise.allSettled(commands.map(input => change(pending, 'confirm', input)));
  const winners = results.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AGGREGATE_STALE_REVISION');
  const saved = await getAggregateRequest(pending.id, scm);
  const winningInput = commands.find(input => input.serviceDate === saved.serviceDate);
  assert.ok(winningInput, 'A complete selected schedule must be persisted.');
  assert.equal(saved.lines[0].confirmedLoads, winningInput.loads.gravel);
  assert.equal(Date.parse(saved.reportDueDate) - Date.parse(saved.serviceDate), 86400000);
  assert.equal(saved.events.length, 2);
});

test('creates seven local lines and enforces yard access and server-derived dates', async () => {
  const row = await create();
  assert.match(row.requestRef, /^AGG-\d+$/);
  assert.equal(row.reportDueDate, '2026-09-23');
  assert.equal(row.lines.length, 7);
  assert.equal(row.lines[0].requestedLoads, 3);
  assert.equal(row.lines[0].confirmedLoads, null);
  await assert.rejects(() => create(body({ yardLocationId: 15 })), { status: 403 });
  await assert.rejects(() => create(body({ serviceDate: '2026-09-23' })), { status: 409, code: 'AGGREGATE_DATE_CHANGED' });
  await assert.rejects(() => create(body({ yardLocationId: 28 }), scm), { status: 403 });
  await assert.rejects(() => getAggregateRequest(row.id, { ...sales, aggregateRequestYardLocationIds: [28] }), { status: 403 });
});
test('same operation retries return the saved result; changed payloads are rejected', async () => {
  const input = body();
  const first = await create(input);
  const retry = await create(input);
  assert.deepEqual(retry, first);
  await assert.rejects(() => create({ ...input, loads: loads(4) }), { status: 409, code: 'AGGREGATE_RETRY_CONFLICT' });
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_requests')).rows[0].n, 1);
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_request_events')).rows[0].n, 1);
});
test('two independent submissions by the designated requester create exactly one unfinished request', async () => {
  const results = await Promise.allSettled([create(body(), sales), create(body(), sales)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.equal(failure.reason.code, 'AGGREGATE_ACTIVE_REQUEST_EXISTS');
  assert.equal(failure.reason.requestId, results.find(result => result.status === 'fulfilled').value.id);
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_requests')).rows[0].n, 1);
});
test('unconfirmed requests keep their yard blocked after submitter reassignment', async () => {
  const pending = await create();
  const next = () => body({ serviceDate: '2026-09-24' });
  await assert.rejects(() => create(next(), sales, wednesday), { status: 409, code: 'AGGREGATE_REPORT_REQUIRED' });
  await create({ ...next(), yardLocationId: 28 }, sales, wednesday);
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id=1', [other.id]);
  await assert.rejects(() => create(next(), other, wednesday), { status: 409, code: 'AGGREGATE_ACTIVE_REQUEST_EXISTS', requestId: pending.id });
  await query('UPDATE aggregate_request_yard_assignments SET operator_id=$1 WHERE yard_location_id=1', [sales.id]);
  const listing = await listAggregateRequests(sales, {}, { now: wednesday });
  assert.equal(listing.blockers.length, 1);
  assert.equal(listing.blockers[0].id, pending.id);
  assert.equal(listing.blockers[0].status, 'submitted');
});

test('a completed acknowledged request permits a fresh same-date request without changing its history', async () => {
  const originalInput = body();
  const first = await create(originalInput);
  const confirmed = await change(first, 'confirm', { loads: loads(3) }, scm, monday);
  const reported = await change(confirmed, 'report', { loads: loads(1) }, sales, monday);
  await change(reported, 'acknowledge', {}, scm, monday);
  const completed = await getAggregateRequest(first.id, sales);
  const next = await create(body({ loads: loads(5) }));
  assert.notEqual(next.id, first.id);
  assert.equal(next.serviceDate, first.serviceDate);
  assert.equal(next.status, 'submitted');
  assert.equal(next.lines[0].requestedLoads, 5);
  assert.deepEqual(await getAggregateRequest(first.id, sales), completed);
  assert.deepEqual(completed.events.map(event => event.action), ['submit', 'confirm', 'report', 'acknowledge']);
  assert.deepEqual(await create(originalInput), first, 'A retry of the completed submission cannot become another request.');
  assert.equal((await getAggregateRequesterWorkspace(sales, { yardLocationId: 1 }, { now: monday })).request.id, next.id);
  assert.equal((await listAggregateRequests(scm, { queue: 'history' })).requests[0].id, first.id);
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_requests')).rows[0].n, 2);
});

test('an unfinished request blocks the following service date before the actual-report due date', async () => {
  const pending = await create();
  const tuesday = new Date('2026-09-22T12:00:00Z');
  await assert.rejects(() => create(body({ serviceDate: '2026-09-23' }), sales, tuesday), {
    status: 409, code: 'AGGREGATE_ACTIVE_REQUEST_EXISTS', requestId: pending.id
  });
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_requests')).rows[0].n, 1);
});

test('concurrent fresh submissions after completion create one new request and retain the completed one', async () => {
  const confirmed = await change(await create(), 'confirm', { loads: loads() }, scm, monday);
  const reported = await change(confirmed, 'report', { loads: loads() }, sales, monday);
  const completed = await getAggregateRequest(reported.id, sales);
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => create()));
  const winners = results.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result =>
    result.reason.code === 'AGGREGATE_ACTIVE_REQUEST_EXISTS' && result.reason.requestId === winners[0].value.id));
  assert.deepEqual(await getAggregateRequest(reported.id, sales), completed);
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_requests')).rows[0].n, 2);
});

test('property: only unfinished requests occupy a yard; terminal history and retries survive another submission', async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom('submitted', 'confirmed', 'reported', 'rejected'),
    fc.constantFrom(1, 28), fc.boolean(), fc.boolean(), async (status, yardLocationId, laterDate, shortage) => {
      await withTransaction(async () => {
        const originalInput = body({ yardLocationId });
        const original = await create(originalInput);
        let row = original;
        if (['confirmed', 'reported'].includes(status)) { row = await change(row, 'confirm', { loads: loads() }, scm, monday); }
        if (status === 'reported') { row = await change(row, 'report', { loads: loads(shortage ? 1 : 3) }, sales, monday); }
        if (status === 'rejected') { row = await change(row, 'reject', { reason: 'No supply' }, scm, monday); }
        const view = await getAggregateRequesterWorkspace(sales, { yardLocationId }, { now: monday });
        const open = ['submitted', 'confirmed'].includes(status);
        assert.equal(view.request?.id ?? null, open ? row.id : null);
        const date = laterDate ? '2026-09-23' : '2026-09-22';
        const clock = laterDate ? new Date('2026-09-22T12:00:00Z') : monday;
        const next = () => create(body({ yardLocationId, serviceDate: date }), sales, clock);
        if (open) { await assert.rejects(next, { status: 409, code: 'AGGREGATE_ACTIVE_REQUEST_EXISTS', requestId: row.id }); }
        else { assert.notEqual((await next()).id, row.id); }
        assert.deepEqual(await create(originalInput), original);
        assert.equal((await getAggregateRequest(row.id, sales)).status, status);
      }, { rollback: true });
    }), { seed: 20260926, numRuns: 40 });
});
test('reporting a shortage releases the gate while persisting SCM Needs Review', async () => {
  const row = await change(await create(), 'confirm', { loads: loads(3, 2) });
  await assert.rejects(() => create(body({ serviceDate: '2026-09-24' }), sales, wednesday), { code: 'AGGREGATE_REPORT_REQUIRED' });
  const report = await change(row, 'report', { loads: loads(2, 1) }, sales);
  assert.equal(report.needsReview, true);
  assert.equal(report.reportedBy, sales.id);
  await create(body({ serviceDate: '2026-09-24' }), sales, wednesday);
  const listing = await listAggregateRequests(scm, { queue: 'needs_review' }, { now: wednesday });
  assert.equal(listing.requests.length, 1);
  assert.equal(listing.needsReviewCount, 1);
  const acknowledged = await change(report, 'acknowledge');
  assert.equal(acknowledged.needsReview, false);
  assert.equal((await listAggregateRequests(scm, { queue: 'needs_review' })).requests.length, 0);
  assert.equal(acknowledged.lines[0].actualLoads, 2);
});
test('SCM rejection resolves a pending block and is audited', async () => {
  const row = await create();
  const rejected = await change(row, 'reject', { reason: 'No availability' });
  assert.equal(rejected.status, 'rejected');
  await create(body({ serviceDate: '2026-09-24' }), sales, wednesday);
  const detail = await getAggregateRequest(row.id, sales);
  assert.deepEqual(detail.events.map(event => event.action), ['submit', 'reject']);
  assert.equal(detail.events[1].actorId, scm.id);
  assert.equal(detail.events[1].reason, 'No availability');
});
test('competing confirmations use revisions; only one update and audit record commits', async () => {
  const row = await create();
  const results = await Promise.allSettled([change(row, 'confirm', { loads: loads(4) }), change(row, 'confirm', { loads: loads(5) })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AGGREGATE_STALE_REVISION');
  const detail = await getAggregateRequest(row.id, scm);
  assert.equal(detail.revision, 2);
  assert.equal(detail.events.length, 2);
  assert.equal(detail.lines[0].requestedLoads, 3);
});
test('SCM proxy reporting and correction record the actor and reset review', async () => {
  const row = await change(await create(), 'confirm', { loads: loads() });
  const report = await change(row, 'report', { loads: loads(1) });
  const acknowledged = await change(report, 'acknowledge');
  const corrected = await change(acknowledged, 'correct', { loads: loads(2), reason: 'Second load ticket found' });
  assert.equal(corrected.reportedBy, scm.id);
  assert.equal(corrected.needsReview, true);
  assert.equal(corrected.acknowledgedAt, null);
  const detail = await getAggregateRequest(row.id, sales);
  assert.equal(detail.events.at(-1).reason, 'Second load ticket found');
  assert.equal(detail.events.at(-1).before.lines[0].actualLoads, 1);
  assert.equal(detail.events.at(-1).after.lines[0].actualLoads, 2);
});
test('invalid writes cannot partially replace lines or append audit events', async () => {
  const row = await create();
  await assert.rejects(() => change(row, 'confirm', { loads: { ...loads(), dump_soil: -1 } }), { status: 400 });
  const saved = await getAggregateRequest(row.id, scm);
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.revision, 1);
  assert(saved.lines.every(line => line.confirmedLoads === null));
  assert.equal(saved.events.length, 1);
});

test('an audit insertion failure rolls back both header and all material quantities', async () => {
  const row = await create();
  await query("ALTER TABLE aggregate_request_events ADD CONSTRAINT aggregate_test_event_failure CHECK (action <> 'confirm') NOT VALID");
  try {
    await assert.rejects(() => change(row, 'confirm', { loads: loads(6) }), { code: '23514' });
  } finally {
    await query('ALTER TABLE aggregate_request_events DROP CONSTRAINT aggregate_test_event_failure');
  }
  const detail = await getAggregateRequest(row.id, scm);
  assert.equal(detail.status, 'submitted');
  assert.equal(detail.revision, 1);
  assert(detail.lines.every(line => line.confirmedLoads === null));
  assert.equal(detail.events.length, 1);
});

test('reporting and SCM revision racing cannot change confirmation underneath a report', async () => {
  const confirmed = await change(await create(), 'confirm', { loads: loads(3) });
  const results = await Promise.allSettled([
    change(confirmed, 'report', { loads: loads(2) }, sales),
    change(confirmed, 'confirm', { loads: loads(4) })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AGGREGATE_STALE_REVISION');
  const row = await getAggregateRequest(confirmed.id, scm);
  assert.equal(row.revision, 3);
  if (row.status === 'reported') {
    assert.equal(row.lines[0].confirmedLoads, 3);
    assert.equal(row.lines[0].actualLoads, 2);
  } else {
    assert.equal(row.lines[0].confirmedLoads, 4);
    assert.equal(row.lines[0].actualLoads, null);
  }
  assert.equal(row.events.length, 3);
});

test('25 identical concurrent retries produce one durable submission', async () => {
  const input = body();
  const responses = await Promise.all(Array.from({ length: 25 }, () => create(input)));
  assert.equal(new Set(responses.map(row => row.id)).size, 1);
  assert.equal((await query('SELECT count(*)::int AS n FROM aggregate_request_events')).rows[0].n, 1);
});

test('a detail read waiting on confirmation returns matching header, quantities, and audit history', async () => {
  const pending = await create();
  let release;
  let changed;
  const commit = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { changed = resolve; });
  const writer = withTransaction(async () => {
    await change(pending, 'confirm', { loads: loads(8) });
    changed();
    await commit;
  });
  await ready;
  const reading = getAggregateRequest(pending.id, scm);
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const result = await query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%aggregate_requests%' AND pid<>pg_backend_pid()");
      waiting = result.rows[0].n > 0;
      if (!waiting) { await delay(10); }
    }
    assert.equal(waiting, true, 'The read must overlap the uncommitted confirmation.');
  } finally {
    release();
    await writer;
  }
  const detail = await reading;
  assert.equal(detail.status, 'confirmed');
  assert.equal(detail.revision, 2);
  assert.equal(detail.lines[0].confirmedLoads, 8);
  assert.deepEqual(detail.lines, detail.events.at(-1).after.lines);
});

test('filters, pagination and malformed identifiers enforce their API contracts', async () => {
  const row = await create();
  assert.equal((await listAggregateRequests(sales, { yardLocationId: '1', serviceDate: '2026-09-22', queue: 'pending' })).requests[0].id, row.id);
  assert.equal((await listAggregateRequests(sales, { yardLocationId: '28' })).requests.length, 0);
  assert.equal((await listAggregateRequests(sales, { offset: 50 })).requests.length, 0);
  for (const filters of [{ yardLocationId: 15 }, { serviceDate: '2026-02-30' }, { serviceDate: 'oops' }, { queue: 'unknown' }, { offset: -1 }]) {
    await assert.rejects(() => listAggregateRequests(sales, filters));
  }
  await assert.rejects(() => getAggregateRequest(0, sales), { status: 400 });
  await assert.rejects(() => getAggregateRequest(9000000000, sales), { status: 404 });
  await assert.rejects(() => create(body({ operationId: 'bad' })), { status: 400 });
});

test('a former SCM user cannot replay a privileged action after losing SCM authority', async () => {
  const row = await create();
  const input = { expectedRevision: row.revision, loads: loads(4), operationId: crypto.randomUUID() };
  await changeAggregateRequest(row.id, 'confirm', input, scm, { now: wednesday });
  await assert.rejects(() => changeAggregateRequest(row.id, 'confirm', input, { ...scm, role: 'sales', aggregateRequestYardLocationIds: [1] }), {
    status: 403, code: 'AGGREGATE_SCM_REQUIRED'
  });
  assert.equal((await getAggregateRequest(row.id, scm)).events.length, 2);
});

test('SCM memo saves persist per material, retry once, reject stale edits and roll back with audit failure', async () => {
  const row = await create();
  const memos = Object.fromEntries(AGGREGATE_MATERIALS.map(m => [m.code, `${m.label}\n备注 <text>`]));
  const command = { expectedRevision: row.revision, memos, operationId: crypto.randomUUID() };
  const saved = await changeAggregateRequest(row.id, 'memo', command, scm);
  assert.deepEqual(saved.lines.map(line => line.scmMemo), AGGREGATE_MATERIALS.map(m => memos[m.code]));
  assert.deepEqual(await changeAggregateRequest(row.id, 'memo', command, scm), saved);
  await assert.rejects(() => changeAggregateRequest(row.id, 'memo', { ...command, memos: { ...memos, gravel: 'Different' } }, scm), { code: 'AGGREGATE_RETRY_CONFLICT' });
  await assert.rejects(() => changeAggregateRequest(row.id, 'memo', { ...command, operationId: crypto.randomUUID() }, scm), { code: 'AGGREGATE_STALE_REVISION' });
  await assert.rejects(() => changeAggregateRequest(row.id, 'memo', command, { ...scm, role: 'sales', aggregateRequestYardLocationIds: [1] }), { code: 'AGGREGATE_SCM_REQUIRED' });
  const detail = await getAggregateRequest(row.id, scm);
  assert.equal(detail.events.at(-1).action, 'memo');
  assert.equal(detail.events.at(-1).before.lines[0].scmMemo, '');
  assert.equal(detail.events.at(-1).after.lines[0].scmMemo, memos.gravel);
  await query("ALTER TABLE aggregate_request_events ADD CONSTRAINT aggregate_test_memo_failure CHECK (action <> 'memo') NOT VALID");
  try { await assert.rejects(() => change(saved, 'memo', { memos: { ...memos, gravel: 'Should roll back' } }), { code: '23514' }); }
  finally { await query('ALTER TABLE aggregate_request_events DROP CONSTRAINT aggregate_test_memo_failure'); }
  assert.deepEqual(await getAggregateRequest(row.id, scm), detail);
  const competing = await Promise.allSettled(['First', 'Second'].map(value => change(saved, 'memo', { memos: { ...memos, gravel: value } })));
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'AGGREGATE_STALE_REVISION');
});

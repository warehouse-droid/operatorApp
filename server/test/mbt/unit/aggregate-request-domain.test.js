import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {
  AGGREGATE_MATERIALS, aggregateDates, aggregateYardsForActor, aggregateCanManage,
  assertAggregateYard, normalizeAggregateLoads, transitionAggregateRequest
} from '../../../src/aggregate-request-domain.js';

const keys = ['gravel', 'hpb', 'screening', 'crusher_run', 'dump_concrete', 'dump_asphalt', 'dump_soil'];
const loads = (overrides = {}) => ({ ...Object.fromEntries(keys.map(key => [key, 0])), ...overrides });
const memos = (overrides = {}) => ({ ...Object.fromEntries(keys.map(key => [key, ''])), ...overrides });
const sales = { id: 'sales', roles: ['sales'], yardLocationIds: [1], aggregateRequestYardLocationIds: [1] };
const scm = { id: 'scm', role: 'scm' };
const now = new Date('2026-09-23T12:00:00Z');
function fixture(overrides = {}) {
  return {
    id: 1, yardLocationId: 1, requestedBy: 'sales', serviceDate: '2026-09-22', reportDueDate: '2026-09-23',
    revision: 1, status: 'submitted', remarks: '', needsReview: false,
    lines: keys.map(materialCode => ({ materialCode, requestedLoads: materialCode === 'gravel' ? 3 : 0, confirmedLoads: null, actualLoads: null })),
    ...overrides
  };
}
const apply = (row, action, body = {}, actor = scm, clock = now) => transitionAggregateRequest(row, action, { expectedRevision: row.revision, ...body }, actor, clock);

test('confirmation date saves a calendar schedule and preserves submission data and legacy commands', () => {
  const original = fixture({ createdAt: '2026-09-21T12:34:56Z' });
  for (const [serviceDate, reportDueDate] of [
    ['2028-02-29', '2028-03-01'], ['2026-12-31', '2027-01-01'],
    ['2026-03-08', '2026-03-09'], ['2026-11-01', '2026-11-02'],
    ['2026-09-22', '2026-09-23'], ['0001-01-01', '0001-01-02'], ['9999-12-30', '9999-12-31']
  ]) {
    const confirmed = apply(original, 'confirm', { loads: loads({ gravel: 2 }), serviceDate });
    assert.equal(confirmed.serviceDate, serviceDate);
    assert.equal(confirmed.reportDueDate, reportDueDate);
    assert.equal(confirmed.createdAt, original.createdAt);
    assert.equal(confirmed.lines[0].requestedLoads, 3);
    assert.equal(confirmed.lines[0].confirmedLoads, 2);
    const legacy = apply(confirmed, 'confirm', { loads: loads({ gravel: 1 }) });
    assert.equal(legacy.serviceDate, serviceDate);
    assert.equal(legacy.reportDueDate, reportDueDate);
    assert.equal(original.serviceDate, '2026-09-22');
  }
});

test('confirmation date rejects hostile and impossible dates without changing the input request', () => {
  for (const serviceDate of ['', null, 20260925, [], {}, '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01',
    '2026-01-00', '2026-1-2', '2026-01-02T00:00:00Z', ' 2026-01-02', '0000-01-01', '9999-12-31', '+010000-01-01']) {
    const row = fixture(), snapshot = structuredClone(row);
    assert.throws(() => apply(row, 'confirm', { serviceDate, loads: loads({ gravel: 9 }) }), { status: 400 });
    assert.deepEqual(row, snapshot);
  }
});

test('confirmation date remains SCM-only and cannot be changed by other actions or after completion', () => {
  const input = { serviceDate: '2027-01-31', loads: loads({ gravel: 4 }) };
  const confirmed = apply(fixture(), 'confirm', input);
  assert.equal(confirmed.serviceDate, input.serviceDate);
  assert.throws(() => apply(fixture(), 'confirm', input, sales), { status: 403 });
  assert.throws(() => apply(fixture(), 'confirm', { ...input, expectedRevision: 0 }), { status: 409 });
  assert.equal(apply(fixture(), 'edit', input, sales).serviceDate, '2026-09-22');
  const reported = apply(confirmed, 'report', { ...input, serviceDate: '2029-04-02' }, sales);
  assert.equal(reported.serviceDate, input.serviceDate);
  assert.equal(apply(reported, 'correct', { ...input, serviceDate: '2029-04-02', reason: 'Correction' }).serviceDate, input.serviceDate);
  for (const status of ['reported', 'rejected']) {
    assert.throws(() => apply(fixture({ status }), 'confirm', input), { status: 409 });
  }
});

test('property: confirmation date and following due day round-trip across calendar boundaries', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 73048 }), days => {
    const instant = new Date(Date.UTC(1900, 0, 1) + days * 86400000);
    const serviceDate = instant.toISOString().slice(0, 10);
    const row = apply(fixture(), 'confirm', { serviceDate, loads: loads() });
    assert.equal(row.serviceDate, serviceDate);
    assert.equal(Date.parse(row.reportDueDate) - Date.parse(row.serviceDate), 86400000);
  }), { seed: 20260925, numRuns: 300 });
});

test('catalog contains exactly seven local materials with fixed directions', () => {
  assert.deepEqual(AGGREGATE_MATERIALS.map(m => m.code), keys);
  assert.deepEqual(AGGREGATE_MATERIALS.map(m => m.direction), ['inbound', 'inbound', 'inbound', 'inbound', 'outbound', 'outbound', 'outbound']);
  assert.equal(AGGREGATE_MATERIALS[5].label, 'Dump Asphalt');
});
test('Toronto dates use calendar days across midnight, weekends, year end and DST', () => {
  for (const [instant, today, serviceDate, reportDueDate] of [
    ['2026-09-22T03:59:59Z', '2026-09-21', '2026-09-22', '2026-09-23'],
    ['2026-09-22T04:00:00Z', '2026-09-22', '2026-09-23', '2026-09-24'],
    ['2026-03-08T07:00:00Z', '2026-03-08', '2026-03-09', '2026-03-10'],
    ['2026-11-01T06:00:00Z', '2026-11-01', '2026-11-02', '2026-11-03'],
    ['2026-12-31T12:00:00Z', '2026-12-31', '2027-01-01', '2027-01-02']
  ]) { assert.deepEqual(aggregateDates(new Date(instant)), { today, serviceDate, reportDueDate }); }
});
test('yard access uses separate Aggregate grants and denies unassigned/unrelated roles', () => {
  assert.deepEqual(aggregateYardsForActor(sales), [1]);
  assert.deepEqual(aggregateYardsForActor({ id: 'o', roles: ['operator'], aggregateRequestYardLocationIds: [28] }), [28]);
  assert.deepEqual(aggregateYardsForActor({ id: 'm', roles: ['yard_manager'], aggregateRequestYardLocationIds: [15] }), [15]);
  assert.deepEqual(aggregateYardsForActor({ ...sales, roles: ['sales', 'operator'], operatorYardLocationIds: [28] }), [1]);
  assert.deepEqual(aggregateYardsForActor({ id: 'd', roles: ['dispatcher'], yardLocationIds: [1] }), []);
  assert.deepEqual(aggregateYardsForActor({ id: 'o', role: 'operator', yardLocationIds: [1] }), []);
  assert.deepEqual(aggregateYardsForActor({ id: 'a', role: 'admin' }), [1, 28, 15, 26]);
  assert.equal(aggregateCanManage(scm), true);
  assert.equal(aggregateCanManage(sales), false);
  assert.throws(() => assertAggregateYard(sales, 28), { status: 403 });
  assert.throws(() => assertAggregateYard(sales, 999), { status: 400 });
  assert.throws(() => assertAggregateYard({ ...sales, id: null }, 1), { status: 403 });
});
test('loads require all explicit finite nonnegative integers and positive requested demand', () => {
  assert.deepEqual(normalizeAggregateLoads(loads({ hpb: 2 }), { positive: true }), loads({ hpb: 2 }));
  assert.deepEqual(normalizeAggregateLoads(loads()), loads());
  for (const bad of [-1, 0.5, '', null, true, '1', NaN, Infinity, 1e12]) {
    assert.throws(() => normalizeAggregateLoads(loads({ gravel: bad })), { status: 400 });
  }
  assert.throws(() => normalizeAggregateLoads({ gravel: 1 }), { status: 400 });
  assert.throws(() => normalizeAggregateLoads({ ...loads(), unknown: 1 }), { status: 400 });
  assert.throws(() => normalizeAggregateLoads(loads(), { positive: true }), { status: 400 });
});
test('only the creator can edit pending demand and stale revisions fail', () => {
  const row = apply(fixture(), 'edit', { loads: loads({ gravel: 4 }), remarks: 'More gravel' }, sales);
  assert.equal(row.lines[0].requestedLoads, 4);
  assert.equal(row.revision, 2);
  assert.throws(() => apply(fixture(), 'edit', { loads: loads({ gravel: 4 }) }, { ...sales, id: 'other' }), { status: 403 });
  assert.throws(() => apply(fixture(), 'edit', { loads: loads({ gravel: 4 }) }, scm), { status: 403 });
  assert.throws(() => apply(fixture(), 'confirm', { expectedRevision: 2, loads: loads() }), { status: 409 });
});
test('SCM revises confirmed loads but preserves original demand and freezes after reporting', () => {
  const confirmed = apply(fixture(), 'confirm', { loads: loads({ gravel: 2 }) });
  assert.equal(confirmed.lines[0].requestedLoads, 3);
  assert.equal(confirmed.lines[0].confirmedLoads, 2);
  const revised = apply(confirmed, 'confirm', { loads: loads({ gravel: 4 }) });
  assert.equal(revised.lines[0].confirmedLoads, 4);
  assert.throws(() => apply(fixture(), 'confirm', { loads: loads() }, sales), { status: 403 });
  const reported = apply(revised, 'report', { loads: loads({ gravel: 4 }) }, sales);
  assert.throws(() => apply(reported, 'confirm', { loads: loads() }), { status: 409 });
  assert.throws(() => apply(confirmed, 'edit', { loads: loads({ gravel: 4 }) }, sales), { status: 409 });
});
test('reporting opens immediately after confirmation for the creator or SCM/admin', () => {
  assert.throws(() => apply(fixture(), 'report', { loads: loads() }, sales), { status: 409 });
  const confirmed = apply(fixture({ serviceDate: '2026-09-24', reportDueDate: '2026-09-25' }), 'confirm', { loads: loads({ gravel: 3 }) });
  assert.throws(() => apply(confirmed, 'report', { loads: loads() }, { ...sales, id: 'other' }), { status: 403 });
  for (const actor of [sales, scm, { id: 'admin', role: 'admin' }]) {
    const row = apply(confirmed, 'report', { loads: loads({ gravel: 2, dump_soil: 1 }) }, actor);
    assert.equal(row.reportedBy, actor.id);
    assert.equal(row.status, 'reported');
    assert.equal(row.needsReview, true);
  }
});
test('differences require acknowledgment and corrections reset acknowledgment', () => {
  const confirmed = apply(fixture(), 'confirm', { loads: loads({ gravel: 3 }) });
  const reported = apply(confirmed, 'report', { loads: loads({ gravel: 2 }) }, sales);
  assert.equal(reported.needsReview, true);
  assert.throws(() => apply(reported, 'acknowledge', {}, sales), { status: 403 });
  const acknowledged = apply(reported, 'acknowledge');
  assert.equal(acknowledged.needsReview, false);
  assert.equal(acknowledged.acknowledgedBy, 'scm');
  assert.throws(() => apply(acknowledged, 'correct', { loads: loads() }), { status: 400 });
  const corrected = apply(acknowledged, 'correct', { loads: loads({ gravel: 1 }), reason: 'Count corrected' });
  assert.equal(corrected.needsReview, true);
  assert.equal(corrected.acknowledgedBy, null);
  const matching = apply(corrected, 'correct', { loads: loads({ gravel: 3 }), reason: 'Found the third ticket' });
  assert.equal(matching.needsReview, false);
});
test('SCM rejects only submitted requests, with a reason', () => {
  assert.throws(() => apply(fixture(), 'reject'), { status: 400 });
  assert.throws(() => apply(fixture(), 'reject', { reason: 'No supply' }, sales), { status: 403 });
  assert.equal(apply(fixture(), 'reject', { reason: 'No supply' }).status, 'rejected');
  const confirmed = apply(fixture(), 'confirm', { loads: loads() });
  assert.throws(() => apply(confirmed, 'reject', { reason: 'No supply' }), { status: 409 });
});
test('property: actuals are preserved exactly; review is equivalent to any difference', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 14, maxLength: 14 }), values => {
    const approved = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    const actual = Object.fromEntries(keys.map((key, index) => [key, values[index + 7]]));
    const row = apply(apply(fixture(), 'confirm', { loads: approved }), 'report', { loads: actual }, sales);
    assert.deepEqual(row.lines.map(line => line.actualLoads), values.slice(7));
    assert.equal(row.needsReview, keys.some(key => actual[key] !== approved[key]));
    assert.equal(row.lines[0].requestedLoads, 3);
    assert.equal(row.revision, 3);
  }), { seed: 20260922, numRuns: 100 });
});

test('property: load validation accepts whole loads and rejects every fractional amount', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 999999 }), quantity => {
    assert.equal(normalizeAggregateLoads(loads({ gravel: quantity })).gravel, quantity);
    assert.throws(() => normalizeAggregateLoads(loads({ gravel: quantity + 0.5 })), { status: 400 });
  }), { seed: 20260923, numRuns: 100 });
});
test('property: another assigned staff member never gains creator actions', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), identifier => {
    assert.throws(() => apply(fixture(), 'edit', { loads: loads({ gravel: 1 }) }, { ...sales, id: `other-${identifier}` }), { status: 403 });
  }), { seed: 20260924, numRuns: 100 });
});
test('property: confirmation permits reporting before, on and after the due date', () => {
  fc.assert(fc.property(fc.integer({ min: -14, max: 14 }), days => {
    const clock = new Date(now.getTime() + days * 86400000);
    const confirmed = apply(fixture(), 'confirm', { loads: loads({ gravel: 3 }) }, scm, clock);
    assert.equal(apply(confirmed, 'report', { loads: loads() }, sales, clock).status, 'reported');
  }), { seed: 20260925, numRuns: 100 });
});

test('SCM material memos preserve all quantities and review state, including completed requests', () => {
  for (const status of ['submitted', 'confirmed', 'reported', 'rejected']) {
    const before = fixture({ status, needsReview: status === 'reported', acknowledgedBy: 'scm', acknowledgedAt: now.toISOString() });
    const after = apply(before, 'memo', { memos: memos({ gravel: 'Morning loads\n上午送货', dump_soil: 'Call for collection' }) });
    assert.equal(after.lines[0].scmMemo, 'Morning loads\n上午送货');
    assert.equal(after.lines[6].scmMemo, 'Call for collection');
    assert.deepEqual(after.lines.map(({ scmMemo: _memo, ...line }) => line), before.lines);
    assert.equal(after.status, before.status);
    assert.equal(after.needsReview, before.needsReview);
    assert.equal(after.acknowledgedBy, before.acknowledgedBy);
    assert.equal(after.acknowledgedAt, before.acknowledgedAt);
    assert.throws(() => apply(before, 'memo', { memos: memos() }, sales), { status: 403, code: 'AGGREGATE_SCM_REQUIRED' });
  }
});

test('material memos require seven strings, allow clearing and reject invalid or oversized text', () => {
  const maximum = '文'.repeat(2000);
  const saved = apply(fixture(), 'memo', { memos: memos({ gravel: maximum, hpb: '  Note\u0001\n第二行  ' }) });
  assert.equal(saved.lines[0].scmMemo, maximum);
  assert.equal(saved.lines[1].scmMemo, 'Note\n第二行');
  assert.ok(apply(saved, 'memo', { memos: memos() }).lines.every(line => line.scmMemo === ''));
  for (const invalid of [null, [], {}, { gravel: 'Missing rows' }, { ...memos(), unknown: '' }, memos({ gravel: 1 }), memos({ gravel: null }), memos({ gravel: 'x'.repeat(2001) })]) {
    assert.throws(() => apply(fixture(), 'memo', { memos: invalid }), { status: 400 });
  }
});

test('property: each material memo round-trips independently without changing loads', () => {
  fc.assert(fc.property(fc.array(fc.string({ maxLength: 100 }), { minLength: 7, maxLength: 7 }), values => {
    const notes = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    const before = fixture();
    const after = apply(before, 'memo', { memos: notes });
    assert.deepEqual(after.lines.map(line => line.scmMemo), values.map(value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()));
    assert.deepEqual(after.lines.map(line => line.requestedLoads), before.lines.map(line => line.requestedLoads));
    assert.equal(after.status, before.status);
    assert.throws(() => apply(before, 'memo', { memos: notes }, sales), { status: 403, code: 'AGGREGATE_SCM_REQUIRED' });
  }), { seed: 20260927, numRuns: 100 });
});

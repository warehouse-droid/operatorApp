import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query, pool, withTransaction } from '../../../src/db.js';
import { getDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { syncDispatchDeliveryGroupsFromPlan } from '../../../src/dispatch-delivery-group-repository.js';
import { acquireDispatchPlanEditLease, heartbeatDispatchPlanEditLease } from '../../../src/dispatch-plan-lease-repository.js';
import { withDispatchPlanWrite } from '../../../src/dispatch-plan-write.js';
import { config } from '../../../src/config.js';
import { previewScmDependencyMutation } from '../../../src/scm-dependency-preview-service.js';
import { applyDispatchV2Command } from '../../../src/dispatch-planner-v2-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../../../src/dispatch-fleet-status.js';
import { simulateDispatchSourceEvent } from '../../support/dispatch-save-source-events.mjs';
import { createDispatchV2Fixture, dispatchOrder } from '../support/dispatch-v2-fixture.js';

let fixture;
before(async () => { fixture = await createDispatchV2Fixture(); });
after(async () => { await fixture?.close(); });

async function splitFixture(date, ref) {
  const seeded = await fixture.seedPlan({ date, refs: [ref] });
  await query(`UPDATE dispatch_plan_snapshots SET orders = jsonb_set(orders, '{0}', orders->0 || $2::jsonb) WHERE plan_id=$1`,
    [seeded.id, JSON.stringify({ originalOrderId: ref.replace(/-S2$/, ''), isSplit: true, planOwned: true,
      raw: { lines: [{ quantity: 0, amount: 12.3456789 }] } })]);
  const persisted = await getDispatchPlan(seeded.id);
  await syncDispatchDeliveryGroupsFromPlan(persisted);
  const sessionId = `reliability-${date}`;
  const token = await fixture.acquireLease({ planDate: date, sessionId });
  const send = (plan, id, session = sessionId) => fixture.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, {
    method: 'POST', headers: { 'x-dispatch-edit-lease': token }, body: {
      commandId: id, baseRevision: plan.revision, baseDigest: plan.digest, sessionId: session,
      commandType: 'replace_plan', payload: { planDate: date, orders: persisted.orders, trucks: persisted.trucks, summary: { ...persisted.summary, testSaveId: id } }
    }
  });
  return { ...seeded, persisted, send, token, sessionId };
}

test('SAVE-01: source enrichment never changes the persisted fence or rejects the next save', async () => {
  const f = await splitFixture('2027-05-01', 'SO-SAVE-1-S2');
  const classic = await getDispatchPlan(f.id);
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  assert.equal(boot.response.status, 200);
  assert.equal(boot.payload.plan.digest, classic.digest, 'classic and bootstrap must fence the same persisted bytes');
  const saved = await f.send(boot.payload.plan, 'save-01-first');
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  await query(`UPDATE dispatch_global_order_splits SET full_order = full_order || '{"items":[{"quantity":0.125,"itemName":"refreshed"}],"raw":{"sourceVersion":2}}'::jsonb WHERE split_ref=$1`, ['SO-SAVE-1-S2']);
  const refreshed = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  assert.equal(refreshed.payload.plan.digest, saved.payload.acknowledgement.digest);
  const second = await f.send(saved.payload.plan, 'save-01-second');
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.plan.revision, saved.payload.plan.revision + 1);
});

test('SAVE-02: same revision persisted tampering rejects with both fence values and reason', async () => {
  const f = await splitFixture('2027-05-02', 'SO-SAVE-2-S2');
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  await query(`UPDATE dispatch_plan_snapshots SET summary=summary || '{"externalWrite":true}'::jsonb WHERE plan_id=$1`, [f.id]);
  const rejected = await f.send(boot.payload.plan, 'save-02');
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.payload.code, 'STALE_DISPATCH_PLAN');
  assert.equal(rejected.payload.conflictReason, 'persisted_content');
  assert.equal(rejected.payload.currentRevision, boot.payload.plan.revision);
  assert.notEqual(rejected.payload.currentDigest, boot.payload.plan.digest);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_commands WHERE command_id=$1', ['save-02'])).rows[0].n, 0);
});

test('SAVE-03: a token cannot authorize another browser session', async () => {
  const f = await splitFixture('2027-05-03', 'SO-SAVE-3-S2');
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  const rejected = await f.send(boot.payload.plan, 'save-03', 'different-browser');
  assert.equal(rejected.response.status, 409);
  assert.match(rejected.payload.code, /^DISPATCH_PLAN_EDIT_LEASE_/);
  assert.equal((await getDispatchPlan(f.id)).revision, boot.payload.plan.revision);
});

test('SAVE-04: concurrent first acquisitions have exactly one owner', async () => {
  // Barrier: hold the table against INSERT while all SELECTs have observed absence.
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('LOCK TABLE dispatch_plan_edit_leases IN SHARE MODE');
  const requests = ['a', 'b', 'c'].map(sessionId => acquireDispatchPlanEditLease({
    planDate: '2027-05-04', sessionId, operatorId: fixture.operator.id
  }).then(result => ({ response: { status: 200 }, payload: result }), error => ({ response: { status: error.status }, payload: error })));
  try {
    const deadline = performance.now() + 30000;
    for (;;) {
      await client.query('SELECT pg_stat_clear_snapshot()');
      const waiting = await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);
      if (waiting.rows[0].n >= 3) break;
      if (performance.now() > deadline) throw new Error('Acquisition barrier not reached');
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { await client.query('COMMIT'); client.release(); }
  const results = await Promise.all(requests);
  assert.equal(results.filter(r => r.response.status === 200).length, 1);
  assert.equal(results.filter(r => r.payload.code === 'DISPATCH_PLAN_EDIT_LEASE_HELD').length, 2);
});

test('SAVE-05: classic force Save cannot bypass a stale fence, even for an unchanged board', async () => {
  const f = await splitFixture('2027-05-05', 'SO-SAVE-5-S2');
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  const saved = await f.send(boot.payload.plan, 'save-05-first');
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  const result = await fixture.request(`/api/dispatch/plans/${f.id}`, {
    method: 'PUT', body: { ...f.persisted, planId: f.id, editLeaseToken: f.token,
      baseRevision: boot.payload.plan.revision, baseDigest: boot.payload.plan.digest, forceSave: true,
      audit: { sessionId: f.sessionId } }
  });
  assert.equal(result.response.status, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, 'STALE_DISPATCH_PLAN');
  assert.equal((await getDispatchPlan(f.id)).revision, saved.payload.plan.revision);
});

test('SAVE-06: a request waiting to commit loses permission when its lease is released', async () => {
  const f = await splitFixture('2027-05-06', 'SO-SAVE-6-S2');
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  const gate = await pool.connect();
  await gate.query('BEGIN');
  await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
  const pending = f.send(boot.payload.plan, 'save-06-delayed');
  try {
    const deadline = performance.now() + 30000;
    for (;;) {
      await gate.query('SELECT pg_stat_clear_snapshot()');
      const waiting = await gate.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()`);
      if (waiting.rows[0].n) break;
      if (performance.now() > deadline) throw new Error('Save did not reach commit barrier');
      await new Promise(resolve => setImmediate(resolve));
    }
    const released = await fixture.request('/api/dispatch/plan-edit-lease/release', {
      method: 'POST', body: { planDate: f.plan_date, sessionId: f.sessionId, editLeaseToken: f.token }
    });
    assert.equal(released.response.status, 200);
  } finally { await gate.query('COMMIT'); gate.release(); }
  const result = await pending;
  assert.equal(result.response.status, 409);
  assert.match(result.payload.code, /^DISPATCH_PLAN_EDIT_LEASE_/);
  assert.equal((await getDispatchPlan(f.id)).revision, boot.payload.plan.revision);
});

test('SAVE-07: a lost confirmation response can be retried without a second revision', async () => {
  const seeded = await fixture.seedPlan({ date: '2027-05-07', refs: [] });
  await query("UPDATE dispatch_plan_snapshots SET trucks='[]'::jsonb WHERE plan_id=$1", [seeded.id]);
  const sessionId = 'save-07';
  const token = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}`);
  const send = () => fixture.request(`/api/dispatch/plans/${seeded.id}/confirm`, {
    method: 'POST', body: { commandId: 'save-07-confirm', baseRevision: boot.payload.plan.revision,
      baseDigest: boot.payload.plan.digest, editLeaseToken: token, audit: { sessionId } }
  });
  const first = await send();
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  const retry = await send();
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.revision, first.payload.revision);
  const current = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${seeded.id}`);
  assert.equal(current.payload.plan.digest, first.payload.digest);
  assert.equal(current.payload.plan.revision, first.payload.revision);
});

test('SAVE-08: a receipt from another date cannot acknowledge this plan', async () => {
  const first = await fixture.seedPlan({ date: '2027-05-08', refs: [] });
  const second = await fixture.seedPlan({ date: '2027-05-09', refs: [] });
  const sessionId = 'same-owner-two-dates';
  const lease1 = await fixture.acquireLease({ planDate: first.plan_date, sessionId });
  const lease2 = await fixture.acquireLease({ planDate: second.plan_date, sessionId });
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${first.id}`);
  const body = { commandId: 'save-08-shared', sessionId, commandType: 'replace_plan',
    baseRevision: boot.payload.plan.revision, baseDigest: boot.payload.plan.digest,
    payload: { orders: [], trucks: [], summary: {} } };
  const applied = await fixture.request(`/api/dispatch/v2/plans/${first.id}/commands`, { method: 'POST', headers: { 'x-dispatch-edit-lease': lease1 }, body });
  assert.equal(applied.response.status, 200, JSON.stringify(applied.payload));
  const wrongPlan = await fixture.request(`/api/dispatch/v2/plans/${second.id}/commands`, { method: 'POST', headers: { 'x-dispatch-edit-lease': lease2 }, body });
  assert.equal(wrongPlan.response.status, 409);
  assert.equal(wrongPlan.payload.code, 'DISPATCH_COMMAND_ID_REUSED');
  assert.equal((await getDispatchPlan(second.id)).revision, 0);
});

test('SAVE-09: classic saves and lifecycle retries commit each command once', async () => {
  const seeded = await fixture.seedPlan({ date: '2027-05-10', refs: [] });
  const sessionId = 'save-09';
  const editLeaseToken = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const initial = await getDispatchPlan(seeded.id);
  const saveBody = { commandId: 'save-09-classic', planDate: seeded.plan_date, baseRevision: initial.revision,
    baseDigest: initial.digest, orders: [], trucks: [], summary: {}, editLeaseToken, audit: { sessionId } };
  const save = () => fixture.request(`/api/dispatch/plans/${seeded.id}`, { method: 'PUT', body: saveBody });
  const saved = await save(), retried = await save();
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal(retried.response.status, 200, JSON.stringify(retried.payload));
  assert.equal(retried.payload.revision, saved.payload.revision);
  assert.equal(retried.payload.digest, saved.payload.digest);
  for (const action of ['confirm', 'reopen']) {
    const current = await getDispatchPlan(seeded.id);
    const body = { commandId: `save-09-${action}`, baseRevision: current.revision, baseDigest: current.digest, editLeaseToken, audit: { sessionId } };
    const send = () => fixture.request(`/api/dispatch/plans/${seeded.id}/${action}`, { method: 'POST', body });
    const first = await send(), retry = await send();
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
    assert.equal(retry.payload.revision, first.payload.revision);
    assert.equal(retry.payload.digest, first.payload.digest);
    assert.equal((await getDispatchPlan(seeded.id)).revision, current.revision + 1);
  }
});

test('SAVE-10: restores replay exactly and cannot reuse an ID for another snapshot', async () => {
  const seeded = await fixture.seedPlan({ date: '2027-05-11', refs: [] });
  await query("UPDATE dispatch_plan_snapshots SET trucks='[]'::jsonb WHERE plan_id=$1", [seeded.id]);
  const snapshots = [];
  for (const note of ['first', 'second']) snapshots.push((await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary) VALUES ($1,$2,0,'[]','[]',$3) RETURNING id::text`, [seeded.id, seeded.plan_date, JSON.stringify({ note })])).rows[0].id);
  const sessionId = 'save-10';
  const editLeaseToken = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const plan = await getDispatchPlan(seeded.id);
  const body = { commandId: 'save-10-restore', expectedRevision: plan.revision, expectedDigest: plan.digest, editLeaseToken, audit: { sessionId } };
  const send = id => fixture.request(`/api/dispatch/plan-snapshots/${id}/restore`, { method: 'POST', body });
  const first = await send(snapshots[0]), retry = await send(snapshots[0]);
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.plan.revision, first.payload.plan.revision);
  assert.equal(retry.payload.plan.digest, first.payload.plan.digest);
  const reused = await send(snapshots[1]);
  assert.equal(reused.response.status, 409, JSON.stringify(reused.payload));
  assert.equal(reused.payload.code, 'DISPATCH_COMMAND_ID_REUSED');
  assert.equal((await getDispatchPlan(seeded.id)).revision, first.payload.plan.revision);
});

test('SAVE-11: a legacy request missing its digest cannot clear or force-save the board', async () => {
  const seeded = await fixture.seedPlan({ date: '2027-05-12', refs: [] });
  const sessionId = 'save-11';
  const editLeaseToken = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const before = await getDispatchPlan(seeded.id);
  const result = await fixture.request(`/api/dispatch/plans/${seeded.id}`, { method: 'PUT', body: {
    planDate: seeded.plan_date, baseRevision: before.revision, forceSave: true,
    orders: [], trucks: [], editLeaseToken, audit: { sessionId }
  } });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, 'DISPATCH_PLAN_FENCE_REQUIRED');
  assert.deepEqual(await getDispatchPlan(seeded.id), before);
});

test('SAVE-12: a heartbeat extends only the current owner and cannot revive an expired lease', async () => {
  const planDate = '2027-05-13', sessionId = 'save-12';
  const token = await fixture.acquireLease({ planDate, sessionId });
  const credentials = { planDate, sessionId, token, operatorId: fixture.operator.id };
  const renewed = await heartbeatDispatchPlanEditLease(credentials);
  assert.equal(renewed.sessionId, sessionId);
  assert.equal(renewed.active, true);
  await assert.rejects(heartbeatDispatchPlanEditLease({ ...credentials, sessionId: 'test-other-owner' }),
    { code: 'DISPATCH_PLAN_EDIT_LEASE_EXPIRED' });
  await query("UPDATE dispatch_plan_edit_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE plan_date=$1", [planDate]);
  await assert.rejects(heartbeatDispatchPlanEditLease(credentials), { code: 'DISPATCH_PLAN_EDIT_LEASE_EXPIRED' });
});

test('SAVE-13: checkpoint and revision reads use the same persisted digest after enrichment', async t => {
  const previousMode = config.dispatch.plannerCommandMode;
  config.dispatch.plannerCommandMode = 'on';
  t.after(() => { config.dispatch.plannerCommandMode = previousMode; });
  const f = await splitFixture('2027-05-14', 'SO-SAVE-13-S2');
  const boot = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
  const before = boot.payload.plan;
  const revision = await fixture.request(`/api/dispatch/plans/${f.id}/revision`);
  assert.equal(revision.payload.digest, before.digest);
  const body = { kind: 'manual', idempotencyKey: 'save-13-checkpoint', sessionId: f.sessionId,
    editLeaseToken: f.token, expectedRevision: before.revision, expectedDigest: before.digest };
  const checkpoint = () => fixture.request(`/api/dispatch/v2/plans/${f.id}/checkpoints`, { method: 'POST', body });
  const first = await checkpoint(), retry = await checkpoint();
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(first.payload.checkpoint.id, retry.payload.checkpoint.id);
  const row = (await query('SELECT plan_digest FROM dispatch_plan_snapshot_history WHERE id=$1', [first.payload.checkpoint.id])).rows[0];
  assert.equal(row.plan_digest, before.digest);
  await query("UPDATE dispatch_plan_snapshots SET plan_digest='obsolete-cache' WHERE plan_id=$1", [f.id]);
  const fresh = await fixture.request(`/api/dispatch/plans/${f.id}/revision`);
  assert.equal(fresh.payload.digest, before.digest, 'cached digest columns cannot become authority');
  assert.equal((await getDispatchPlan(f.id)).revision, before.revision);
});

test('SAVE-14: a valid lease for another date cannot enter a classic commit callback', async () => {
  const plan = await fixture.seedPlan({ date: '2027-05-15', refs: [] });
  const planDate = '2027-05-16', sessionId = 'save-14';
  const token = await fixture.acquireLease({ planDate, sessionId });
  const before = await getDispatchPlan(plan.id);
  let committed = false;
  await assert.rejects(withDispatchPlanWrite({ planId: plan.id, operation: 'save',
    editLease: { planDate, sessionId, token, operatorId: fixture.operator.id },
    request: { baseRevision: before.revision, baseDigest: before.digest }
  }, async () => { committed = true; return before; }), { code: 'DISPATCH_PLAN_EDIT_LEASE_REQUIRED' });
  assert.equal(committed, false);
  assert.equal((await getDispatchPlan(plan.id)).revision, before.revision);
});

test('SAVE-15: a retained dependency on another date cannot borrow the current board lease', async () => {
  const other = await fixture.seedPlan({ date: '2027-05-17', refs: [] });
  const planDate = '2027-05-18', sessionId = 'save-15';
  const token = await fixture.acquireLease({ planDate, sessionId });
  await query("INSERT INTO sales_orders (netsuite_id,tranid) VALUES (9900515,'SO-SAVE-15')");
  await query("INSERT INTO transfer_orders (netsuite_id,tranid) VALUES (9900516,'TO-SAVE-15')");
  const dependency = (await query(`INSERT INTO order_dependencies
    (sales_order_id,sales_order_ref,dispatch_target_ref,transfer_order_id,transfer_order_ref,
     dependency_mode,same_load_required,status,planned_plan_id,planned_date,
     source_location_id,source_location,accounting_destination_location_id,accounting_destination_location)
    VALUES (9900515,'SO-SAVE-15','SO-SAVE-15',9900516,'TO-SAVE-15','yard_replenishment',false,'active',$1,$2,
      1,'3445',15,'12441') RETURNING id`,
  [other.id, other.plan_date])).rows[0];
  await assert.rejects(withTransaction(() => previewScmDependencyMutation({
    action: 'unlink_to', planDate, payload: { dependencyId: dependency.id }
  }, { id: fixture.operator.id, sessionId, surface: 'dispatch',
    editLease: { planDate, sessionId, token, operatorId: fixture.operator.id }
  }, { lock: true })), { code: 'DISPATCH_PLAN_EDIT_LEASE_REQUIRED' });
  assert.equal((await query('SELECT status FROM order_dependencies WHERE id=$1', [dependency.id])).rows[0].status, 'active');
  const otherToken = await fixture.acquireLease({ planDate: other.plan_date, sessionId });
  const actor = { id: fixture.operator.id, sessionId, surface: 'dispatch',
    editLease: { planDate: other.plan_date, sessionId, token: otherToken, operatorId: fixture.operator.id } };
  const command = { action: 'unlink_to', planDate: other.plan_date, payload: { dependencyId: dependency.id } };
  await assert.rejects(withTransaction(() => previewScmDependencyMutation(command, actor, { lock: true })),
    { code: 'DISPATCH_PLAN_FENCE_REQUIRED' });
  const current = await getDispatchPlan(other.id);
  const valid = await withTransaction(() => previewScmDependencyMutation({ ...command,
    expectedPlanRevision: current.revision, expectedPlanDigest: current.digest
  }, actor, { lock: true }));
  assert.equal(valid.allowed, true, JSON.stringify(valid.blockers));
  assert.equal(String(valid.affectedPlan.id), String(other.id));
  const external = await withTransaction(() => previewScmDependencyMutation(command,
    { id: fixture.operator.id, sessionId: 'scm-other-browser', surface: 'scm' }, { lock: true }));
  assert.equal(external.allowed, false, 'SCM changes must respect the active Dispatch owner');
  const unlinkBody = { requestId: '00000000-0000-4000-8000-000000000015', planDate: other.plan_date,
    sessionId, editLeaseToken: otherToken, expectedPlanRevision: current.revision, expectedPlanDigest: current.digest };
  const unlink = () => fixture.request(`/api/dispatch/order-dependencies/${dependency.id}`, { method: 'DELETE', body: unlinkBody });
  const first = await unlink(), retry = await unlink();
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.planRevision, first.payload.planRevision);
  assert.equal((await query('SELECT status FROM order_dependencies WHERE id=$1', [dependency.id])).rows[0].status, 'cancelled');
});

test('SAVE-16: direct compact commands preserve canonical identity and replays return the persisted fence', async () => {
  const seeded = await fixture.seedPlan({ date: '2027-05-19', refs: [] });
  const sessionId = 'save-16';
  const token = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const before = await getDispatchPlan(seeded.id);
  const editLease = { planDate: seeded.plan_date, sessionId, token, operatorId: fixture.operator.id };
  const command = { commandId: 'save-16', commandType: 'replace_plan', compactReceipt: true,
    baseRevision: before.revision, baseDigest: before.digest,
    payload: { orders: [], trucks: [], summary: { zero: 0, fraction: 0.125 } } };
  const first = await applyDispatchV2Command({ planId: seeded.id, command, editLease });
  const replay = await applyDispatchV2Command({ planId: seeded.id, editLease,
    command: { ...command, payload: { summary: { fraction: 0.125, zero: 0 }, trucks: [], orders: [] } } });
  assert.equal(replay.replay, true);
  assert.equal(replay.payload.plan.revision, first.payload.plan.revision);
  assert.equal(replay.payload.plan.digest, first.payload.acknowledgement.digest);
  assert.equal(replay.payload.plan.summary.fraction, 0.125);
  assert.equal(replay.payload.plan.summary.zero, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_commands WHERE command_id=$1', [command.commandId])).rows[0].n, 1);
});

test('SAVE-17: optimized confirmation, reopen, and lease release checkpoint the matching persisted fence', async t => {
  const mode = config.dispatch.plannerCommandMode;
  config.dispatch.plannerCommandMode = 'on';
  t.after(() => { config.dispatch.plannerCommandMode = mode; });
  const seeded = await fixture.seedPlan({ date: '2027-05-20', refs: [] });
  const sessionId = 'save-17';
  const editLeaseToken = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  for (const action of ['confirm', 'reopen']) {
    const plan = await getDispatchPlan(seeded.id);
    const response = await fixture.request(`/api/dispatch/plans/${seeded.id}/${action}`, { method: 'POST', body: {
      commandId: `save-17-${action}`, baseRevision: plan.revision, baseDigest: plan.digest,
      editLeaseToken, audit: { sessionId }
    } });
    assert.equal(response.response.status, 200, JSON.stringify(response.payload));
    assert.equal(response.payload.status, action === 'confirm' ? 'confirmed' : 'draft');
    assert.equal(response.payload.digest, (await getDispatchPlan(seeded.id)).digest);
  }
  const released = await fixture.request('/api/dispatch/plan-edit-lease/release', { method: 'POST', body: {
    planDate: seeded.plan_date, sessionId, editLeaseToken
  } });
  assert.equal(released.response.status, 200, JSON.stringify(released.payload));
  const checkpoints = (await query(`SELECT archive_reason,plan_digest FROM dispatch_plan_snapshot_history
    WHERE plan_id=$1 AND checkpoint_kind='lifecycle' ORDER BY id`, [seeded.id])).rows;
  assert.deepEqual(checkpoints.map(row => row.archive_reason), [
    'checkpoint_lifecycle_before_confirm', 'checkpoint_lifecycle_before_reopen', 'checkpoint_lifecycle_edit_release'
  ]);
  assert.ok(checkpoints.every(row => /^[a-f0-9]{64}$/.test(row.plan_digest)));
});


test('SAVE-18: unchanged classic saves validate the same fence without creating a revision', async () => {
  const seeded = await fixture.seedPlan({ date: '2027-05-21', refs: [] });
  await query("UPDATE dispatch_plan_snapshots SET trucks='[]'::jsonb WHERE plan_id=$1", [seeded.id]);
  const sessionId = 'save-18', editLeaseToken = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const before = await getDispatchPlan(seeded.id);
  const body = { orders: [], trucks: [], planDate: seeded.plan_date, editLeaseToken,
    baseRevision: before.revision, baseDigest: before.digest, audit: { sessionId } };
  const unchanged = await fixture.request(`/api/dispatch/plans/${seeded.id}`, { method: 'PUT', body });
  assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.payload));
  assert.equal(unchanged.payload.noChange, true);
  assert.equal(unchanged.payload.revision, before.revision);
  await query(`UPDATE dispatch_plan_snapshots SET summary=summary || '{"external":true}'::jsonb WHERE plan_id=$1`, [seeded.id]);
  const stale = await fixture.request(`/api/dispatch/plans/${seeded.id}`, { method: 'PUT', body });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.conflictReason, 'persisted_content');
  assert.equal((await getDispatchPlan(seeded.id)).revision, before.revision);
});

test('SAVE-19: confirmation validation failures cannot partially save a candidate or leave a receipt', async t => {
  const original = config.dispatch.driverOrientedPlanning;
  t.after(() => { config.dispatch.driverOrientedPlanning = original; });
  const seeded = await fixture.seedPlan({ date: '2027-05-22', refs: [] });
  const sessionId = 'save-19', editLeaseToken = await fixture.acquireLease({ planDate: seeded.plan_date, sessionId });
  const before = await getDispatchPlan(seeded.id);
  const placement = ref => [{ id: 'save-19-truck', plate: '', loads: [{ id: 'save-19-load',
    name: 'Candidate', stops: [{ id: 'drop-19', type: 'drop', orderId: ref, location: 'Customer' }] }] }];
  const verifyRejected = async (name, orders, trucks, code) => {
    const result = await fixture.request(`/api/dispatch/plans/${seeded.id}/confirm`, { method: 'POST', body: {
      orders, trucks, planDate: seeded.plan_date, baseRevision: before.revision, baseDigest: before.digest,
      editLeaseToken, commandId: `save-19-${name}`, audit: { sessionId }
    } });
    assert.equal(result.response.status, 409, `${name}: ${JSON.stringify(result.payload)}`);
    assert.equal(result.payload.code, code, name);
    const after = await getDispatchPlan(seeded.id);
    assert.equal(after.revision, before.revision, name);
    assert.equal(after.digest, before.digest, name);
    assert.equal(after.status, before.status, name);
    assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_commands WHERE command_id=$1', [`save-19-${name}`])).rows[0].n, 0);
  };
  config.dispatch.driverOrientedPlanning = false;
  await verifyRejected('driver', [], [
    { id: 'driver-a', plate: '', driverLogin: 'duplicate', loads: [] },
    { id: 'driver-b', plate: '', driverLogin: 'duplicate', loads: [] }
  ], 'DISPATCH_DRIVER_DUPLICATE');
  config.dispatch.driverOrientedPlanning = true;
  await verifyRejected('assignment', [dispatchOrder('SO-SAVE-19-A', 1)], placement('SO-SAVE-19-A'), 'DISPATCH_DRIVER_TIME_CONFLICT');
  config.dispatch.driverOrientedPlanning = false;
  const owned = await fixture.seedPlan({ date: '2027-05-23', refs: ['SO-SAVE-19-DATE'] });
  await query('UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1', [owned.id, JSON.stringify(placement('SO-SAVE-19-DATE'))]);
  await verifyRejected('date', [dispatchOrder('SO-SAVE-19-DATE', 2)], placement('SO-SAVE-19-DATE'), 'DISPATCH_ORDER_ALREADY_PLANNED');
  const coSource = { ...dispatchOrder('SO-SAVE-19-CO', 3), transitCo: { id: 'CO-SAVE-19-MISSING' } };
  await verifyRejected('co', [coSource], placement(coSource.id), 'DISPATCH_CO_SEQUENCE_INVALID');
  await query("INSERT INTO sales_orders (netsuite_id,tranid) VALUES (9900519,'SO-SAVE-19-DEP')");
  await query("INSERT INTO transfer_orders (netsuite_id,tranid) VALUES (9900520,'TO-SAVE-19-DEP')");
  await query(`INSERT INTO order_dependencies (sales_order_id,sales_order_ref,dispatch_target_ref,transfer_order_id,transfer_order_ref,
    dependency_mode,same_load_required,status,source_location_id,source_location,accounting_destination_location_id,accounting_destination_location)
    VALUES (9900519,'SO-SAVE-19-DEP','SO-SAVE-19-DEP',9900520,'TO-SAVE-19-DEP','yard_replenishment',false,'attention',1,'3445',15,'12441')`);
  await verifyRejected('dependency', [dispatchOrder('SO-SAVE-19-DEP', 4)], placement('SO-SAVE-19-DEP'), 'DISPATCH_ORDER_DEPENDENCY_CONFLICT');
});


test('SAVE-20: repeated source-update events interleave with classic/V2 saves and exact retries without false conflicts', async () => {
  await query("INSERT INTO dispatch_trucks (plate) VALUES ('DP-V2-TEST') ON CONFLICT DO NOTHING");
  const f = await splitFixture('2027-05-24', 'SO-SAVE-20-S2');
  for (let sequence = 0; sequence < 30; sequence++) {
    const loaded = await getDispatchPlan(f.id);
    const sourceEvent = await simulateDispatchSourceEvent(loaded, sequence);
    assert.equal(sourceEvent.simulated, true);
    const refreshed = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${f.id}`);
    assert.equal(refreshed.payload.plan.digest, loaded.digest, 'only order data changed');
    assert.equal(refreshed.payload.plan.revision, loaded.revision);
    assert.ok(JSON.stringify(refreshed.payload.plan.assignedOrderSnapshots).includes(sourceEvent.marker), 'the browser refresh sees the new data');
    const payload = { planDate: f.plan_date, orders: loaded.orders, trucks: loaded.trucks,
      summary: { ...loaded.summary, sourceEventSequence: sequence } };
    payload.trucks[0].loads[0].name = `Source event ${sequence}`;
    const body = sequence % 2 ? { ...payload, editLeaseToken: f.token,
      commandId: `source-event-${sequence}`, baseRevision: loaded.revision, baseDigest: loaded.digest,
      audit: { sessionId: f.sessionId }, refreshOrderPool: true
    } : { commandId: `source-event-${sequence}`, commandType: 'replace_plan',
      baseRevision: loaded.revision, baseDigest: loaded.digest, sessionId: f.sessionId, payload };
    const save = () => fixture.request(sequence % 2 ? `/api/dispatch/plans/${f.id}` : `/api/dispatch/v2/plans/${f.id}/commands`, {
      method: sequence % 2 ? 'PUT' : 'POST', headers: { 'x-dispatch-edit-lease': f.token }, body
    });
    const first = await save();
    assert.equal(first.response.status, 200, JSON.stringify(first.payload));
    const saved = await getDispatchPlan(f.id);
    assert.ok(saved.revision >= loaded.revision);
    assert.equal(saved.orders.find(order => order.id === 'SO-SAVE-20-S2').instructions, sourceEvent.marker);
    const retry = await save();
    assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
    assert.equal((await getDispatchPlan(f.id)).revision, saved.revision, 'the exact retry must not commit twice');
    assert.equal((await getDispatchPlan(f.id)).digest, saved.digest);
  }
});


test('SAVE-21: source-event simulation selects a NetSuite source when a CO sorts first', async () => {
  const f = await splitFixture('2027-05-25', 'SO-SAVE-21-S2');
  const record = (await query('SELECT * FROM dispatch_global_order_splits WHERE split_ref=$1', ['SO-SAVE-21-S2'])).rows[0];
  const co = { ...record.full_order, id: 'CO-FIRST-S2', type: 'CO', originalOrderId: 'CO-FIRST' };
  await query(`INSERT INTO dispatch_global_order_splits
    (split_ref,parent_order_ref,order_type,definition_kind,active,eligible,full_order,card,search_text,source_plan_date)
    VALUES ('CO-FIRST-S2','CO-FIRST','CO','split',true,true,$1::jsonb,'{}'::jsonb,'',$2::date)`, [JSON.stringify(co), f.plan_date]);
  const loaded = await getDispatchPlan(f.id);
  const event = await simulateDispatchSourceEvent({ ...loaded, orders: [co, ...loaded.orders] }, 'mixed-source-selection');
  assert.equal(event.simulated, true);
  assert.equal(event.splitRef, 'SO-SAVE-21-S2');
  assert.equal(event.sourceTable, 'sales_orders');
});

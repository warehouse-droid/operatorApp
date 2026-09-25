import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { query, pool } from '../src/db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../src/dispatch-fleet-status.js';
import { createDispatchV2Fixture } from '../test/dispatch/support/dispatch-v2-fixture.js';

const mode = process.argv[2] || 'stress';
assert.ok(['stress', 'races', 'soak'].includes(mode));
assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const fixture = await createDispatchV2Fixture();
const report = { mode, startedAt: new Date().toISOString(), saves: 0, races: 0, replays: 0, viewers: 0,
  latencies: [], faults: [], phases: [] };
const runtimeFiles = ['src/dispatch-plan-fence.js', 'src/dispatch-plan-write.js', 'src/dispatch-plan-lease-repository.js',
  'src/dispatch-plan-repository.js', 'src/dispatch-planner-performance.js', 'src/dispatch-planner-v2-repository.js',
  'src/server.js', 'src/scm-dependency-preview-service.js', 'src/scm-dependency-command-service.js', 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js',
  'public/dispatch.js', 'public/dispatch-save-journal.js', 'public/dispatch-snapshot.js', 'public/dispatch.css'];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
}
report.sources = await sourceHashes();
const plans = [];
const count = mode === 'races' ? 1 : 20;
const file = `test-artifacts/dispatch-save-reliability/${mode}.json`;
async function persist() { await writeFile(file, JSON.stringify(report)); }
async function refresh(plan) {
  const result = await fixture.request(`/api/dispatch/v2/bootstrap?planId=${plan.id}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  plan.snapshot = result.payload.plan;
  assert.ok(plan.snapshot.digest);
}
function body(plan, id) {
  return { commandId: id, sessionId: plan.sessionId, baseRevision: plan.snapshot.revision, baseDigest: plan.snapshot.digest,
    commandType: 'replace_plan', compactReceipt: true,
    payload: { planDate: plan.date, orders: plan.orders, trucks: plan.trucks, summary: { saveSequence: id, zero: 0, fraction: 0.125 } } };
}
async function send(plan, request) {
  return fixture.request(`/api/dispatch/v2/plans/${plan.id}/commands`, {
    method: 'POST', headers: { 'x-dispatch-edit-lease': plan.lease }, body: request
  });
}
function committed(plan, request, result) {
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.acknowledgement.revision, request.baseRevision + 1);
  assert.equal(result.payload.plan.revision, request.baseRevision + 1);
  assert.equal(result.payload.plan.summary.saveSequence, request.commandId);
  plan.snapshot = result.payload.plan;
  report.saves++;
}
async function checkStored(plan) {
  const before = plan.snapshot;
  await refresh(plan);
  assert.equal(plan.snapshot.digest, before.digest);
  assert.equal(plan.snapshot.revision, before.revision);
  assert.equal(plan.snapshot.summary.saveSequence, before.summary.saveSequence);
  const projections = await query('SELECT DISTINCT order_ref FROM dispatch_plan_order_assignments WHERE plan_id=$1', [plan.id]);
  assert.ok(projections.rows.some(row => row.order_ref === plan.orders[0].id), 'committed assignment remains materialized');
}
async function save(plan, serial, fault = false) {
  const request = body(plan, `${mode}:${serial}`);
  const result = await send(plan, request);
  committed(plan, request, result);
  report.latencies.push({ dates: report.phases.at(-1)?.dates || count, ms: result.durationMs });
  if (fault) {
    // The test transport discards this acknowledgement, then sends the exact
    // frozen request. The real database must have only one committed revision.
    const replay = await send(plan, request);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal(replay.payload.acknowledgement.revision, result.payload.acknowledgement.revision);
    assert.equal(replay.payload.acknowledgement.digest, result.payload.acknowledgement.digest);
    const receipts = await query('SELECT count(*)::int AS n FROM dispatch_plan_commands WHERE command_id=$1', [request.commandId]);
    assert.equal(receipts.rows[0].n, 1);
    report.replays++;
    report.faults.push({ serial, type: 'discarded_acknowledgement_then_exact_retry' });
  }
  if (serial % 37 === 0) {
    const viewer = await send(plan, { ...body(plan, `viewer:${serial}`), sessionId: 'view-mode-session' });
    assert.equal(viewer.response.status, 409);
    assert.equal(viewer.payload.code, 'DISPATCH_PLAN_EDIT_LEASE_REQUIRED');
    report.viewers++;
  }
  if (serial % 25 === 0) await checkStored(plan);
}
async function heartbeat() {
  for (const plan of plans) {
    const result = await fixture.request('/api/dispatch/plan-edit-lease/heartbeat', { method: 'POST', body: {
      planDate: plan.date, sessionId: plan.sessionId, editLeaseToken: plan.lease
    } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  }
}
async function race(plan, serial) {
  const request = body(plan, `race:${serial}:first`);
  if (serial % 3 !== 2) {
    const duplicate = serial % 3 === 0;
    const second = duplicate ? request : { ...request, commandId: `race:${serial}:second`, payload: { ...request.payload, summary: { saveSequence: `race:${serial}:second` } } };
    const results = await Promise.all([send(plan, request), send(plan, second)]);
    if (duplicate) {
      assert.deepEqual(results.map(r => r.response.status), [200, 200]);
      assert.equal(results[0].payload.acknowledgement.revision, results[1].payload.acknowledgement.revision);
      report.replays++;
    } else {
      assert.deepEqual(results.map(r => r.response.status).sort(), [200, 409]);
      const rejected = results.find(r => r.response.status === 409);
      assert.equal(rejected.payload.code, 'STALE_DISPATCH_PLAN');
      assert.equal(rejected.payload.conflictReason, 'revision');
    }
    const winner = results.findIndex(r => r.response.status === 200);
    committed(plan, winner === 0 ? request : second, results[winner]);
  } else {
    // Deterministically pause before the save's transaction can acquire the
    // fleet lock, then hand the date to a different session.
    const client = await pool.connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
      pending = send(plan, request);
      const deadline = performance.now() + 10000;
      for (;;) {
        await client.query('SELECT pg_stat_clear_snapshot()');
        const waiting = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
        if (waiting.rows[0].n) break;
        assert.ok(performance.now() < deadline, 'save must reach the fleet barrier');
        await pause(1);
      }
      const released = await fixture.request('/api/dispatch/plan-edit-lease/release', { method: 'POST', body: {
        planDate: plan.date, sessionId: plan.sessionId, editLeaseToken: plan.lease
      } });
      assert.equal(released.response.status, 200, JSON.stringify(released.payload));
      plan.sessionId = `handover:${serial}`;
      plan.lease = await fixture.acquireLease({ planDate: plan.date, sessionId: plan.sessionId });
      await client.query('COMMIT');
      const rejected = await pending;
      assert.equal(rejected.response.status, 409);
      assert.equal(rejected.payload.code, 'DISPATCH_PLAN_EDIT_LEASE_REQUIRED');
      report.faults.push({ serial, type: 'lease_handover_while_commit_waits' });
    } finally { await client.query('ROLLBACK'); client.release(); if (pending) await pending; }
  }
  await checkStored(plan);
  report.races++;
}
try {
  for (let i = 0; i < count; i++) {
    const date = `2027-07-${String(i + 1).padStart(2, '0')}`;
    const seeded = await fixture.seedPlan({ date, refs: [`SO-STRESS-${i}`] });
    const plan = { id: seeded.id, date, sessionId: `stress-owner:${i}` };
    plan.lease = await fixture.acquireLease({ planDate: date, sessionId: plan.sessionId });
    await refresh(plan);
    plan.orders = plan.snapshot.assignedOrderSnapshots || plan.snapshot.orders;
    plan.trucks = plan.snapshot.trucks;
    plans.push(plan);
  }
  let serial = 0, nextHeartbeat = performance.now() + 20000;
  if (mode === 'stress') {
    for (const [dates, total] of [[1, 2500], [5, 2500], [20, 5000]]) {
      report.phases.push({ dates, total });
      for (let n = 0; n < total; n += dates) {
        await Promise.all(plans.slice(0, Math.min(dates, total - n)).map(plan => { const id = ++serial; return save(plan, id, id % 29 === 0); }));
        if (performance.now() > nextHeartbeat) { await heartbeat(); nextHeartbeat = performance.now() + 20000; }
        if (serial % 100 === 0) { await persist(); console.log(JSON.stringify({ mode, saves: report.saves, maxMs: Math.max(...report.latencies.map(r => r.ms)) })); }
      }
    }
  } else if (mode === 'races') {
    for (let n = 0; n < 1000; n++) {
      await race(plans[0], ++serial);
      if (performance.now() > nextHeartbeat) { await heartbeat(); nextHeartbeat = performance.now() + 20000; }
      if (serial % 50 === 0) { await persist(); console.log(JSON.stringify({ mode, races: report.races })); }
    }
  } else {
    const start = performance.now();
    while (performance.now() - start < 60 * 60 * 1000) {
      await save(plans[serial % plans.length], ++serial, serial % 3 === 0);
      if (serial % 41 === 0) await race(plans[0], serial);
      if (performance.now() > nextHeartbeat) { await heartbeat(); nextHeartbeat = performance.now() + 20000; await persist(); }
      // Sustained pacing is outside measured update time.
      await pause(500);
    }
    report.elapsedMs = performance.now() - start;
    assert.ok(report.elapsedMs >= 3600000);
  }
  for (const plan of plans) await checkStored(plan);
  report.completedAt = new Date().toISOString();
  report.maxUpdateMs = Math.max(0, ...report.latencies.map(r => r.ms));
  report.over500ms = report.latencies.filter(r => r.ms > 500);
  await persist();
  assert.deepEqual(await sourceHashes(), report.sources, 'Runtime source changed during the stress/soak run');
  // The latest clarification gates browser action responsiveness while saving
  // asynchronously. Preserve backend latency as capacity measurements.
  report.latencyScope = 'Measured burst/soak capacity; Playwright gates action feedback at 500 ms.';
  console.log(JSON.stringify({ mode, saves: report.saves, races: report.races, maxUpdateMs: report.maxUpdateMs }));
} catch (error) { report.error = error.stack; await persist(); throw error; }
finally { await fixture.close(); }

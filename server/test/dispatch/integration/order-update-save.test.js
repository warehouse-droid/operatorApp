import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query } from '../../../src/db.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';

import { stored, seedMaintenanceIncident } from '../../support/order-update-save-fixture.mjs';

let fixture;
before(async () => {
  fixture = await createDispatchV2Fixture();
  await query("INSERT INTO dispatch_trucks (plate,active) VALUES ('DP-V2-TEST',true)");
});
after(async () => { await fixture?.close(); });

test('MAINT-01: recorded revision 63 cleanup stays pending throughout Edit Mode', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const result = await f.cleanup();
  const afterCleanup = await stored(f.id);
  assert.equal(afterCleanup.revision, 63, 'cleanup must not advance the editor fence');
  assert.equal(afterCleanup.digest, f.baseline.digest);
  assert.deepEqual(afterCleanup.trucks, f.baseline.trucks);
  assert.deepEqual(result.changedPlans, []);
  assert.equal(result.deferred, true);
});

for (const classic of [false, true]) {
  test(`MAINT-02: ${classic ? 'classic' : 'V2'} autosave commits the move and obsolete split cleanup together`, async () => {
    const f = await seedMaintenanceIncident(fixture);
    await f.cleanup();
    const draft = structuredClone(f.baseline);
    draft.trucks[0].startYard = '2967';
    const saved = await f.save(draft, `maintenance-save-${f.id}`, classic);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
    const final = await stored(f.id);
    assert.equal(final.revision, 64);
    assert.equal(final.trucks[0].startYard, '2967');
    assert.equal(final.orders.some(order => f.obsolete.includes(order.id)), false);
    const acknowledged = classic ? saved.payload : saved.payload.plan;
    assert.equal(acknowledged.digest, final.digest);
    const replay = await f.save(draft, `maintenance-save-${f.id}`, classic);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
    assert.equal((await stored(f.id)).revision, 64, 'lost response retry cannot apply maintenance twice');
  });
}

test('MAINT-03: a source update on two dates changes only the date without an editor', async () => {
  const f = await seedMaintenanceIncident(fixture);
  const other = await fixture.seedPlan({ date: '2028-04-01', refs: [] });
  await query('UPDATE dispatch_plan_snapshots SET orders=$2::jsonb WHERE plan_id=$1', [other.id, JSON.stringify(f.baseline.orders)]);
  const result = await f.cleanup();
  assert.deepEqual(result.changedPlans.map(plan => plan.planId), [other.id]);
  assert.equal((await stored(f.id)).digest, f.baseline.digest);
  assert.equal((await stored(other.id)).orders.some(order => f.obsolete.includes(order.id)), false);
});

test('MAINT-04: releasing Edit Mode drains pending cleanup without another edit', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  const released = await fixture.request('/api/dispatch/plan-edit-lease/release', { method: 'POST',
    body: { planDate: f.plan_date, sessionId: f.sessionId, editLeaseToken: f.token } });
  assert.equal(released.response.status, 200, JSON.stringify(released.payload));
  const deadline = performance.now() + 5000;
  while ((await stored(f.id)).revision === 63 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await stored(f.id)).revision, 64);
});

test('MAINT-05: unchanged repeated cleanup creates no extra history or revision', async () => {
  const f = await seedMaintenanceIncident(fixture, { edit: false });
  await f.cleanup();
  const first = await stored(f.id);
  const history = (await query('SELECT count(*)::int AS n FROM dispatch_plan_snapshot_history WHERE plan_id=$1', [f.id])).rows[0].n;
  const second = await f.cleanup();
  assert.deepEqual(second.changedPlans, []);
  assert.equal((await stored(f.id)).digest, first.digest);
  assert.equal((await stored(f.id)).revision, first.revision);
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_snapshot_history WHERE plan_id=$1', [f.id])).rows[0].n, history);
});

test('MAINT-06: unchanged classic autosave still consumes queued maintenance', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  const current = await fixture.request(`/api/dispatch/plans/${f.id}`);
  assert.equal(current.response.status, 200);
  const saved = await f.save(current.payload, 'maintenance-no-change', true);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0].n, 0);
  assert.equal((await stored(f.id)).orders.some(order => f.obsolete.includes(order.id)), false);
});

test('MAINT-07: the legacy save endpoint also drains maintenance on an unchanged save', async () => {
  const f = await seedMaintenanceIncident(fixture);
  await f.cleanup();
  const current = await fixture.request(`/api/dispatch/plans/${f.id}`);
  const saved = await fixture.request('/api/dispatch/plan', { method: 'PUT', headers: { 'x-dispatch-edit-lease': f.token },
    body: { ...current.payload, planId: f.id, editLeaseToken: f.token, baseRevision: current.payload.revision,
      baseDigest: current.payload.digest, audit: { sessionId: f.sessionId } } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
  assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_plan_maintenance WHERE plan_id=$1', [f.id])).rows[0].n, 0);
  assert.equal((await stored(f.id)).orders.some(order => f.obsolete.includes(order.id)), false);
});

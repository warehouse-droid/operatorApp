import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { query, pool } from '../../../src/db.js';
import * as leases from '../../../src/dispatch-plan-lease-repository.js';
import { createDispatchV2Fixture } from '../support/dispatch-v2-fixture.js';
import { getDispatchPlan } from '../../../src/dispatch-plan-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../../../src/dispatch-fleet-status.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';

let admin, dispatcher;
before(async () => {
  admin = await createDispatchV2Fixture({ role: 'admin' });
  const operator = await createOperator({ username: 'editor-control-dispatcher', displayName: 'Dispatch tester', password: 'IsolatedPassword123', role: 'dispatcher' });
  const session = await loginOperator(operator.username, 'IsolatedPassword123');
  const request = (path, options = {}) => admin.request(path, { ...options, token: options.token ?? session.token });
  dispatcher = { operator, request, seedPlan: admin.seedPlan, acquireLease: async ({ planDate, sessionId }) => {
    const result = await request('/api/dispatch/plan-edit-lease/acquire', { method: 'POST', body: { planDate, sessionId } });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload)); return result.payload.editLeaseToken;
  } };
});
after(async () => { await admin?.close(); });
async function acquire(planDate, sessionId = planDate) {
  const token = await dispatcher.acquireLease({ planDate, sessionId });
  return { ...(await leases.getDispatchPlanEditLease(planDate)), token };
}
function kick(lease, who = admin) {
  return who.request('/api/admin/dispatch-plan-editors/kick', { method: 'POST', body: {
    planDate: lease.planDate, operatorId: lease.operatorId, sessionId: lease.sessionId, acquiredAt: lease.acquiredAt, selectionId: lease.selectionId
  } });
}
test('ADMIN-01: only Admin can list or kick; active listing hides secrets', async () => {
  const lease = await acquire('2027-11-01');
  for (const [path, method, body] of [['/api/admin/dispatch-plan-editors', 'GET'],
    ['/api/admin/dispatch-plan-editors/kick', 'POST', lease]]) {
    assert.equal((await dispatcher.request(path, { method, body })).response.status, 403);
    assert.equal((await dispatcher.request(path, { method, body, token: '' })).response.status, 401);
  }
  const result = await admin.request('/api/admin/dispatch-plan-editors');
  assert.equal(result.response.status, 200); assert.ok(result.payload.editors.some(l => l.planDate === lease.planDate));
  assert.doesNotMatch(JSON.stringify(result.payload), /token|hash/i);
});
test('ADMIN-02: kick revokes token, audits actor and target, preserves other dates and saved plan', async () => {
  const lease = await acquire('2027-11-02'), other = await acquire('2027-11-03');
  const plan = await dispatcher.seedPlan({ date: lease.planDate, refs: ['SO-ADMIN-KICK'] });
  const before = await getDispatchPlan(plan.id);
  const result = await kick(lease); assert.equal(result.response.status, 200); assert.equal(result.payload.released, true);
  assert.equal(await leases.getDispatchPlanEditLease(lease.planDate), null);
  assert.equal((await leases.getDispatchPlanEditLease(other.planDate)).sessionId, other.sessionId);
  await assert.rejects(leases.heartbeatDispatchPlanEditLease({ ...lease, activityAgeMs: 0 }), { status: 409 });
  await assert.rejects(leases.assertDispatchPlanEditLease(lease), { status: 409 });
  const row = (await query("SELECT * FROM dispatch_audit_log WHERE action='dispatch_plan_edit_lease_admin_kicked' AND plan_date=$1", [lease.planDate])).rows[0];
  assert.equal(row.operator_id, admin.operator.id); assert.equal(row.before_state.sessionId, lease.sessionId);
  assert.deepEqual(await getDispatchPlan(plan.id), before);
  const next = await admin.acquireLease({ planDate: lease.planDate, sessionId: 'replacement' }); assert.ok(next);
});
test('ADMIN-03: stale kick cannot remove a replacement, including the same browser after expiry', async () => {
  const lease = await acquire('2027-11-04', 'same-browser');
  await query("UPDATE dispatch_plan_edit_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE plan_date=$1", [lease.planDate]);
  const newer = await acquire(lease.planDate, lease.sessionId);
  const result = await kick(lease); assert.equal(result.response.status, 409); assert.equal(result.payload.code, 'DISPATCH_PLAN_EDIT_LEASE_CHANGED');
  assert.equal((await leases.getDispatchPlanEditLease(lease.planDate)).acquiredAt.toISOString(), newer.acquiredAt.toISOString());
  assert.equal((await kick(newer)).payload.released, true); assert.equal((await kick(newer)).payload.released, false);
});
test('ADMIN-04: missing/malformed selection is rejected without removing any editor', async () => {
  const lease = await acquire('2027-11-05');
  for (const patch of [{ acquiredAt: '' }, { acquiredAt: 'bad' }, { sessionId: '' }, { operatorId: '' }, { planDate: 'bad' }]) {
    assert.equal((await kick({ ...lease, ...patch })).response.status, 400);
    assert.equal((await leases.getDispatchPlanEditLease(lease.planDate)).sessionId, lease.sessionId);
  }
});
test('IDLE-DB-01: background heartbeats and old pages never prolong expiry; actual activity does', async () => {
  const lease = await acquire('2027-11-06');
  await query("UPDATE dispatch_plan_edit_leases SET heartbeat_at=clock_timestamp()-interval '9 minutes', expires_at=clock_timestamp()+interval '1 minute' WHERE plan_date=$1", [lease.planDate]);
  const before = await leases.getDispatchPlanEditLease(lease.planDate);
  const quiet = await leases.heartbeatDispatchPlanEditLease({ ...lease, activityAgeMs: 540000 });
  assert.ok(new Date(quiet.expiresAt) - new Date(before.expiresAt) < 1000);
  const legacy = await leases.heartbeatDispatchPlanEditLease(lease);
  assert.equal(new Date(legacy.expiresAt).valueOf(), new Date(quiet.expiresAt).valueOf());
  const active = await leases.heartbeatDispatchPlanEditLease({ ...lease, activityAgeMs: 0 });
  assert.ok(new Date(active.expiresAt) - new Date(legacy.expiresAt) > 500000);
  for (const activityAgeMs of [-1, '0', null, true, 600000, 1e100]) {
    await assert.rejects(leases.heartbeatDispatchPlanEditLease({ ...lease, activityAgeMs }), error => [400, 409].includes(error.status));
  }
});
test('ADMIN-05: a delayed save waiting for the fleet lock fails after kick', async () => {
  const lease = await acquire('2027-11-07');
  const seeded = await dispatcher.seedPlan({ date: lease.planDate, refs: ['SO-DELAYED-KICK'] });
  const before = await getDispatchPlan(seeded.id), gate = await pool.connect();
  await gate.query('BEGIN'); await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
  const pending = dispatcher.request(`/api/dispatch/v2/plans/${seeded.id}/commands`, { method: 'POST',
    headers: { 'x-dispatch-edit-lease': lease.token }, body: { commandId: 'admin-kick-delayed',
      baseRevision: before.revision, baseDigest: before.digest, sessionId: lease.sessionId,
      commandType: 'replace_plan', payload: { ...before, note: 'must not save' } } });
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      await gate.query('SELECT pg_stat_clear_snapshot()');
      const waiting = await gate.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()");
      if (waiting.rows[0].n) break;
      if (Date.now() > deadline) throw new Error('Save barrier not reached');
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await kick(lease)).payload.released, true);
  } finally { await gate.query('COMMIT'); gate.release(); }
  assert.equal((await pending).response.status, 409); assert.deepEqual(await getDispatchPlan(seeded.id), before);
});
test('DISPATCH-01: Dispatch can kick the displayed editor with an audited selection fence', async () => {
  const planDate = '2027-11-08';
  await admin.acquireLease({ planDate, sessionId: 'admin-editor' });
  const lease = await leases.getDispatchPlanEditLease(planDate);
  const result = await dispatcher.request('/api/dispatch/plan-edit-lease/kick', { method: 'POST', body: lease });
  assert.equal(result.response.status, 200); assert.equal(result.payload.released, true);
  const row = (await query("SELECT * FROM dispatch_audit_log WHERE action='dispatch_plan_edit_lease_kicked' AND plan_date=$1", [planDate])).rows[0];
  assert.equal(row.operator_id, dispatcher.operator.id); assert.equal(row.before_state.sessionId, 'admin-editor');
});
test('ADMIN-06: audit failure rolls back removal so editing is never silently revoked', async () => {
  const lease = await acquire('2027-11-09');
  await query(`CREATE FUNCTION test_reject_kick_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='dispatch_plan_edit_lease_admin_kicked' THEN RAISE EXCEPTION 'isolated audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_reject_kick_audit BEFORE INSERT ON dispatch_audit_log FOR EACH ROW EXECUTE FUNCTION test_reject_kick_audit()`);
  try {
    assert.equal((await kick(lease)).response.status, 500);
    assert.equal((await leases.getDispatchPlanEditLease(lease.planDate)).selectionId, lease.selectionId);
  } finally {await query('DROP TRIGGER test_reject_kick_audit ON dispatch_audit_log; DROP FUNCTION test_reject_kick_audit()');}
});
test('IDLE-DB-02: reacquiring an active session rotates credentials and fences stale kick requests', async () => {
  const old = await acquire('2027-11-10', 'same-active-browser');
  const current = await leases.acquireDispatchPlanEditLease({ ...old, operatorName: 'Dispatch tester' });
  assert.equal(current.renewed, true); assert.notEqual(current.token, old.token);
  await assert.rejects(leases.assertDispatchPlanEditLease(old), { status: 409 });
  assert.equal((await kick(old)).response.status, 409);
  assert.equal((await leases.assertDispatchPlanEditLease({ ...old, token: current.token })).active, true);
});

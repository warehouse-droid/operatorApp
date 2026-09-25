// One-off, user-requested recovery. Run from the deployed server directory:
// node --input-type=module < tools/merge-dispatch-plan-331-recovery.mjs
// Default: exercise the normal save transaction and roll it back.
// DISPATCH_RECOVERY_MERGE_APPLY=1 commits the same guarded operation.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = name => import(pathToFileURL(path.resolve('src', name)).href);
const { query, withTransaction, closeDb } = await source('db.js');
const { persistedDispatchPlan } = await source('dispatch-plan-fence.js');
const { evaluateExecutedPrefixPolicy } = await source('dispatch-planner-performance.js');
const { validateDispatchLoadAssignments } = await source('dispatch-load-assignment.js');
const { validateDispatchPlanDependencies } = await source('order-dependency-repository.js');
const { applyDispatchV2Command } = await source('dispatch-planner-v2-repository.js');
const { assertScmReconciliationOrderEditable } = await source('scm-reconciliation-repository.js');
const { DISPATCH_FLEET_PLANNING_LOCK } = await source('dispatch-fleet-status.js');
const { lockDispatchPlanEditLeaseDate } = await source('dispatch-plan-lease-repository.js');
const { planJobsForDriver } = await source('driver-repository.js');
const { writeDispatchAudit } = await source('dispatch-audit-repository.js');

const target = Object.freeze({
  planId: '331', planDate: '2026-09-19', revision: 33, snapshotId: '17811',
  digest: '063e05084b8d18c5de9a98d2b88beeab65f393b0e9358615e675bc8b39a65e4e',
  snapshotDigest: '8f055c58f9890c9b968a8fdd2c013b24',
  truckId: 'T4', loadId: 'T4-L1789835722338-cadc304356a158',
  refs: ['TOB01115', 'GOA-8942-8943'],
  allRefs: ['TOB01115', 'GOA-8942-8943', 'SOA08942', 'SOA08943'],
  commandId: 'user-recovery-331-17811-merge-v1',
  actor: 'system:user-requested-plan-331-recovery-17811'
});
const apply = process.env.DISPATCH_RECOVERY_MERGE_APPLY === '1';
const loads = plan => plan.trucks.flatMap(truck => truck.loads || []);
const one = (rows, predicate) => {
  const matches = rows.filter(predicate);
  assert.equal(matches.length, 1, 'Expected exactly one matching source object');
  return matches[0];
};

async function currentPlan(lock = false) {
  const result = await query(`SELECT p.*, p.plan_date::text AS plan_date,
    s.orders, s.trucks, s.summary, s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=$1 ${lock ? 'FOR UPDATE OF p, s' : ''}`, [target.planId]);
  assert.equal(result.rowCount, 1);
  return persistedDispatchPlan(result.rows[0]);
}

async function sourceSnapshot() {
  const result = await query(`SELECT id,plan_id,plan_date::text,revision,archive_reason,
    orders,trucks,summary,md5(orders::text||trucks::text||summary::text) AS digest
    FROM dispatch_plan_snapshot_history WHERE id=$1`, [target.snapshotId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function driverEvidence() {
  return (await query(`SELECT id::text,md5(to_jsonb(j)::text) AS digest
    FROM driver_job_records j WHERE plan_id=$1 ORDER BY id`, [target.planId])).rows;
}

function mergedPlan(current, draft) {
  const next = structuredClone(current);
  const truck = one(next.trucks, row => row.id === target.truckId);
  assert.equal(truck.loads.length, 3);
  assert.ok(!loads(current).some(load => load.id === target.loadId));
  const added = structuredClone(one(loads(draft), row => row.id === target.loadId));
  assert.equal(added.driverLogin, 'dao');
  assert.equal(added.truckPlate, 'BC71838');
  assert.equal(added.driverSequence, 3);
  assert.equal(added.stops.length, 4);
  assert.deepEqual(added.stops.map(stop => [stop.type, stop.orderId]), [
    ['pick', 'TOB01115'], ['drop', 'TOB01115'],
    ['pick', 'GOA-8942-8943'], ['drop', 'GOA-8942-8943']
  ]);
  // This estimate used the draft's blank predecessor address. Rebuild it from
  // the retained route when the planner renders, as other route repairs do.
  for (const field of ['routeEstimate', 'routeEstimateId', 'routeSignature',
    'plannedFinishMinute', 'finish', 'finishTime', 'timing']) delete added[field];
  for (const stop of added.stops) {
    for (const field of ['arriveTime', 'departTime', 'plannedArrive', 'plannedDepart',
      'plannedArrival', 'plannedDeparture', 'timing']) delete stop[field];
  }
  added.plannedStartMinute = truck.loads.at(-1).plannedFinishMinute;
  assert.equal(added.plannedStartMinute, 820);
  added.routeProjectionRefreshRequired = true;
  truck.loads.push(added);
  for (const ref of target.refs) {
    assert.ok(!current.orders.some(order => order.id === ref));
    next.orders.push(structuredClone(one(draft.orders, order => order.id === ref)));
  }
  next.summary.planned = Number(current.summary.planned) + 2;
  next.summary.stops = Number(current.summary.stops) + 4;
  return next;
}

function verifyPreservation(previous, next, activity) {
  const withoutAddition = structuredClone(next.trucks);
  one(withoutAddition, truck => truck.id === target.truckId).loads =
    one(withoutAddition, truck => truck.id === target.truckId).loads.filter(load => load.id !== target.loadId);
  assert.deepEqual(withoutAddition, previous.trucks, 'Every existing truck/load/stop must stay unchanged');
  const policy = evaluateExecutedPrefixPolicy({ previousPlan: previous, nextPlan: next, activity });
  assert.deepEqual(policy, { allowed: true, conflicts: [] });
  for (const driver of ['dao', 'li', 'cheng']) {
    const before = planJobsForDriver(previous, driver).map(job => job.jobId);
    const after = planJobsForDriver(next, driver).map(job => job.jobId);
    assert.deepEqual(after.slice(0, before.length), before, `${driver}'s existing job identities/order must remain intact`);
  }
  assert.equal(next.status, previous.status);
  assert.ok(!next.orders.some(order => ['SOA07539-S1', 'SOA07539-S2', 'SOA07539-S3'].includes(order.id)),
    'Do not resurrect billed splits from the rejected draft');
  const added = one(loads(next), load => load.id === target.loadId);
  assert.deepEqual(added.stops.map(stop => [stop.type, stop.orderId]), [
    ['pick', 'TOB01115'], ['drop', 'TOB01115'],
    ['pick', 'GOA-8942-8943'], ['drop', 'GOA-8942-8943']
  ]);
}

function negativeChecks(current, draft, candidate, activity) {
  const policy = nextPlan => evaluateExecutedPrefixPolicy({ previousPlan: current, nextPlan, activity });
  assert.equal(policy({ ...current, orders: draft.orders, trucks: draft.trucks }).allowed, false);
  for (const ref of ['GOA-8930-8931', 'TOB01111']) {
    const changed = structuredClone(candidate);
    changed.orders = changed.orders.map(order => order.id === ref
      ? structuredClone(one(draft.orders, row => row.id === ref)) : order);
    assert.equal(policy(changed).allowed, false, `The conflicting ${ref} draft update must still be rejected`);
  }
  const deleted = structuredClone(candidate);
  deleted.trucks.find(truck => truck.id === target.truckId).loads.shift();
  assert.equal(policy(deleted).allowed, false, 'Deleting completed predecessor work must still be rejected');
  assert.equal(policy(candidate).allowed, true, 'The new later load must be allowed');
}

try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='3s'");
    await query("SET LOCAL statement_timeout='45s'");
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    await lockDispatchPlanEditLeaseDate(target.planDate);
    const leases = await query(`SELECT 1 FROM dispatch_plan_edit_leases
      WHERE plan_date=$1::date AND expires_at>clock_timestamp()`, [target.planDate]);
    assert.equal(leases.rowCount, 0, 'A dispatcher is editing this plan; do not overwrite the session');
    const current = await currentPlan(true);
    assert.equal(current.planDate, target.planDate);
    assert.equal(current.status, 'confirmed');
    assert.equal(current.revision, target.revision);
    assert.equal(current.digest, target.digest, 'The active plan changed after the merge was reviewed');
    const draft = await sourceSnapshot();
    assert.equal(String(draft.plan_id), target.planId);
    assert.equal(draft.plan_date, target.planDate);
    assert.equal(Number(draft.revision), target.revision);
    assert.equal(draft.archive_reason, 'save_recovery');
    assert.equal(draft.digest, target.snapshotDigest);
    const latest = (await query(`SELECT max(id)::text AS id FROM dispatch_plan_snapshot_history
      WHERE plan_id=$1 AND archive_reason='save_recovery'`, [target.planId])).rows[0];
    assert.equal(latest.id, target.snapshotId, 'A newer failed draft exists');
    const evidence = await driverEvidence();
    const activity = (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details
      FROM driver_job_records WHERE plan_id=$1 AND status IN ('complete','in_progress') ORDER BY id`, [target.planId])).rows;
    const candidate = mergedPlan(current, draft);
    verifyPreservation(current, candidate, activity);
    negativeChecks(current, draft, candidate, activity);
    assert.deepEqual(validateDispatchLoadAssignments(candidate, {
      previousPlan: current, activityStatuses: activity, ownYards: current.summary.ownYardCodes
    }), []);
    assert.deepEqual(await validateDispatchPlanDependencies(candidate), []);
    const placements = await query(`SELECT plan_id,plan_date,order_ref FROM dispatch_plan_order_assignments
      WHERE order_ref=ANY($1::text[])`, [target.allRefs]);
    assert.equal(placements.rowCount, 0, 'Recovered orders already have a Dispatch assignment');
    await assertScmReconciliationOrderEditable({ orderRefs: ['TOB01115'] });
    await applyDispatchV2Command({ planId: target.planId, command: {
      commandId: target.commandId, commandType: 'replace_plan',
      baseRevision: target.revision, baseDigest: target.digest, sessionId: target.actor,
      payload: { orders: candidate.orders, trucks: candidate.trucks, summary: candidate.summary,
        planDate: target.planDate, actionName: 'recovery_merged', affectedOrderRefs: target.allRefs }
    } });
    const followup = await query(`SELECT status FROM dispatch_plan_followup_outbox WHERE command_id=$1`, [target.commandId]);
    assert.deepEqual(followup.rows, [{ status: 'pending' }]);
    const saved = await currentPlan();
    assert.equal(saved.revision, target.revision + 1);
    verifyPreservation(current, saved, activity);
    assert.deepEqual(await driverEvidence(), evidence, 'Driver records and photo evidence must not change');
    assert.equal((await sourceSnapshot()).digest, target.snapshotDigest);
    const projection = (await query(`SELECT order_ref,planned_order_ref FROM dispatch_plan_order_assignments
      WHERE plan_id=$1 AND order_ref=ANY($2::text[]) ORDER BY order_ref`, [target.planId, target.allRefs])).rows;
    assert.deepEqual(projection.map(row => row.order_ref).sort(), [...target.allRefs].sort());
    const assignment = (await query(`SELECT driver_login,truck_plate,started,completed
      FROM dispatch_plan_load_assignments WHERE plan_id=$1 AND load_id=$2`, [target.planId, target.loadId])).rows;
    assert.deepEqual(assignment, [{ driver_login: 'dao', truck_plate: 'BC71838', started: false, completed: false }]);
    await writeDispatchAudit({
      action: 'dispatch_plan_recovery_merged', entityType: 'plan', entityId: target.planId,
      planId: target.planId, planDate: target.planDate, sessionId: target.actor,
      operatorName: target.actor, source: 'user_requested_recovery',
      before: { revision: current.revision, digest: current.digest },
      after: { revision: saved.revision, digest: saved.digest },
      details: { recoverySnapshotId: target.snapshotId, addedLoadId: target.loadId,
        addedOrderRefs: target.refs, retainedDriverRecords: evidence.length,
        executedPrefixPreserved: true, routeEstimateRefreshRequired: true }
    });
    return { applied: apply, rolledBack: !apply, planId: target.planId, planDate: target.planDate,
      fromRevision: current.revision, toRevision: saved.revision, recoverySnapshotId: target.snapshotId,
      addedLoad: 'Load 4', driver: 'Dao', truck: 'BC71838', addedOrderRefs: target.refs,
      executedPrefixPreserved: true, driverRecordsUnchanged: evidence.length,
      originalDraftRetained: true, negativeChecksPassed: 4, commandId: target.commandId, digest: saved.digest };
  }, { rollback: !apply });
  if (!apply) assert.equal((await currentPlan()).digest, target.digest, 'Dry run must roll back the saved plan');
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}

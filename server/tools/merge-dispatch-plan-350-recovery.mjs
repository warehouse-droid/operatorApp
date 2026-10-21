// User-requested operational repair. Default is a rollback rehearsal.
// Run in /app with DISPATCH_RECOVERY_MERGE_APPLY=1 only after reviewing preview.
import assert from 'node:assert/strict';
import { query, withTransaction, closeDb } from '../src/db.js';
import { persistedDispatchPlan } from '../src/dispatch-plan-fence.js';
import { evaluateExecutedPrefixPolicy } from '../src/dispatch-planner-performance.js';
import { validateDispatchLoadAssignments } from '../src/dispatch-load-assignment.js';
import { validateDispatchPlanDependencies } from '../src/order-dependency-repository.js';
import { applyDispatchV2Command } from '../src/dispatch-planner-v2-repository.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from '../src/dispatch-fleet-status.js';
import { lockDispatchPlanEditLeaseDate } from '../src/dispatch-plan-lease-repository.js';
import { planJobsForDriver } from '../src/driver-repository.js';
import { writeDispatchAudit } from '../src/dispatch-audit-repository.js';

const target = Object.freeze({
  planId: '350', planDate: '2026-10-08', revision: 61, snapshotId: '19341',
  digest: '2232c9c6224eb2aea92cb090394dbee3e8f1fbf22a63e4b220c6a557ef4f5d48',
  snapshotDigest: 'cc17b7bdc25c5a5e46bbbe8c210bf3c3',
  truckId: 'T7', loadId: 'T7-L1791478486410-f4f4933f71011',
  returnId: 'T7-MR1791475533608-fa0644ce4cdd6', orderRef: 'SN1402231',
  editor: 'dispatch-1790943257984-abf33a31b026d8',
  commandId: 'user-recovery-350-19341-merge-v1',
  actor: 'support:user-requested-plan-350-recovery-19341'
});
const apply = process.env.DISPATCH_RECOVERY_MERGE_APPLY === '1';
const loads = plan => plan.trucks.flatMap(truck => truck.loads || []);
const one = (rows, predicate) => {
  const matches = rows.filter(predicate);
  assert.equal(matches.length, 1);
  return matches[0];
};
async function currentPlan(lock = false) {
  const result = await query(`SELECT p.*,p.plan_date::text,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id
    WHERE p.id=$1 ${lock ? 'FOR UPDATE OF p,s' : ''}`, [target.planId]);
  assert.equal(result.rowCount, 1);
  return persistedDispatchPlan(result.rows[0]);
}
async function draftSnapshot() {
  return (await query(`SELECT *,plan_date::text,
    md5(orders::text||trucks::text||summary::text) AS digest
    FROM dispatch_plan_snapshot_history WHERE id=$1`, [target.snapshotId])).rows[0];
}
async function driverEvidence() {
  return (await query(`SELECT id::text,md5(to_jsonb(j)::text) AS digest
    FROM driver_job_records j WHERE plan_id=$1 ORDER BY id`, [target.planId])).rows;
}
function mergedPlan(current, draft) {
  const next = structuredClone(current);
  const truck = one(next.trucks, row => row.id === target.truckId);
  assert.equal(truck.loads.length, 3);
  assert.equal(truck.loads.at(-1).id, target.returnId);
  assert.equal(truck.loads.at(-1).returnOnly, true);
  assert.ok(!loads(current).some(load => load.id === target.loadId));
  assert.equal(loads(draft).length, 1);
  const added = structuredClone(one(loads(draft), load => load.id === target.loadId));
  assert.equal(added.driverLogin, 'sety');
  assert.equal(added.truckPlate, 'CE94489');
  assert.deepEqual(added.stops.map(stop => [stop.type, stop.orderId]), [
    ['pick', target.orderRef], ['drop', target.orderRef]
  ]);
  // The blank-board draft estimated a first load at 07:00. Recalculate the
  // recovered later load after the retained route, before its unstarted return.
  for (const field of ['routeEstimate', 'routeEstimateId', 'routeSignature',
    'plannedFinishMinute', 'finish', 'finishTime', 'timing']) delete added[field];
  for (const stop of added.stops) {
    for (const field of ['arriveTime', 'departTime', 'plannedArrive', 'plannedDepart',
      'plannedArrival', 'plannedDeparture', 'timing']) delete stop[field];
  }
  added.name = 'Load 3';
  added.start = '';
  added.startMode = 'auto';
  added.driverSequence = 2;
  added.plannedStartMinute = truck.loads[1].plannedFinishMinute;
  added.routeProjectionRefreshRequired = true;
  truck.loads.at(-1).driverSequence = 3;
  truck.loads.splice(2, 0, added);
  assert.ok(!current.orders.some(order => order.id === target.orderRef));
  next.orders.push(structuredClone(one(draft.orders, order => order.id === target.orderRef)));
  next.summary.planned = Number(current.summary.planned) + 1;
  next.summary.stops = Number(current.summary.stops) + 2;
  return next;
}
function verify(previous, next, activity) {
  const restored = structuredClone(next.trucks);
  const truck = one(restored, row => row.id === target.truckId);
  truck.loads = truck.loads.filter(load => load.id !== target.loadId);
  one(truck.loads, load => load.id === target.returnId).driverSequence = 2;
  assert.deepEqual(restored, previous.trucks, 'All existing loads and stops remain unchanged');
  assert.deepEqual(evaluateExecutedPrefixPolicy({ previousPlan: previous, nextPlan: next, activity }),
    { allowed: true, conflicts: [] });
  for (const driver of ['dao', 'li', 'aurther', 'sety']) {
    const oldJobs = planJobsForDriver(previous, driver).map(job => job.jobId);
    const newJobs = planJobsForDriver(next, driver).map(job => job.jobId);
    assert.deepEqual(newJobs.filter(id => oldJobs.includes(id)), oldJobs,
      'Every existing driver job identity and relative order must survive');
  }
  assert.equal(next.status, previous.status);
}

try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL lock_timeout='3s'");
    await query("SET LOCAL statement_timeout='30s'");
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    await lockDispatchPlanEditLeaseDate(target.planDate);
    const leases = (await query(`SELECT session_id FROM dispatch_plan_edit_leases
      WHERE plan_date=$1::date AND expires_at>clock_timestamp()`, [target.planDate])).rows;
    // The requesting dispatcher may keep their session open. Preserve that
    // lease, reject any other editor, and use revision/digest CAS for every write.
    assert.ok(leases.every(lease => lease.session_id === target.editor), 'Another editor acquired this date');
    const current = await currentPlan(true);
    assert.equal(current.planDate, target.planDate);
    assert.equal(current.status, 'confirmed');
    assert.equal(current.revision, target.revision);
    assert.equal(current.digest, target.digest, 'Active plan changed since recovery was prepared');
    const draft = await draftSnapshot();
    assert.equal(String(draft.plan_id), target.planId);
    assert.equal(draft.plan_date, target.planDate);
    assert.equal(Number(draft.revision), target.revision);
    assert.equal(draft.archive_reason, 'save_recovery');
    assert.equal(draft.digest, target.snapshotDigest);
    const latest = (await query(`SELECT max(id)::text AS id FROM dispatch_plan_snapshot_history
      WHERE plan_id=$1 AND archive_reason='save_recovery'`, [target.planId])).rows[0];
    assert.equal(latest.id, target.snapshotId, 'Newer failed draft exists');
    const evidence = await driverEvidence();
    const activity = (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details
      FROM driver_job_records WHERE plan_id=$1 AND status IN ('complete','in_progress')
      AND mbt_assignment_withdrawn_at IS NULL ORDER BY id`, [target.planId])).rows;
    assert.ok(!activity.some(row => row.load_id === target.returnId), 'Return already started');
    const candidate = mergedPlan(current, draft);
    verify(current, candidate, activity);
    assert.equal(evaluateExecutedPrefixPolicy({ previousPlan: current, nextPlan: { ...current,
      orders: draft.orders, trucks: draft.trucks }, activity }).allowed, false);
    assert.deepEqual(validateDispatchLoadAssignments(candidate, { previousPlan: current,
      activityStatuses: activity, ownYards: current.summary.ownYardCodes }), []);
    assert.deepEqual(await validateDispatchPlanDependencies(candidate), []);
    assert.equal((await query('SELECT 1 FROM dispatch_plan_order_assignments WHERE order_ref=$1',
      [target.orderRef])).rowCount, 0, 'Recovered order is already assigned');
    await applyDispatchV2Command({ planId: target.planId, command: {
      commandId: target.commandId, commandType: 'replace_plan', baseRevision: target.revision,
      baseDigest: target.digest, sessionId: target.actor,
      payload: { orders: candidate.orders, trucks: candidate.trucks, summary: candidate.summary,
        planDate: target.planDate, actionName: 'recovery_merged', affectedOrderRefs: [target.orderRef] }
    } });
    const saved = await currentPlan();
    assert.equal(saved.revision, target.revision + 1);
    verify(current, saved, activity);
    assert.deepEqual(await driverEvidence(), evidence, 'Driver evidence must not change');
    assert.equal((await draftSnapshot()).digest, target.snapshotDigest, 'Keep original failed draft');
    const assignment = (await query(`SELECT driver_login,truck_plate,started,completed
      FROM dispatch_plan_load_assignments WHERE plan_id=$1 AND load_id=$2`,
    [target.planId, target.loadId])).rows;
    assert.deepEqual(assignment, [{ driver_login: 'sety', truck_plate: 'CE94489', started: false, completed: false }]);
    const audit = await writeDispatchAudit({ action: 'dispatch_plan_recovery_merged', entityType: 'plan',
      entityId: target.planId, planId: target.planId, planDate: target.planDate,
      sessionId: target.actor, operatorName: target.actor, source: 'user_requested_recovery',
      before: { revision: current.revision, digest: current.digest },
      after: { revision: saved.revision, digest: saved.digest },
      details: { recoverySnapshotId: target.snapshotId, addedLoadId: target.loadId,
        addedOrderRefs: [target.orderRef], retainedDriverRecords: evidence.length,
        executedPrefixPreserved: true, existingEditLeasePreserved: true }
    });
    return { applied: apply, rolledBack: !apply, planId: target.planId, planDate: target.planDate,
      fromRevision: current.revision, toRevision: saved.revision, recoverySnapshotId: target.snapshotId,
      addedLoad: 'Load 3', driver: 'Sety', truck: 'CE94489', orderRef: target.orderRef,
      retainedLoads: loads(current).length, executedPrefixPreserved: true,
      driverRecordsUnchanged: evidence.length, originalDraftRetained: true,
      auditId: audit.id, digest: saved.digest };
  }, { rollback: !apply });
  if (!apply) assert.equal((await currentPlan()).digest, target.digest, 'Preview must roll back');
  console.log(JSON.stringify(result));
} finally { await closeDb(); }

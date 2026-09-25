import { query } from './db.js';

// All callers hold the fleet lock. This date lock also serializes against a
// first lease acquisition (which may have no row to lock yet).
export async function lockDispatchMaintenanceDate(planDate, execute = query) {
  await execute('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispatch-edit-lease:${String(planDate).slice(0, 10)}`]);
  const lease = await execute(`SELECT 1 FROM dispatch_plan_edit_leases
    WHERE plan_date=$1::date AND expires_at > clock_timestamp()`, [planDate]);
  return lease.rows.length > 0;
}

export async function enqueueDispatchPlanMaintenance(planId, request, execute = query) {
  const key = `${request.kind}:${request.canonicalRef || request.oldRef || request.refs?.join(',') || ''}`;
  await execute(`INSERT INTO dispatch_plan_maintenance (plan_id, requests)
    VALUES ($1, jsonb_build_object($2::text, $3::jsonb || '{"sequence":1}'::jsonb))
    ON CONFLICT (plan_id) DO UPDATE SET
      requests=dispatch_plan_maintenance.requests || jsonb_build_object($2::text,
        $3::jsonb || jsonb_build_object('sequence',dispatch_plan_maintenance.generation+1)),
      generation=dispatch_plan_maintenance.generation+1,
      attempts=0, last_error='', available_at=now(), requested_at=now()`,
  [planId, key, JSON.stringify(request)]);
}

export async function deferDispatchPlanMaintenance(plan, request, execute = query) {
  if (!await lockDispatchMaintenanceDate(plan.planDate, execute)) {return false;}
  await enqueueDispatchPlanMaintenance(plan.id, request, execute);
  return true;
}

export async function pendingDispatchPlanMaintenance(planId) {
  return (await query('SELECT * FROM dispatch_plan_maintenance WHERE plan_id=$1 FOR UPDATE', [planId])).rows[0] || null;
}

export function hasUnappliedDispatchPlanMaintenance(pending) {
  return Boolean(pending && Object.values(pending.requests).some(request => request.applied !== true));
}

export async function completeDispatchPlanMaintenance(row, remaining = {}) {
  if (Object.keys(remaining).length) {
    await query(`UPDATE dispatch_plan_maintenance SET requests=$3::jsonb,
      available_at=now()+interval '30 seconds'
      WHERE plan_id=$1 AND generation=$2`, [row.plan_id, row.generation, JSON.stringify(remaining)]);
  } else {
    await query('DELETE FROM dispatch_plan_maintenance WHERE plan_id=$1 AND generation=$2', [row.plan_id, row.generation]);
  }
}

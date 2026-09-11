import { query } from "./db.js";
import { evaluateExecutedPrefixPolicy } from "./dispatch-planner-performance.js";

function planIdentity(previousPlan = {}, nextPlan = {}) {
  return String(
    nextPlan?.id
    || nextPlan?.planId
    || previousPlan?.id
    || previousPlan?.planId
    || ""
  ).trim();
}

export async function evaluateDispatchExecutedPrefixPreservation({
  previousPlan = {},
  nextPlan = {},
  execute = query
} = {}) {
  const planId = planIdentity(previousPlan, nextPlan);
  if (!planId) return { allowed: true, conflicts: [] };
  const activity = await execute(
    `SELECT status, load_id, stop_id, stop_type, order_refs, job_details
       FROM driver_job_records
      WHERE plan_id = $1
        AND status IN ('in_progress', 'complete')
      ORDER BY id`,
    [planId]
  );
  return evaluateExecutedPrefixPolicy({
    previousPlan,
    nextPlan,
    activity: activity.rows
  });
}

export function dispatchExecutedPrefixConflictError(policy = {}) {
  const first = policy.conflicts?.[0] || {};
  return Object.assign(
    new Error(first.message || "Driver activity protects the executed physical prefix."),
    {
      code: first.code || "DISPATCH_ACTIVE_LOAD_LOCKED",
      status: 409,
      conflicts: policy.conflicts || []
    }
  );
}

export async function assertDispatchExecutedPrefixPreserved({
  previousPlan = {},
  nextPlan = {},
  execute = query
} = {}) {
  const policy = await evaluateDispatchExecutedPrefixPreservation({
    previousPlan,
    nextPlan,
    execute
  });
  if (!policy.allowed) throw dispatchExecutedPrefixConflictError(policy);
  return policy;
}

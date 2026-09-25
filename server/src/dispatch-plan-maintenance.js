import { isDeepStrictEqual } from 'node:util';
import { query, withTransaction, afterTransactionCommit } from './db.js';
import { DISPATCH_FLEET_PLANNING_LOCK } from './dispatch-fleet-status.js';
import { persistedDispatchPlan } from './dispatch-plan-fence.js';
import { digestDispatchPlan, dispatchPlanBoard } from './dispatch-planner-performance.js';
import { canonicalizeDispatchCoGroupIdentities } from './dispatch-co-group-identity.js';
import { evaluateDispatchExecutedPrefixPreservation } from './dispatch-executed-prefix-repository.js';
import {
  lockDispatchMaintenanceDate, pendingDispatchPlanMaintenance, completeDispatchPlanMaintenance
} from './dispatch-plan-maintenance-queue.js';

let emitMaintenanceEvent = () => {};
export function configureDispatchMaintenanceEvents(emit) { emitMaintenanceEvent = emit; }

export function notifyDispatchPlanMaintenance(plan, affectedOrderRefs = []) {
  afterTransactionCommit(() => emitMaintenanceEvent('dispatch.plan.saved', {
    planId: String(plan.id), planDate: plan.planDate, revision: plan.revision,
    source: 'order-maintenance', affectedOrderRefs, refreshOrderPool: true
  }));
}

async function maintenanceProposal(plan, request) {
  if (request.kind === 'sales_family') {
    const { applyDispatchSalesFamilyMaintenance } = await import('./dispatch-plan-repository.js');
    return applyDispatchSalesFamilyMaintenance(plan, request);
  }
  if (request.kind === 'co_identity') {return { plan: canonicalizeDispatchCoGroupIdentities(plan) };}
  if (request.kind === 'retire_splits') {
    // Retired snapshots are unplanned by the existing unsplit validation.
    const retired = await query(`SELECT tranid FROM sales_orders WHERE tranid=ANY($1::text[]) AND netsuite_active=false
      UNION SELECT tranid FROM transfer_orders WHERE tranid=ANY($1::text[]) AND netsuite_active=false`, [request.refs]);
    const refs = new Set(retired.rows.map(row => row.tranid));
    return { plan: { ...plan, orders: (plan.orders || []).filter(order => !refs.has(order.id)) } };
  }
  if (request.kind === 'po_reference') {
    const { rewriteDispatchSnapshotReference } = await import('./dispatch-repository.js');
    return { plan: rewriteDispatchSnapshotReference(plan, request) };
  }
  throw new Error(`Unknown Dispatch maintenance kind: ${request.kind}`);
}

// Runs inside the save/worker transaction after the persisted fence has been
// checked. Each proposal is evaluated separately: protected cleanup cannot
// block a valid dispatcher edit or unrelated maintenance.
export async function applyPendingDispatchPlanMaintenance(plan) {
  const pending = await pendingDispatchPlanMaintenance(plan.id);
  if (!pending) {return plan;}
  const editing = (await query(`SELECT 1 FROM dispatch_plan_edit_leases
    WHERE plan_date=$1::date AND expires_at>clock_timestamp()`, [plan.planDate])).rows.length > 0;
  let result = plan;
  const remaining = {};
  for (const [key, request] of Object.entries(pending.requests).sort(([, a], [, b]) => Number(a.sequence || 0) - Number(b.sequence || 0))) {
    const proposal = await maintenanceProposal(result, request);
    const policy = await evaluateDispatchExecutedPrefixPreservation({ previousPlan: result, nextPlan: proposal.plan });
    if (proposal.deferred || !policy.allowed) {remaining[key] = request;}
    else {
      result = proposal.plan;
      // A newer buffered edit may still contain the old identities. Keep the
      // correction for this editing session; release/expiry removes it once.
      if (editing && ['po_reference', 'retire_splits'].includes(request.kind)) {
        remaining[key] = { ...request, applied: true };
      }
    }
  }
  await completeDispatchPlanMaintenance(pending, remaining);
  return result;
}

async function persistMaintenance(previous, next, requests) {
  if (isDeepStrictEqual([previous.orders, previous.trucks, previous.summary], [next.orders, next.trucks, next.summary])) {return false;}
  const reasons = Object.values(requests);
  const reason = reasons.length === 1 && reasons[0].kind === 'sales_family'
    ? 'before_order_family_maintenance' : 'before_order_maintenance';
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id)
    VALUES ($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,'order-maintenance')`,
  [previous.id, previous.planDate, previous.revision, JSON.stringify(previous.orders), JSON.stringify(previous.trucks),
    JSON.stringify(previous.summary), previous.savedAt, reason]);
  next.revision = Number((await query(`UPDATE dispatch_plans SET revision=revision+1,updated_at=now()
    WHERE id=$1 RETURNING revision`, [previous.id])).rows[0].revision);
  const counts = dispatchPlanBoard(next);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,summary=$4::jsonb,
    saved_at=now(),plan_digest=$5,order_count=$6,truck_count=$7,load_count=$8,stop_count=$9 WHERE plan_id=$1`,
  [next.id, JSON.stringify(next.orders), JSON.stringify(next.trucks), JSON.stringify(next.summary), digestDispatchPlan(next),
    next.orders.length, counts.truckCount, counts.loadCount, counts.stopCount]);
  const [{ syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges, syncDispatchPlanLoadProjection },
    { syncDispatchDeliveryGroupsFromPlan }] = await Promise.all([
    import('./dispatch-planner-v2-repository.js'), import('./dispatch-delivery-group-repository.js')
  ]);
  await syncDispatchPlanLoadProjection(next);
  await syncDispatchPlanOrderAssignments(next);
  await syncDispatchPlanRelationEdges(next);
  await syncDispatchDeliveryGroupsFromPlan(next);
  notifyDispatchPlanMaintenance(next, [...new Set(reasons.flatMap(request => request.refs || [request.oldRef].filter(Boolean)))]);
  return true;
}

export async function processDispatchPlanMaintenance(planId) {
  return withTransaction(async () => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [DISPATCH_FLEET_PLANNING_LOCK]);
    const date = (await query('SELECT plan_date::text FROM dispatch_plans WHERE id=$1', [planId])).rows[0]?.plan_date;
    if (!date || await lockDispatchMaintenanceDate(date)) {return { deferred: true, changed: false };}
    const row = (await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1 FOR UPDATE OF p,s`, [planId])).rows[0];
    const pending = await pendingDispatchPlanMaintenance(planId);
    if (!pending) {return { changed: false, deferred: false };}
    const previous = persistedDispatchPlan(row);
    const next = await applyPendingDispatchPlanMaintenance(previous);
    const changed = await persistMaintenance(previous, next, pending.requests);
    return { changed, deferred: Boolean(await pendingDispatchPlanMaintenance(planId)), plan: next };
  });
}

export async function drainDispatchPlanMaintenance({ planDate = '', limit = 25 } = {}) {
  const rows = (await query(`SELECT m.plan_id,m.generation FROM dispatch_plan_maintenance m
    JOIN dispatch_plans p ON p.id=m.plan_id
    WHERE m.available_at <= now() AND ($1='' OR p.plan_date=NULLIF($1,'')::date)
      AND NOT EXISTS (SELECT 1 FROM dispatch_plan_edit_leases l WHERE l.plan_date=p.plan_date AND l.expires_at>clock_timestamp())
    ORDER BY m.available_at,m.plan_id LIMIT $2`, [planDate, Math.min(25, Math.max(1, Number(limit) || 25))])).rows;
  const summary = { processed: 0, changed: 0, failed: 0 };
  for (const row of rows) {
    try {
      const result = await processDispatchPlanMaintenance(row.plan_id);
      summary.processed++;
      if (result.changed) {summary.changed++;}
    } catch (error) {
      summary.failed++;
      await query(`UPDATE dispatch_plan_maintenance SET attempts=attempts+1,last_error=$3,
        available_at=now()+(LEAST(300,30*(attempts+1))*interval '1 second')
        WHERE plan_id=$1 AND generation=$2`, [row.plan_id, row.generation, String(error.message).slice(0, 1000)]);
      console.error(`Dispatch maintenance failed for plan ${row.plan_id}:`, error.message);
    }
  }
  return summary;
}

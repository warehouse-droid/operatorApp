import {isDeepStrictEqual} from 'node:util';
import {query} from './db.js';
import {persistedDispatchPlan} from './dispatch-plan-fence.js';
import {digestDispatchPlan, dispatchPlanBoard} from './dispatch-planner-performance.js';
import {compactDispatchOrderCard, dispatchOrderSearchText} from './dispatch-planner-optimization.js';
import {invalidateLoadRoute} from './dispatch-plan-order-projection.js';

async function persistPlan(previous, next, ref) {
  if (isDeepStrictEqual([previous.orders, previous.trucks], [next.orders, next.trucks])) {return;}
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id)
    VALUES($1,$2::date,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'sor_return_source_refresh','sor-automation')`,
  [previous.id, previous.planDate, previous.revision, JSON.stringify(previous.orders), JSON.stringify(previous.trucks),
    JSON.stringify(previous.summary), previous.savedAt]);
  next.revision = Number((await query('UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision', [previous.id])).rows[0].revision);
  const counts = dispatchPlanBoard(next);
  await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,trucks=$3::jsonb,saved_at=now(),plan_digest=$4,
    order_count=$5,truck_count=$6,load_count=$7,stop_count=$8 WHERE plan_id=$1`,
  [next.id, JSON.stringify(next.orders), JSON.stringify(next.trucks), digestDispatchPlan(next), next.orders.length,
    counts.truckCount, counts.loadCount, counts.stopCount]);
  const projections = await import('./dispatch-planner-v2-repository.js');
  await projections.syncDispatchPlanLoadProjection(next);
  await projections.syncDispatchPlanOrderAssignments(next);
  await projections.syncDispatchPlanRelationEdges(next);
  const {notifyDispatchPlanMaintenance} = await import('./dispatch-plan-maintenance.js');
  notifyDispatchPlanMaintenance(next, [ref]);
}

function invalidateChangedRoutes(previous, next) {
  const before = new Map(previous.trucks.flatMap(truck => truck.loads || []).map(load => [load.id, load]));
  return {...next, trucks: next.trucks.map(truck => ({...truck, loads: (truck.loads || []).map(load =>
    isDeepStrictEqual(before.get(load.id)?.stops, load.stops) ? load : invalidateLoadRoute(load))}))};
}

function changedTravelDestination(previous, next, activity) {
  const beforeLoads = new Map(previous.trucks.flatMap(truck => truck.loads || []).map(load => [load.id, load]));
  const afterLoads = new Map(next.trucks.flatMap(truck => truck.loads || []).map(load => [load.id, load]));
  return activity.filter(row => row.stop_type === 'travel').some(row => {
    const details = row.job_details || {};
    const target = details.toStopId || details.to_stop_id;
    const before = beforeLoads.get(row.load_id)?.stops || [];
    const after = afterLoads.get(row.load_id)?.stops || [];
    // Older travel records have no target ID. Preserve their recorded load's
    // destinations conservatively while still allowing equipment corrections.
    const protectedStops = target ? before.filter(stop => stop.id === target) : before;
    return protectedStops.some(stop => after.find(candidate => candidate.id === stop.id)?.location !== stop.location);
  });
}

async function refreshAssignedPlans(customOrder) {
  const {refreshDispatchCustomOrderInPlan} = await import('./dispatch-custom-order-repository.js');
  const {evaluateDispatchExecutedPrefixPreservation} = await import('./dispatch-executed-prefix-repository.js');
  const {overlayLockedLoadDerivedSchedule} = await import('./dispatch-load-assignment.js');
  const rows = (await query(`SELECT p.*,s.orders,s.trucks,s.summary,s.saved_at FROM dispatch_plans p
    JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.status<>'cancelled' AND EXISTS (
      SELECT 1 FROM dispatch_plan_order_assignments a WHERE a.plan_id=p.id AND lower(a.order_ref)=lower($1))
    ORDER BY p.id FOR UPDATE OF p,s`, [customOrder.refNumber])).rows;
  for (const row of rows) {
    const previous = persistedDispatchPlan(row);
    let next = invalidateChangedRoutes(previous, refreshDispatchCustomOrderInPlan(previous, customOrder));
    const activity = (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details FROM driver_job_records
      WHERE plan_id=$1 AND status IN ('in_progress','complete') AND mbt_assignment_withdrawn_at IS NULL`, [previous.id])).rows;
    next = overlayLockedLoadDerivedSchedule(previous, next, new Set(), {activityStatuses: activity});
    const policy = await evaluateDispatchExecutedPrefixPreservation({previousPlan: previous, nextPlan: next});
    if (!policy.allowed || changedTravelDestination(previous, next, activity)) {
      throw Object.assign(new Error('Source changed after return travel or execution started. Dispatch must review the change.'),
        {code: 'SOR_RETURN_EXECUTION_PROTECTED'});
    }
    await persistPlan(previous, next, customOrder.refNumber);
  }
}

// Caller owns the fleet lock and the return transaction. A projection failure
// rolls back the source update too; no reader can see half-refreshed work.
export async function refreshSorReturnProjections(ref) {
  const {listDispatchCustomOrders, dispatchOrderFromCustomOrder} = await import('./dispatch-custom-order-repository.js');
  const customOrder = (await listDispatchCustomOrders({search: ref, includeCancelled: true, includeCompleted: true}))
    .find(order => order.refNumber === ref);
  if (!customOrder) {throw new Error(`Missing rental return ${ref}`);}
  if (customOrder.status === 'open') {await refreshAssignedPlans(customOrder);}
  const order = dispatchOrderFromCustomOrder(customOrder);
  const definition = (await query('SELECT full_order FROM dispatch_global_order_splits WHERE split_ref=$1 FOR UPDATE', [ref])).rows[0];
  if (definition) {
    const next = {...definition.full_order, ...order, globalOrderDefinitionKind: 'derived', isSplit: false};
    await query(`UPDATE dispatch_global_order_splits SET full_order=$2::jsonb,card=$3::jsonb,search_text=$4,
      active=$5,eligible=$5,updated_at=now() WHERE split_ref=$1`,
    [ref, JSON.stringify(next), JSON.stringify(compactDispatchOrderCard(next)), dispatchOrderSearchText(next), customOrder.status === 'open']);
  }
  const {upsertDispatchOrderCatalog} = await import('./dispatch-order-catalog-repository.js');
  await upsertDispatchOrderCatalog({orders: [order], source: 'sor-return-source-refresh'});
}

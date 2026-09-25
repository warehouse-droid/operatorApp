import { overlayFulfilledTransferPlanning, fulfilledTransferPlanningRefs, assertTransferPlanningAllowed } from "./dispatch-fulfilled-to-repository.js";
import { query } from "./db.js";
import { listDriverPwaCompletedDispatchRefs, assertNoDriverPwaCompletedDispatchRefs } from "./dispatch-history-mode.js";
import { netSuiteClosedOrderFamilySql } from "./netsuite-closed-order-policy.js";
import { annotateFulfilledSalesOrders, fulfilledSalesDeliveryState, fulfilledSalesRef, fulfilledSalesOrderState } from "./dispatch-fulfilled-so-policy.js";

export async function listFulfilledSalesDeliveryStates(candidateRefs = []) {
  const refs = [...new Set(candidateRefs.map(fulfilledSalesRef).filter(Boolean))];
  if (!refs.length) return new Map();
  const result = await query(`
    SELECT candidate.*, row_to_json(source_order) AS source,
           membership.status AS split_status,
           (SELECT count(*) FROM sales_orders duplicate WHERE lower(btrim(duplicate.tranid)) = lower(btrim(candidate.tranid))) AS identity_count,
           (SELECT count(*) FROM sales_orders duplicate WHERE lower(btrim(duplicate.tranid)) = lower(btrim(source_order.tranid))) AS source_identity_count,
           state.application_status, state.reconciliation_status,
           ${netSuiteClosedOrderFamilySql("candidate", "SO")} AS family_closed,
           EXISTS (SELECT 1 FROM operator_reload_cycles cycle
                    WHERE cycle.sales_order_id IN (candidate.netsuite_id, source_order.netsuite_id)
                      AND cycle.status IN ('authorized','preparing','packed','in_progress')) AS active_reload,
           EXISTS (SELECT 1 FROM dispatch_effective_order_completion_events completion
                    WHERE completion.order_kind = 'SO'
                      AND lower(btrim(completion.order_ref)) IN (lower(btrim(candidate.tranid)), lower(btrim(source_order.tranid)))
                      AND completion.completion_evidence_type IN ('driver_job','manual_dispatch','direct_dependency')) AS operationally_completed
      FROM sales_orders candidate
      LEFT JOIN dispatch_scm_so_splits membership ON membership.split_so_id = candidate.netsuite_id
      JOIN sales_orders source_order ON source_order.netsuite_id = COALESCE(membership.source_so_id, candidate.netsuite_id)
      LEFT JOIN scm_reconciliation_order_state state ON state.order_kind = 'SO'
           AND state.source_order_netsuite_id = source_order.netsuite_id
     WHERE lower(btrim(candidate.tranid)) = ANY($1::text[])
        OR candidate.netsuite_id::text = ANY($1::text[])`, [refs]);
  const driverCompleted = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [...refs, ...result.rows.map(row => row.tranid)] });
  const states = new Map();
  for (const row of result.rows) {
    const state = fulfilledSalesDeliveryState(row, { driverCompleted: driverCompleted.has(fulfilledSalesRef(row.tranid)) });
    states.set(fulfilledSalesRef(row.tranid), state);
    states.set(String(row.netsuite_id), state);
  }
  return states;
}

export async function overlayFulfilledSalesDeliveryPlanning(orders = [], { preserveUnchanged = false } = {}) {
  const refs = [];
  const visit = order => {
    if (order?.type === "SO") refs.push(order.id, ...(order.childOrders || []));
    for (const child of order?.childOrderDetails || []) visit(child);
  };
  orders.forEach(visit);
  const states = await listFulfilledSalesDeliveryStates(refs);
  const annotated = annotateFulfilledSalesOrders(orders, states);
  if (!preserveUnchanged) return overlayFulfilledTransferPlanning(annotated);
  return overlayFulfilledTransferPlanning(annotated.map((order, index) => {
    const original = orders[index];
    if (original.dispatchFulfilledSalesPlanningEligible !== undefined) return order;
    const state = fulfilledSalesOrderState(original, states);
    return state?.fulfilled || state?.locallyCompleted || state?.blocked ? order : original;
  }));
}

export async function fulfilledSalesDeliveryPlanningRefs(refs = []) {
  const states = await listFulfilledSalesDeliveryStates(refs);
  return [...new Set([...refs.filter(ref => states.get(fulfilledSalesRef(ref))?.eligible), ...await fulfilledTransferPlanningRefs(refs)])];
}

export async function assertSalesDeliveryPlanningAllowed(refs = [], action = "plan these orders") {
  await assertNoDriverPwaCompletedDispatchRefs(refs, action);
  await assertTransferPlanningAllowed(refs, action);
  const states = await listFulfilledSalesDeliveryStates(refs);
  const conflicts = refs.filter(ref => {
    const state = states.get(fulfilledSalesRef(ref));
    return state && (state.locallyCompleted || state.blocked);
  });
  if (!conflicts.length) return;
  throw Object.assign(new Error(`Cannot ${action}: ${conflicts.join(", ")} is completed locally or restricted.`), {
    status: 409, code: "DISPATCH_SALES_DELIVERY_RESTRICTED", conflicts: conflicts.map(orderRef => ({ orderRef }))
  });
}

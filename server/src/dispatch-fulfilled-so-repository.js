import { overlayFulfilledTransferPlanning, fulfilledTransferPlanningRefs, assertTransferPlanningAllowed } from "./dispatch-fulfilled-to-repository.js";
import { query } from "./db.js";
import { assertDirectLinkedCargoPlanningAllowed } from "./dispatch-linked-cargo-repository.js";
import { listDriverPwaCompletedDispatchRefs, assertNoDriverPwaCompletedDispatchRefs } from "./dispatch-history-mode.js";
import { netSuiteClosedOrderFamilySql } from "./netsuite-closed-order-policy.js";
import { annotateFulfilledSalesOrders, fulfilledSalesDeliveryState, fulfilledSalesRef, fulfilledSalesOrderState } from "./dispatch-fulfilled-so-policy.js";

async function firstSalesSplitAliases(refs) {
  const firstSplitRefs = refs.filter(ref => ref.endsWith("-s1"));
  if (!firstSplitRefs.length) return [];
  // The first split can retain the source SO row under a registered display
  // reference. Resolve only that identity; unknown or materialized splits must
  // retain their own identity and lifecycle checks.
  const result = await query(`
    SELECT split.split_ref, split.parent_order_ref,
           EXISTS (SELECT 1 FROM dispatch_effective_order_completion_events completion
                    WHERE completion.order_kind = 'SO'
                      AND lower(btrim(completion.order_ref)) = lower(btrim(split.split_ref))
                      AND completion.completion_evidence_type IN ('driver_job','manual_dispatch','direct_dependency')) AS operationally_completed
      FROM dispatch_global_order_splits split
     WHERE split.active = true AND split.order_type = 'SO' AND split.definition_kind = 'split'
       AND lower(btrim(split.split_ref)) = ANY($1::text[])
       AND lower(btrim(split.split_ref)) = lower(btrim(split.parent_order_ref)) || '-s1'
       AND NOT EXISTS (SELECT 1 FROM sales_orders materialized
                        WHERE lower(btrim(materialized.tranid)) = lower(btrim(split.split_ref)))`, [firstSplitRefs]);
  return result.rows;
}

export async function listFulfilledSalesDeliveryStates(candidateRefs = []) {
  const refs = [...new Set(candidateRefs.map(fulfilledSalesRef).filter(Boolean))];
  if (!refs.length) return new Map();
  const aliases = await firstSalesSplitAliases(refs);
  const queryRefs = [...new Set([...refs, ...aliases.map(alias => fulfilledSalesRef(alias.parent_order_ref))])];
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
        OR candidate.netsuite_id::text = ANY($1::text[])`, [queryRefs]);
  const driverCompleted = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [...queryRefs, ...result.rows.map(row => row.tranid)] });
  const states = new Map();
  for (const row of result.rows) {
    const state = fulfilledSalesDeliveryState(row, { driverCompleted: driverCompleted.has(fulfilledSalesRef(row.tranid)) });
    states.set(fulfilledSalesRef(row.tranid), state);
    states.set(String(row.netsuite_id), state);
  }
  const parentRows = new Map(result.rows.filter(row => Number(row.identity_count) === 1)
    .map(row => [fulfilledSalesRef(row.tranid), row]));
  for (const alias of aliases) {
    const parent = parentRows.get(fulfilledSalesRef(alias.parent_order_ref));
    if (!parent) continue;
    const ref = fulfilledSalesRef(alias.split_ref);
    states.set(ref, fulfilledSalesDeliveryState({
      ...parent, operationally_completed: parent.operationally_completed || alias.operationally_completed
    }, { driverCompleted: driverCompleted.has(ref) || driverCompleted.has(fulfilledSalesRef(parent.tranid)) }));
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
  await assertDirectLinkedCargoPlanningAllowed(refs, action);
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

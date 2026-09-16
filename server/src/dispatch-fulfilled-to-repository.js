import { query } from "./db.js";
import { listDriverPwaCompletedDispatchRefs } from "./dispatch-history-mode.js";
import { netSuiteClosedOrderFamilySql } from "./netsuite-closed-order-policy.js";
import { transferRef, fulfilledTransferState, fulfilledTransferOrderState, annotateFulfilledTransferOrders } from "./dispatch-fulfilled-to-policy.js";

export async function listFulfilledTransferStates(candidateRefs = []) {
  const refs = [...new Set(candidateRefs.map(transferRef).filter(Boolean))];
  if (!refs.length) return new Map();
  const { rows: groups } = await query(`
    SELECT g.group_ref,g.active,array_agg(m.member_order_ref ORDER BY m.position) FILTER (WHERE m.member_order_ref IS NOT NULL) AS members
      FROM dispatch_global_order_groups g LEFT JOIN dispatch_global_order_group_members m ON m.group_ref=g.group_ref
      WHERE g.order_type='TO' AND lower(btrim(g.group_ref))=ANY($1::text[]) GROUP BY g.group_ref,g.active
    UNION ALL
    SELECT g.group_ref,g.active,array_agg(m.member_order_ref ORDER BY m.position) FILTER (WHERE m.member_order_ref IS NOT NULL)
      FROM dispatch_delivery_groups g LEFT JOIN dispatch_delivery_group_members m ON m.group_ref=g.group_ref
      WHERE g.order_type='transfer_order' AND lower(btrim(g.group_ref))=ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM dispatch_global_order_groups newer WHERE lower(btrim(newer.group_ref))=lower(btrim(g.group_ref)))
      GROUP BY g.group_ref,g.active`, [refs]);
  const lookupRefs = [...new Set([...refs, ...groups.flatMap(group => group.members || []).map(transferRef)])];
  const { rows } = await query(`SELECT candidate.*,row_to_json(source_order) AS source,membership.status AS split_status,
    (SELECT count(*) FROM transfer_orders duplicate WHERE lower(btrim(duplicate.tranid))=lower(btrim(candidate.tranid))) AS identity_count,
    (SELECT count(*) FROM transfer_orders duplicate WHERE lower(btrim(duplicate.tranid))=lower(btrim(source_order.tranid))) AS source_identity_count,
    ${netSuiteClosedOrderFamilySql("candidate", "TO")} AS family_closed,
    (EXISTS (SELECT 1 FROM dispatch_order_completion_events completion WHERE completion.order_kind='TO'
      AND lower(btrim(completion.order_ref)) IN (lower(btrim(candidate.tranid)),lower(btrim(source_order.tranid)))
      AND completion.completion_evidence_type IN ('driver_job','manual_dispatch','direct_dependency'))) AS operationally_completed,
    (EXISTS (SELECT 1 FROM unnest(ARRAY[candidate.outbound_operator_status,candidate.local_yard_order_status,
      source_order.outbound_operator_status,source_order.local_yard_order_status]) value WHERE lower(btrim(value)) IN ('hold','cancelled','canceled','reconcile review'))
     OR EXISTS (SELECT 1 FROM scm_transport_schedule schedule WHERE schedule.order_kind='TO'
      AND lower(btrim(schedule.order_ref)) IN (lower(btrim(candidate.tranid)),lower(btrim(source_order.tranid)))
      AND (lower(btrim(schedule.status)) IN ('hold','cancelled','canceled','reconcile review') OR schedule.reconciliation_blocked
        OR upper(btrim(COALESCE(schedule.method,'MBT')))<>'MBT'))
     OR EXISTS (SELECT 1 FROM scm_reconciliation_order_state state WHERE state.order_kind='TO'
      AND state.source_order_netsuite_id IN (candidate.netsuite_id,source_order.netsuite_id)
      AND (lower(btrim(state.reconciliation_status)) IN ('review','missing','error')
        OR lower(btrim(state.application_status)) IN ('hold','cancelled','canceled','reconcile review')))) AS lifecycle_restricted
    FROM transfer_orders candidate
    LEFT JOIN dispatch_scm_to_splits membership ON membership.split_to_id=candidate.netsuite_id
    JOIN transfer_orders source_order ON source_order.netsuite_id=COALESCE(membership.source_to_id,candidate.netsuite_id)
    WHERE lower(btrim(candidate.tranid))=ANY($1::text[]) OR candidate.netsuite_id::text=ANY($1::text[])`, [lookupRefs]);
  const driver = await listDriverPwaCompletedDispatchRefs({ candidateRefs: [...lookupRefs, ...rows.map(row => row.tranid)] });
  const states = new Map();
  for (const row of rows) {
    const state = fulfilledTransferState(row, { driverCompleted: driver.has(transferRef(row.tranid)) });
    states.set(transferRef(row.tranid), state); states.set(String(row.netsuite_id), state);
  }
  for (const group of groups) {
    const state = fulfilledTransferOrderState({ id: group.group_ref, childOrders: group.members || [] }, states);
    const locallyCompleted = driver.has(transferRef(group.group_ref)) || state?.locallyCompleted === true;
    const blocked = !group.active || !group.members?.length || state?.blocked === true;
    states.set(transferRef(group.group_ref), { group: true, fulfilled: state?.fulfilled === true, locallyCompleted, blocked,
      eligible: state?.eligible === true && !locallyCompleted && !blocked });
  }
  return states;
}

export async function fulfilledTransferPlanningRefs(refs = []) {
  const states = await listFulfilledTransferStates(refs);
  return refs.filter(ref => states.get(transferRef(ref))?.eligible);
}

export async function overlayFulfilledTransferPlanning(orders = []) {
  const refs = [];
  const visit = order => {
    if (order?.type === "TO") refs.push(order.id, ...(order.childOrders || []));
    (order?.childOrderDetails || []).forEach(visit);
  };
  orders.forEach(visit);
  if (!refs.length) return orders;
  return annotateFulfilledTransferOrders(orders, await listFulfilledTransferStates(refs));
}

export async function assertTransferPlanningAllowed(refs = [], action = "plan these orders") {
  const states = await listFulfilledTransferStates(refs);
  const conflicts = refs.filter(ref => { const state = states.get(transferRef(ref)); return state?.locallyCompleted || state?.blocked; });
  if (!conflicts.length) return;
  throw Object.assign(new Error(`Cannot ${action}: ${conflicts.join(", ")} is completed locally or restricted.`),
    { status: 409, code: "DISPATCH_TRANSFER_DELIVERY_RESTRICTED", conflicts: conflicts.map(orderRef => ({ orderRef })) });
}

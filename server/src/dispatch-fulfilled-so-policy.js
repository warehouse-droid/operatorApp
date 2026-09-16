import { isNetSuiteSalesOrderFulfilled } from "./sales-order-reconciliation.js";
import { isNetSuiteOrderClosed } from "./netsuite-closed-order-policy.js";

export const fulfilledSalesRef = (value) => String(value ?? "").trim().toLowerCase();

function validFulfilledSalesIdentity(row) {
  const split = Number(row.netsuite_id) < 0;
  return Number(row.identity_count) === 1
    && Number(row.source_identity_count) === 1
    && (!split || row.split_status === "active");
}

function restrictedSalesLifecycle(row, source) {
  return row.family_closed === true || isNetSuiteOrderClosed(row) || isNetSuiteOrderClosed(source)
    || Boolean(row.netsuite_missing_at) || Boolean(source.netsuite_missing_at)
    || row.active_reload === true;
}

function restrictedSalesStatus(row, source) {
  return [row.local_yard_order_status, row.operator_status, source.local_yard_order_status, source.operator_status,
    row.application_status].some(value => ["hold", "cancelled", "canceled", "reconcile review"].includes(fulfilledSalesRef(value)))
    || ["review", "missing", "error"].includes(fulfilledSalesRef(row.reconciliation_status));
}

function planningReason({ locallyCompleted, blocked, fulfilled }) {
  if (locallyCompleted) return "Delivery is already completed locally.";
  if (blocked) return "The order has an identity, lifecycle, or reconciliation restriction.";
  return fulfilled ? "NetSuite fulfillment is complete; Driver delivery is still pending." : "";
}

// Fulfillment is a NetSuite fact. A local Loaded status alone is not proof.
export function fulfilledSalesDeliveryState(row, { driverCompleted = false } = {}) {
  const source = row.source || row;
  const identityValid = validFulfilledSalesIdentity(row);
  const delivery = [row, source].every(order => order.sales_order_type === "Delivery");
  const fulfilled = identityValid && delivery && isNetSuiteSalesOrderFulfilled(source);
  const locallyCompleted = driverCompleted || row.operationally_completed === true;
  const blocked = (!identityValid && isNetSuiteSalesOrderFulfilled(source))
    || restrictedSalesLifecycle(row, source) || restrictedSalesStatus(row, source);
  return {
    fulfilled,
    eligible: fulfilled && !locallyCompleted && !blocked,
    locallyCompleted,
    blocked,
    reason: planningReason({ locallyCompleted, blocked, fulfilled })
  };
}

export function fulfilledSalesOrderState(order, states) {
  const children = Array.isArray(order?.childOrders) ? order.childOrders : [];
  if (!children.length) return states.get(fulfilledSalesRef(order?.id));
  const members = children.map(ref => states.get(fulfilledSalesRef(ref)));
  return {
    fulfilled: members.every(state => state?.fulfilled),
    eligible: members.every(state => state?.eligible),
    locallyCompleted: members.some(state => state?.locallyCompleted),
    blocked: members.some(state => !state || state.blocked),
    reason: "Every delivery in the group must still be eligible for planning."
  };
}

function completionFields(order, state) {
  if (!state?.fulfilled && !state?.locallyCompleted) return {};
  return { dispatchCompletionStatus: "completed", scm: { ...(order.scm || {}), status: "Completed" } };
}

export function annotateFulfilledSalesOrders(orders, states) {
  return orders.map(order => {
    if (order?.type !== "SO") return order;
    const state = fulfilledSalesOrderState(order, states);
    // Always replace client/snapshot eligibility flags with current authority.
    const eligible = state?.eligible === true;
    const restricted = state?.locallyCompleted === true || state?.blocked === true;
    return {
      ...order,
      dispatchFulfilledSalesPlanningEligible: eligible,
      dispatchPlanningRestricted: restricted,
      dispatchPlanningRestrictionReason: restricted ? `${order.id}: ${state.reason}` : "",
      ...completionFields(order, state),
      ...(order.childOrderDetails?.length ? { childOrderDetails: annotateFulfilledSalesOrders(order.childOrderDetails, states) } : {})
    };
  });
}

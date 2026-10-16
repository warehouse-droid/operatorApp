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

// Only the complete, order-specific packing reason is exempt. Other or mixed
// reconciliation errors still constrain planning, and the stored review stays intact.
/** @param {Record<string, any>} [row] */
export function isSalesPackingReconciliationReview(row = {}) {
  if (fulfilledSalesRef(row.reconciliation_status) !== "review") return false;
  const refs = [row.tranid, row.source?.tranid].map(fulfilledSalesRef).filter(Boolean);
  if (!refs.length) return false;
  const reason = fulfilledSalesRef(row.reconciliation_reason);
  return refs.some(ref => reason === `unsubmitted operator packing on ${ref}.`
    || reason === `sales order family reconciliation is blocked by an active operator packing draft on ${ref}.`);
}

/** @param {Record<string,any>} row @param {Record<string,any>} source @param {boolean} packingReviewOnly */
function restrictedSalesStatus(row, source, packingReviewOnly) {
  const applicationStatus = packingReviewOnly && fulfilledSalesRef(row.application_status) === "reconcile review"
    ? "" : row.application_status;
  return [row.local_yard_order_status, row.operator_status, source.local_yard_order_status, source.operator_status,
    applicationStatus].some(value => ["hold", "cancelled", "canceled", "reconcile review"].includes(fulfilledSalesRef(value)))
    || (!packingReviewOnly && ["review", "missing", "error"].includes(fulfilledSalesRef(row.reconciliation_status)));
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
  const locallyReopened = identityValid && row.locally_reopened === true;
  const fulfilled = identityValid && delivery && !locallyReopened && isNetSuiteSalesOrderFulfilled(source);
  const locallyCompleted = driverCompleted || row.operationally_completed === true;
  const packingReviewOnly = isSalesPackingReconciliationReview(row);
  const blocked = (!identityValid && isNetSuiteSalesOrderFulfilled(source))
    || restrictedSalesLifecycle(row, source) || restrictedSalesStatus(row, source, packingReviewOnly);
  return {
    fulfilled,
    locallyReopened: locallyReopened && !locallyCompleted && !blocked,
    localOperatorStatus: row.operator_status,
    localYardOrderStatus: row.local_yard_order_status,
    eligible: (fulfilled || locallyReopened) && !locallyCompleted && !blocked,
    locallyCompleted,
    blocked,
    packingReviewOnly,
    reason: planningReason({ locallyCompleted, blocked, fulfilled })
  };
}

/** @param {Record<string,any>} order @param {Map<string,Record<string,any>>} states */
export function fulfilledSalesOrderState(order, states) {
  const children = Array.isArray(order?.childOrders) ? order.childOrders : [];
  if (!children.length) return states.get(fulfilledSalesRef(order?.id));
  const members = children.map(ref => states.get(fulfilledSalesRef(ref)));
  return {
    fulfilled: members.every(state => state?.fulfilled),
    locallyReopened: members.some(state => state?.locallyReopened)
      && members.every(state => state && !state.fulfilled && !state.locallyCompleted && !state.blocked),
    localOperatorStatus: members.every(state => state?.localOperatorStatus === "open") ? "open" : "preparing",
    localYardOrderStatus: members.every(state => state?.localYardOrderStatus === "Open") ? "Open" : "Preparing",
    eligible: members.every(state => state?.eligible),
    locallyCompleted: members.some(state => state?.locallyCompleted),
    blocked: members.some(state => !state || state.blocked),
    packingReviewOnly: members.some(state => state?.packingReviewOnly),
    reason: "Every delivery in the group must still be eligible for planning."
  };
}

function completionFields(order, state) {
  if (state?.locallyReopened) return { dispatchCompletionStatus: "", dispatchCompletedAt: null,
    operatorStatus: state.localOperatorStatus, localYardOrderStatus: state.localYardOrderStatus,
    fulfillmentStatus: "not_fulfilled", scm: { ...(order.scm || {}), status: state.localYardOrderStatus || "Open" } };
  if (!state) return {};
  if (state.locallyCompleted) return { dispatchCompletionStatus: "completed", scm: { ...(order.scm || {}), status: "Completed" } };
  // Clear cached accounting completion only in the Dispatch projection.
  return { dispatchCompletionStatus: "", dispatchCompletedAt: null,
    ...(fulfilledSalesRef(order.scm?.status) === "completed" ? { scm: { ...order.scm, status: "Queued" } } : {}) };
}

export function annotateFulfilledSalesOrders(orders, states) {
  return orders.map(order => {
    if (order?.type !== "SO") return order;
    const state = fulfilledSalesOrderState(order, states);
    // Always replace client/snapshot eligibility flags with current authority.
    const eligible = state?.eligible === true;
    const restricted = state?.locallyCompleted === true || state?.blocked === true;
    // Group cards can retain an old packing Review. Current member authority
    // must govern planning before the saved plan or cached card is refreshed.
    const cachedGroupReview = Boolean(order.childOrders?.length) && (
      order.reconciliationBlocked === true
      || fulfilledSalesRef(order.reconciliationStatus) === "review"
      || fulfilledSalesRef(order.reconciliationApplicationStatus) === "reconcile review"
      || fulfilledSalesRef(order.scm?.status) === "reconcile review"
    );
    const planningReviewIgnored = state?.packingReviewOnly || cachedGroupReview;
    return {
      ...order,
      localOrderReopened: state?.locallyReopened === true,
      dispatchFulfilledSalesPlanningEligible: eligible,
      dispatchPlanningRestricted: restricted,
      dispatchPlanningRestrictionReason: restricted ? `${order.id}: ${state.reason}` : "",
      ...(planningReviewIgnored && !restricted ? {
        reconciliationBlocked: false,
        reconciliationStatus: "current",
        reconciliationApplicationStatus: "",
        ...(order.scm ? { scm: { ...order.scm,
          status: fulfilledSalesRef(order.scm.status) === "reconcile review" ? "Queued" : order.scm.status,
          reconciliationStatus: "current", reconciliationApplicationStatus: "" } } : {})
      } : {}),
      ...completionFields(order, state),
      ...(order.childOrderDetails?.length ? { childOrderDetails: annotateFulfilledSalesOrders(order.childOrderDetails, states) } : {})
    };
  });
}

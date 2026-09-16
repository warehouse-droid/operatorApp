export const transferRef = value => String(value ?? "").trim().toLowerCase();

export function isNetSuiteTransferFulfilled(order = {}) {
  const label = transferRef(order.status_text || order.statusText).replace(/^transfer order\s*:\s*/, "");
  return (order.status === "F" && label === "pending receipt") || (order.status === "G" && label === "received");
}

export function fulfilledTransferState(row, { driverCompleted = false } = {}) {
  const source = row.source || row;
  const valid = Number(row.identity_count) === 1 && Number(row.source_identity_count) === 1
    && (Number(row.netsuite_id) >= 0 || row.split_status === "active");
  const fulfilled = valid && isNetSuiteTransferFulfilled(source);
  const locallyCompleted = driverCompleted || row.operationally_completed === true;
  const blocked = (!valid && isNetSuiteTransferFulfilled(source)) || row.family_closed === true
    || Boolean(row.netsuite_missing_at || source.netsuite_missing_at) || row.lifecycle_restricted === true;
  return { fulfilled, locallyCompleted, blocked, eligible: fulfilled && !locallyCompleted && !blocked };
}

export function fulfilledTransferOrderState(order, states) {
  const authority = states.get(transferRef(order?.id));
  if (authority?.group) return authority;
  if (!order?.childOrders?.length) return states.get(transferRef(order?.id));
  const members = order.childOrders.map(ref => states.get(transferRef(ref)));
  return { fulfilled: members.every(state => state?.fulfilled), eligible: members.every(state => state?.eligible),
    locallyCompleted: members.some(state => state?.locallyCompleted), blocked: members.some(state => !state || state.blocked) };
}

export function annotateFulfilledTransferOrders(orders, states) {
  return orders.map(order => {
    if (order?.type !== "TO") return order;
    const state = fulfilledTransferOrderState(order, states), eligible = state?.eligible === true;
    const restricted = state?.locallyCompleted === true || state?.blocked === true || (!eligible && order.dispatchPlanningRestricted === true);
    return { ...order, dispatchFulfilledTransferPlanningEligible: eligible,
      dispatchPlanningRestricted: restricted,
      dispatchPlanningRestrictionReason: restricted
        ? (state?.locallyCompleted ? `${order.id}: Delivery is already completed locally.` : order.dispatchPlanningRestrictionReason || `${order.id}: The transfer has a lifecycle or reconciliation restriction.`) : "",
      ...(state?.fulfilled || state?.locallyCompleted ? { dispatchCompletionStatus: "completed", scm: { ...(order.scm || {}), status: "Completed" } } : {}),
      ...(order.childOrderDetails?.length ? { childOrderDetails: annotateFulfilledTransferOrders(order.childOrderDetails, states) } : {}) };
  });
}

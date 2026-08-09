function text(value) {
  return String(value ?? "").trim();
}

export function dependencyBlocksDispatchStructureChange(dependency = {}) {
  const mode = text(dependency.dependency_mode ?? dependency.mode);
  return mode !== "yard_replenishment";
}

export function dispatchDependencyOrderRefs(order = {}) {
  return [...new Set([
    order.id,
    order.tranid,
    order.originalOrderId,
    ...(Array.isArray(order.childOrders) ? order.childOrders : []),
    ...(Array.isArray(order.childOrderDetails)
      ? order.childOrderDetails.flatMap((child) => [child?.id, child?.originalOrderId])
      : [])
  ].map(text).filter(Boolean))];
}

export function everySalesAssignmentFollowsTransfer(
  transferAssignment,
  salesAssignments = [],
  transferPrecedesSales
) {
  if (!Array.isArray(salesAssignments) || !salesAssignments.length) return false;
  if (typeof transferPrecedesSales !== "function") return false;
  return salesAssignments.every((assignment) =>
    transferPrecedesSales(transferAssignment, assignment));
}

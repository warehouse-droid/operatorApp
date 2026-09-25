function text(value) {
  return String(value ?? "").trim();
}

export function dependencyBlocksDispatchStructureChange(dependency = {}, { allowEstablishedGroupTargets = [] } = {}) {
  const mode = text(dependency.dependency_mode ?? dependency.mode);
  if (mode === "yard_replenishment") {return false;}
  const sourceRef = text(dependency.sales_order_ref);
  const canGroupDirect = mode === "direct_to_customer"
    && dependency.dispatch_target_kind === "normal"
    && text(dependency.dispatch_target_ref || sourceRef) === sourceRef
    && ["active", "attention"].includes(dependency.status)
    && dependency.has_execution_progress === false
    && allowEstablishedGroupTargets.some((target) =>
      text(target.sourceOrderRef) === sourceRef && Boolean(text(target.groupRef))
    );
  return !canGroupDirect;
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

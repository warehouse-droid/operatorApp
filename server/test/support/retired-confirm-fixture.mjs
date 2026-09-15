import { cargoFunctions } from "./sales-order-cargo-fixture.mjs";

export function retiredConfirmBrowser(plan, extra = {}) {
  return cargoFunctions("../../public/dispatch.js", [
    "planPayload", "isDispatchPlanOwnedOrder", "dispatchOrderRefKey",
    "assignedOrderIdsForTrucks", "groupedChildOrderIds", "splitParentOrderIds", "splitParentOrderId",
    "canonicalDispatchOrderType", "isAggregateDispatchCoGroup"
  ], {
    currentPlan: plan, currentPlanDate: plan.planDate, orders: plan.orders,
    normalizePlanBeforeSave() {}, trucksWithTimingMetadata: () => plan.trucks,
    withoutAuthoritativelyRetiredStops: value => value,
    withoutAuthoritativelyRetiredOrders: value => value,
    planEditLeaseToken: "", nextPlanSaveMode: "", pendingPlanMutationAction: "dispatch_plan_autosaved",
    pendingGlobalOrderRetireRefs: new Set(), pendingGlobalOrderReactivateRefs: new Set(),
    nextSaveNeedsOrderPoolRefresh: false, planSummary: () => plan.summary || {},
    ...extra
  });
}

export function incidentOrders() {
  return [
    { id: "SOA08404-S2", type: "SO", sourceTable: "sales_orders", originalOrderId: "SOA08404",
      netsuiteId: -148211376291204, raw: { tranid: "SOA08404-S2" }, items: [{ quantity: 12 }] },
    { id: "CO-GOA-7894-7895", type: "CO", sourceTable: "local_co_orders", sourceOrderId: "GOA-7894-7895",
      globalGroupDefinition: false, childOrders: ["SOA07894", "SOA07895"], raw: { tranid: "CO-GOA-7894-7895" } }
  ];
}

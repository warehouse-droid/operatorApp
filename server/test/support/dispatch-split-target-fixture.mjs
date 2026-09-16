import { cargoFunctions } from "./sales-order-cargo-fixture.mjs";

export function splitTargetOrders() {
  return ["SOA08748", "SOA08716", "SOA08717"].map(id => ({
    id, type: "SO", sourceTable: "sales_orders", customer: `Customer ${id}`,
    address: "Test customer address", notes: "", operatorStatus: "not_ready",
    pallets: 2, salesQty: 4, weight: 40, items: [{ id: "line1", quantity: 4 }],
    ...(id === "SOA08716" ? { orderDependencies: [{
      id: "242", mode: "direct_to_customer", status: "in_transit",
      salesOrderRef: id, transferOrderRef: "TOB01086"
    }] } : {})
  }));
}

export function splitTargetBrowser(orders = splitTargetOrders(), selection = ["SOA08748"]) {
  const tooltip = { style: {}, innerHTML: "", className: "" };
  const functions = cargoFunctions("../../public/dispatch.js", [
    "orderById", "selectedOrder", "selectedOrders", "showOrderTooltip",
    "renderSelectedOrderActions", "splitOrder"
  ], {
    orders, orderCatalog: [], assignedOrderEvidenceById: new Map(),
    selectedOrderId: selection[0] || "", selectedOrderIds: new Set(selection), activeOrderType: "SO",
    document: { getElementById: () => tooltip }, window: { innerWidth: 1200, innerHeight: 900 },
    tooltipItemRowsForOrder: target => target.items.map(item => `<span>${item.quantity}</span>`).join(""),
    escapeHtml: value => String(value ?? ""), orderUnitText: () => "pieces",
    orderFootprintPallets: target => target.pallets, orderWeightLbs: target => target.weight,
    formatLbs: value => `${value} lbs`,
    isDispatchPlanningRestricted: () => false, isReviewOnlyOrder: () => false,
    isScmReconciliationBlocked: () => false, isSalesOrderReattempt: () => false,
    supportsTransitCoForOrder: () => false, canConsolidatePick: () => false,
    dispatchCompletionOrderKind: () => "SO", SALES_PLANNING_HOST: false,
    splitTotalsForPart: target => ({
      pallets: 1, salesQty: 2, weight: 20,
      items: target.items.map(item => ({ ...item, quantity: item.quantity / 2 }))
    })
  });
  const hover = ref => functions.showOrderTooltip({
    clientX: 100, clientY: 100,
    target: { closest: selector => selector === "[data-order]" && ref ? { dataset: { order: ref } } : null }
  });
  return { ...functions, hover, tooltip };
}

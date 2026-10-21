import { compactDispatchOrderCard } from "../../src/dispatch-planner-optimization.js";
import { cargoFunctions } from "./sales-order-cargo-fixture.mjs";

export function pickupCardPlanner(full, { compact = true } = {}) {
  const orders = [], catalog = [];
  const helpers = ["normalizeOrder", "canonicalDispatchOrderType", "splitParentOrderId", "flattenDispatchGroupMembers",
    "groupedOrderDependencies", "groupedOrderDependencyLabels", "activeTransitPickupLocations",
    "dispatchRelationshipPickupLocations", "uniqueDispatchLocationLabels", "normalizedPickupLocation", "dispatchLocationHierarchyRoot",
    "effectiveOrderPalletQuantity", "specialOrderPalletItemQuantity", "normalizePoDropoffs", "applyPlannedAssignments", "orderById",
    "isOperationalDispatchItem", "itemHasQuantity", "tooltipItemsForOrder", "poRouteProjectionForOrder", "routeItemsForOrder",
    "positiveBalance", "isOwnYardCode", "retainedDirectPickupManifest", "groupPickupSourceItems", "directPickupEntriesForLocation",
    "directPickupItemsForLocation", "poPickupEntriesForLocation", "poPickupItemsForLocation", "directPickupAllocatedForItem",
    "spreadDirectPickupAllocation", "itemForPickupLocation", "requiredPickupLocations", "sameDispatchLocation", "isMbbsSpecialLinkLine"];
  const api = cargoFunctions(process.env.PO_IDENTITY_BROWSER_SOURCE || "../../public/dispatch.js", helpers, {
    orders, orderCatalog: catalog, assignedOrderEvidenceById: new Map(),
    plannedAssignmentRefs: new Set(), plannedAssignmentsByRef: new Map(),
    isAuthoritativelyRetiredOrderRef: () => false, withoutAuthoritativelyRetiredOrders: entries => entries,
    ownYardForLocation: location => ["3445", "2967", "12441", "150"].includes(String(location)),
    replenishmentDependencyComplete: () => false
  });
  const normalized = api.normalizeOrder(compact ? compactDispatchOrderCard(full) : full);
  orders.push(normalized);
  catalog.push(normalized);
  return { ...api, order: () => api.orderById(full.id), refresh: () => api.applyPlannedAssignments([]) };
}

export function pickupCardGroup(yard = "2967") {
  const child = { id: "SO-CARD-CHILD", type: "SO", sourceYard: yard, pickupLocations: [yard],
    items: [{ itemId: 1136, sku: "PAVERS", itemType: "InvtPart", quantity: 135, pieces: 135 }] };
  return { id: "GO-CARD-PICKUP", type: "SO", sourceYard: yard, pickupLocations: [yard],
    childOrders: [child.id], childOrderDetails: [child], items: child.items };
}

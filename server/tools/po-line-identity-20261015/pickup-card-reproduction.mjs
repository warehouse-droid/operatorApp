import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { compactDispatchOrderCard } from "../../src/dispatch-planner-optimization.js";
import { dispatchRequiredPickupVisitLocations, materializeDispatchPickupVisits } from "../../src/dispatch-pickup-visits.js";
import { cargoFunctions } from "../../test/support/sales-order-cargo-fixture.mjs";

const fixed = process.argv[2] === "fixed";
const child = { id: "SO-CARD-CHILD", type: "SO", sourceYard: "2967", pickupLocations: ["2967"],
  pallets: 3, items: [{ itemId: 1136, sku: "PAVERS", itemType: "InvtPart", quantity: 135, pallets: 3, pieces: 135 }] };
const full = { id: "GO-CARD-PICKUP", type: "SO", sourceYard: "2967", pickupLocations: ["2967"],
  pallets: 3, childOrders: [child.id], childOrderDetails: [child], items: child.items };
const card = compactDispatchOrderCard(full);
const stateOrders = [], catalog = [];
const helpers = ["normalizeOrder", "canonicalDispatchOrderType", "splitParentOrderId", "flattenDispatchGroupMembers",
  "groupedOrderDependencies", "groupedOrderDependencyLabels", "activeTransitPickupLocations",
  "dispatchRelationshipPickupLocations", "uniqueDispatchLocationLabels", "normalizedPickupLocation", "dispatchLocationHierarchyRoot",
  "effectiveOrderPalletQuantity", "specialOrderPalletItemQuantity", "normalizePoDropoffs", "applyPlannedAssignments", "orderById",
  "isOperationalDispatchItem", "itemHasQuantity", "tooltipItemsForOrder", "poRouteProjectionForOrder", "routeItemsForOrder",
  "positiveBalance", "isOwnYardCode", "retainedDirectPickupManifest", "groupPickupSourceItems", "directPickupEntriesForLocation",
  "directPickupItemsForLocation", "poPickupEntriesForLocation", "poPickupItemsForLocation", "directPickupAllocatedForItem",
  "spreadDirectPickupAllocation", "itemForPickupLocation", "requiredPickupLocations", "sameDispatchLocation", "isMbbsSpecialLinkLine"];
const api = cargoFunctions("../../public/dispatch.js", helpers, {
  orders: stateOrders, orderCatalog: catalog, assignedOrderEvidenceById: new Map(),
  plannedAssignmentRefs: new Set(), plannedAssignmentsByRef: new Map(),
  isAuthoritativelyRetiredOrderRef: () => false, withoutAuthoritativelyRetiredOrders: orders => orders,
  ownYardForLocation: location => ["3445", "2967"].includes(String(location)),
  replenishmentDependencyComplete: () => false
});
const normalized = api.normalizeOrder(card);
stateOrders.push(normalized);
catalog.push(normalized);
const before = api.requiredPickupLocations(normalized);
api.applyPlannedAssignments([]);
const after = api.orderById(full.id);
const canonicalRequired = dispatchRequiredPickupVisitLocations(full);
const route = { orders: [full], trucks: [{ id: "T", loads: [{ id: "L", pickupVisitSchemaVersion: 1, stops: [
  { id: "P1", type: "pick", orderId: full.id, orderRefs: [full.id], location: "3445" },
  { id: "P2", type: "pick", orderId: full.id, orderRefs: [full.id], location: "2967" },
  { id: "D", type: "drop", orderId: full.id }
] }] }] };
const conflicts = materializeDispatchPickupVisits(route, { allowLegacyPassthrough: true }).conflicts;
assert.equal(card.childOrderDetails, undefined);
assert.deepEqual(before, ["2967"]);
assert.equal(after.childOrderDetails[0].sourceYard, fixed ? "" : "3445");
assert.deepEqual(api.requiredPickupLocations(after), fixed ? ["2967"] : ["2967", "3445"]);
assert.equal(after.pallets, fixed ? 3 : 0);
assert.deepEqual(canonicalRequired, ["2967"]);
assert.ok(conflicts.some(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_WRONG_YARD"));
const generated = structuredClone(route);
generated.trucks[0].loads[0].stops = [
  ...api.requiredPickupLocations(after).map((location, index) => ({ id: "P-" + index,
    type: "pick", orderId: full.id, orderRefs: [full.id], location })),
  { id: "D", type: "drop", orderId: full.id }
];
const generatedConflicts = materializeDispatchPickupVisits(generated, { allowLegacyPassthrough: true }).conflicts;
if (fixed) assert.deepEqual(generatedConflicts, []);
const result = { ...(fixed ? { corrected: true } : { reproduced: true }), syntheticFixture: true,
  sourceHash: createHash("sha256").update(fs.readFileSync("public/dispatch.js")).digest("hex"),
  compactCardOmitsMemberDetails: true, beforeAssignmentRefresh: before,
  afterAssignmentRefresh: api.requiredPickupLocations(after),
  memberSource: after.childOrderDetails[0].sourceYard, pallets: after.pallets,
  authoritativeSources: canonicalRequired,
  generatedRouteConflicts: generatedConflicts,
  saveConflict: conflicts.find(conflict => conflict.code === "DISPATCH_PICKUP_ORDER_WRONG_YARD") };
fs.writeFileSync(fixed ? "/evidence/pickup-card-fixed.json" : "/evidence/pickup-card-reproduction.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));

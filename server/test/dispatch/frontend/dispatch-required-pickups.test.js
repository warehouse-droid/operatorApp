import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import fc from "fast-check";

import { dispatchRequiredPickupVisitLocations, materializeDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";
import { reconcileDependencyManagedPickups } from "../../../src/scm-dependency-plan-reconciler.js";

const source = await readFile(new URL("../../../public/dispatch.js", import.meta.url), "utf8");

function sourceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing production function ${name}`);
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(end > start, `Missing function boundary for ${name}`);
  return source.slice(start, end);
}

// Only the routing fields from recovery snapshot 16901 are needed to reproduce
// SOB119507. Charges and credits must remain absent from the cargo manifest.
function serviceOrder(overrides = {}) {
  return {
    id: "SOB119507",
    type: "SO",
    sourceYard: "3445",
    pickupLocations: ["3445"],
    address: "100 Test Customer Road",
    items: [
      { sku: "Delivery Charge", itemId: 1987, itemType: "OthCharge", quantity: 1 },
      { sku: "Sales Credit - Hardscaping", itemId: 4646, itemType: "NonInvtPart", quantity: 1 }
    ],
    ...overrides
  };
}

function cargoOrder(overrides = {}) {
  return serviceOrder({
    id: "SO-CARGO",
    items: [{ sku: "Pavers", itemType: "InvtPart", quantity: 20, pallets: 1 }],
    ...overrides
  });
}

function stop(id, type, orderId, extras = {}) {
  return { id, loadId: "LOAD", type, orderId, location: "3445", ...extras };
}

function planner(planOrders, stops = []) {
  const load = { id: "LOAD", pickupVisitSchemaVersion: 1, stops: structuredClone(stops) };
  const trucks = [{ id: "TRUCK", loads: [load] }];
  const orderById = (id) => planOrders.find((order) => order.id === id);
  const stopHasDriverActivity = (_load, entry) => ["complete", "in_progress"].includes(entry.status);
  const helpers = [
    "dispatchLocationHierarchyRoot", "normalizedPickupLocation", "sameDispatchLocation",
    "uniqueDispatchLocationLabels", "orderRequiresPickupLocation", "pickupStopOrderRefs",
    "pickupStopIncludesOrder", "pickupOrdersForStop", "isMbbsSpecialLinkLine",
    "isOperationalDispatchItem", "itemHasQuantity", "tooltipItemsForOrder",
    "poRouteProjectionForOrder", "routeItemsForOrder", "positiveBalance", "isOwnYardCode",
    "directPickupEntriesForLocation", "directPickupItemsForLocation", "poPickupEntriesForLocation",
    "poPickupItemsForLocation", "directPickupAllocatedForItem", "itemForPickupLocation",
    "requiredPickupLocations", "opaqueDispatchStopId", "materializePickupVisitOrderRefs",
    "driverActivityDetails", "dispatchEditableRouteBoundary", "lateOrderRoutePlacement",
    "makePickupStop", "enablePickupVisitSchema", "ensurePickupStops", "addOrderToLoad",
    "pullExistingStop", "cleanupOrphanPickupStops", "syncPickupStops", "sequenceWarningsForStops"
  ];
  const dependencies = {
    trucks,
    orderById,
    stopOrder: (entry) => orderById(entry.orderId),
    findLoad: () => ({ truck: trucks[0], load }),
    ownYardForLocation: (location) => ["3445", "2967", "12441", "150"].includes(String(location).split(" : ")[0]),
    stopHasDriverActivity,
    loadHasDriverActivity: () => load.stops.some((entry) => stopHasDriverActivity(load, entry)),
    loadDriverActivityRecords: () => [],
    samePhysicalAddress: (left, right) => left === right,
    stopAddress: (_entry, order) => order.address,
    isDispatchPlanningRestricted: () => false,
    isScmReconciliationBlocked: () => false,
    loadHasAssignedDriver: () => true,
    isOrderPlannedOutsideCurrentPlan: () => false,
    isScmGroupedPoOrder: () => false,
    normalizeReplenishmentTransferInsertIndex: (_order, _load, index) => index,
    normalizeReplenishmentDependentInsertIndex: (_order, _load, index) => index,
    replenishmentPlacementBlockMessage: () => "",
    summarizeLoad: (entry) => structuredClone(entry),
    hasUsableDispatchAddress: () => true,
    transitBlockMessage: () => "",
    coTimingViolation: () => "",
    summarizeOrder: (order) => ({ id: order.id }),
    logDispatchAudit: () => {},
    replenishmentSequenceWarningsForStops: () => []
  };
  const api = Function(...Object.keys(dependencies), `
    "use strict";
    let selectedOrderId, selectedLoadId;
    const pendingOperatorAlertRefs = new Set();
    ${helpers.map(sourceFunction).join("\n")}
    return { ${helpers.join(", ")} };
  `)(...Object.values(dependencies));
  return {
    ...api,
    load,
    validate: () => materializeDispatchPickupVisits(
      JSON.parse(JSON.stringify({ orders: planOrders, trucks })),
      { allowLegacyPassthrough: true }
    ).conflicts
  };
}

test("fee-only orders such as SOB119507 require no physical pickup in either browser or validator", () => {
  const order = serviceOrder();
  const ui = planner([order]);
  assert.deepEqual(ui.tooltipItemsForOrder(order, { pickupLocation: "3445" }), []);
  assert.deepEqual(ui.requiredPickupLocations(order), []);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), []);
});

test("adding a fee-only order to a load leaves its existing physical pickup allocation unchanged", () => {
  const order = serviceOrder();
  const cargo = cargoOrder();
  const ui = planner([order, cargo], [
    stop("P-CARGO", "pick", cargo.id, { orderRefs: [cargo.id] }),
    stop("D-CARGO", "drop", cargo.id)
  ]);
  assert.equal(ui.addOrderToLoad(order.id, "LOAD", "drop", "", 1), true);
  assert.deepEqual(ui.load.stops[0].orderRefs, [cargo.id]);
  assert.deepEqual(ui.load.stops.map((entry) => entry.type), ["pick", "drop", "drop"]);
  assert.deepEqual(ui.validate(), []);
});

test("adding a fee-only order to an empty load saves its delivery without an empty pickup", () => {
  const order = serviceOrder();
  const ui = planner([order]);
  assert.equal(ui.addOrderToLoad(order.id, "LOAD"), true);
  assert.deepEqual(ui.load.stops.map((entry) => entry.type), ["drop"]);
  assert.deepEqual(ui.validate(), []);
});

test("draft reconciliation keeps empty pickups omitted across repeated save preparation", () => {
  const order = serviceOrder();
  const cargo = cargoOrder();
  const ui = planner([order, cargo], [
    stop("P-CARGO", "pick", cargo.id, { orderRefs: [cargo.id] }),
    stop("D-SERVICE", "drop", order.id),
    stop("D-CARGO", "drop", cargo.id)
  ]);
  ui.syncPickupStops();
  ui.cleanupOrphanPickupStops();
  assert.deepEqual(ui.load.stops[0].orderRefs, [cargo.id]);
  assert.deepEqual(ui.validate(), []);
  const once = structuredClone(ui.load);
  ui.syncPickupStops();
  ui.cleanupOrphanPickupStops();
  assert.deepEqual(ui.load, once, "repeated refresh/save preparation must be idempotent");
});

test("a late fee-only delivery does not create an empty revisit or change a completed pickup", () => {
  const order = serviceOrder();
  const cargo = cargoOrder();
  const completedPickup = stop("P-DONE", "pick", cargo.id, { orderRefs: [cargo.id], status: "complete" });
  const ui = planner([order, cargo], [completedPickup, stop("D-CARGO", "drop", cargo.id)]);
  assert.equal(ui.addOrderToLoad(order.id, "LOAD"), true);
  assert.deepEqual(ui.load.stops[0], completedPickup);
  assert.equal(ui.load.stops.filter((entry) => entry.type === "pick").length, 1);
  assert.deepEqual(ui.validate(), []);
});

test("fee-only delivery has no misleading missing-pickup warning", () => {
  const order = serviceOrder();
  const ui = planner([order], [stop("D-SERVICE", "drop", order.id)]);
  assert.deepEqual(ui.sequenceWarningsForStops(ui.load.stops), []);
});

test("cargo fully allocated to direct pickup still omits the empty source-yard pickup", () => {
  const order = cargoOrder({
    pickupLocations: ["3445", "2967"],
    directPickupManifest: [{
      location: "2967",
      items: [{ sku: "Pavers", quantity: 20, palletQty: 1 }]
    }]
  });
  const ui = planner([order]);
  assert.deepEqual(ui.requiredPickupLocations(order), ["2967"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), ["2967"]);
});

test("empty order details retain the existing allocation filter and explicit pickup override", () => {
  const order = serviceOrder({ items: [], pickupLocations: ["195"] });
  const ui = planner([order]);
  assert.deepEqual(ui.requiredPickupLocations(order), []);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), []);
  assert.deepEqual(ui.requiredPickupLocations({ ...order, pickupAddressOverride: "External pickup" }), ["195"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations({ ...order, pickupAddressOverride: "External pickup" }), ["195"]);
});

function vendorLinkedOrder(overrides = {}) {
  return cargoOrder({
    id: "SOB118741",
    pickupLocations: ["3445", "PERMACON Milton"],
    items: [
      { itemId: 2055, sku: "MBBS-Special Order", itemType: "NonInvtPart", quantity: 451.2, poAllocatedSalesQty: 451.2 },
      { sku: "5% discount", itemType: "Discount", quantity: 0 },
      { itemId: 1784, sku: "PALLET", itemType: "InvtPart", quantity: 5, poAllocatedSalesQty: 5 },
      { sku: "Delivery Charge", itemType: "OthCharge", quantity: 1 }
    ],
    poPickupManifest: [{
      location: "PERMACON Milton",
      items: [
        { itemId: 2055, sku: "MBBS-Special Order", quantity: 451.2 },
        { itemId: 1784, sku: "PALLET", quantity: 5 }
      ]
    }],
    ...overrides
  });
}

test("SOB118741 requires its physical vendor pickup but no empty source-yard pickup", () => {
  const order = vendorLinkedOrder();
  const ui = planner([order]);
  assert.deepEqual(ui.requiredPickupLocations(order), ["PERMACON Milton"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), ["PERMACON Milton"]);
  assert.equal(ui.addOrderToLoad(order.id, "LOAD"), true);
  assert.deepEqual(ui.load.stops.map((entry) => entry.type), ["pick", "drop"]);
  assert.equal(ui.load.stops[0].location, "PERMACON Milton");
  assert.deepEqual(ui.load.stops[0].orderRefs, [order.id]);
  assert.deepEqual(ui.validate(), []);
});

test("physical goods left at the source yard still require both source and vendor pickups", () => {
  const order = vendorLinkedOrder();
  order.items[0].poAllocatedSalesQty = 450;
  const ui = planner([order]);
  assert.deepEqual(ui.requiredPickupLocations(order), ["3445", "PERMACON Milton"]);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), ["3445", "PERMACON Milton"]);
  ui.load.stops.push(
    stop("P-VENDOR", "pick", order.id, { location: "PERMACON Milton", orderRefs: [order.id] }),
    stop("D-ORDER", "drop", order.id)
  );
  assert.equal(ui.validate()[0].code, "DISPATCH_PICKUP_ORDER_MISSING");
  assert.equal(ui.validate()[0].location, "3445");
});

test("omitting the physical vendor pickup still blocks saving", () => {
  const order = vendorLinkedOrder();
  const ui = planner([order], [stop("D-ORDER", "drop", order.id)]);
  assert.deepEqual(ui.validate().map(({ code, location }) => ({ code, location })), [
    { code: "DISPATCH_PICKUP_ORDER_MISSING", location: "PERMACON Milton" }
  ]);
});

test("a configured source pickup already in the route remains valid when its goods are fully allocated away", () => {
  const order = vendorLinkedOrder();
  const ui = planner([order], [
    stop("P-SOURCE", "pick", order.id, { orderRefs: [order.id] }),
    stop("P-VENDOR", "pick", order.id, { location: "PERMACON Milton", orderRefs: [order.id] }),
    stop("D-ORDER", "drop", order.id)
  ]);
  assert.deepEqual(ui.validate(), []);
});

test("browser and validator agree across item units, source yards, fees, and partial PO allocations", () => {
  const ui = planner([]);
  fc.assert(fc.property(
    fc.constantFrom("3445", "2967", "12441", "150", "3445 : Special"),
    fc.constantFrom("pallets", "layers", "sections", "pieces", "quantity"),
    fc.integer({ min: 1, max: 500 }),
    fc.boolean(),
    (yard, field, quantity, fullyAllocated) => {
      const allocationField = {
        pallets: "poAllocatedPallets", layers: "poAllocatedLayers",
        sections: "poAllocatedSections", pieces: "poAllocatedPieces", quantity: "poAllocatedSalesQty"
      }[field];
      const allocated = fullyAllocated ? quantity : quantity / 2;
      const order = cargoOrder({
        sourceYard: yard,
        pickupLocations: [yard, "Vendor"],
        items: [
          { sku: "Physical item", [field]: quantity, [allocationField]: allocated },
          ...serviceOrder().items
        ],
        poPickupManifest: [{ location: "Vendor", items: [{ sku: "Physical item", [field]: allocated }] }]
      });
      const expected = fullyAllocated ? ["Vendor"] : [yard, "Vendor"];
      assert.deepEqual(ui.requiredPickupLocations(order), expected);
      assert.deepEqual(dispatchRequiredPickupVisitLocations(order), expected);
    }
  ), { seed: 119507, numRuns: 100 });
});

test("configured plan yards are used when deciding whether a source pickup has remaining goods", () => {
  const order = vendorLinkedOrder({ sourceYard: "NEW-YARD", pickupLocations: ["NEW-YARD", "PERMACON Milton"] });
  order.items[0].poAllocatedSalesQty = 450;
  const plan = { summary: { ownYardCodes: ["NEW-YARD"] } };
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order, plan), ["NEW-YARD", "PERMACON Milton"]);
  const ui = planner([order], [
    stop("P-VENDOR", "pick", order.id, { location: "PERMACON Milton", orderRefs: [order.id] }),
    stop("D-ORDER", "drop", order.id)
  ]);
  const result = materializeDispatchPickupVisits({
    ...plan, orders: [order], trucks: [{ loads: [ui.load] }]
  }, { allowLegacyPassthrough: true });
  assert.equal(result.conflicts[0].location, "NEW-YARD");
});

test("legacy orders without item details retain their configured pickup requirements", () => {
  assert.deepEqual(dispatchRequiredPickupVisitLocations({
    id: "SO-LEGACY", sourceYard: "2967", poPickupManifest: [{ location: "Vendor" }]
  }), ["2967", "Vendor"]);
});

test("authoritative save reconciliation uses the same nonempty pickup requirements as the browser", () => {
  for (const order of [serviceOrder(), vendorLinkedOrder()]) {
    const ui = planner([order]);
    const reconciled = reconcileDependencyManagedPickups({
      plan: { orders: [order], trucks: [{ loads: [{
        id: "LOAD", stops: [stop("D-ORDER", "drop", order.id)]
      }] }] },
      enrichedOrders: [order],
      affectedTargetRefs: [order.id]
    });
    const pickups = reconciled.trucks[0].loads[0].stops.filter((entry) => entry.type === "pick");
    assert.deepEqual(pickups.map((entry) => entry.location), ui.requiredPickupLocations(order));
  }
});

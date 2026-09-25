import { productionFunctions } from "./co-cargo-fixture.mjs";

export function pickupUi() {
  return productionFunctions(process.env.DIRECT_TO_PUBLIC_SOURCE || "../../public/dispatch.js", [
    "poRouteProjectionForOrder", "routeItemsForOrder", "routeDropoffsForOrder", "orderWeightLbs",
    "dropoffForStop", "dropItemsForStop", "positiveBalance", "isOwnYardCode",
    "directPickupEntriesForLocation", "directPickupItemsForLocation", "poPickupEntriesForLocation",
    "poPickupItemsForLocation", "directPickupAllocatedForItem", "itemForPickupLocation",
    "dispatchLocationHierarchyRoot", "normalizedPickupLocation", "sameDispatchLocation",
    "uniqueDispatchLocationLabels", "isMbbsSpecialLinkLine", "isOperationalDispatchItem",
    "itemHasQuantity", "tooltipItemsForOrder", "tooltipItemRowsForOrder", "qtyText", "itemQtyText",
    "requiredPickupLocations", "pickupFootprintForOrderLocation", "directPickupWeight",
    "pickupWeightForOrderLocation", "escapeHtml"
  ], {
    ownYardForLocation: value => ["3445", "2967", "12441", "150"].includes(String(value).split(/\s*:\s*/u)[0]),
    movementText: () => "",
    orderFootprintPallets: order => Number(order.pallets || 0)
  });
}

export function orderFixture(overrides = {}) {
  return {
    id: "SOA08838", type: "SO", sourceYard: "3445", pickupLocations: ["3445"],
    customer: "Pickup regression", address: "1 Test Road", weight: 1374,
    transitCo: { id: "CO-SOA08838", fromYard: "150", toYard: "3445", status: "pending_load" },
    transitOriginalSourceYard: "150", transitOriginalPickupLocations: ["150"],
    items: [
      { lineRowId: 453752, itemId: 1356, sku: "BWS-TRE50S-RDM-CAR", itemType: "InvtPart",
        quantity: 52.25, layers: 5, unit: "SQFT", itemWeight: 24 },
      { lineRowId: 453753, itemId: 1193, sku: "PACKED-SO-CARGO", itemType: "InvtPart",
        quantity: 60, pallets: 1, unit: "PC", itemWeight: 2, packedPalletQty: 1 },
      { sku: "Delivery Charge", itemType: "OthCharge", quantity: 1 }
    ],
    directPickupManifest: [{
      transferOrderRef: "TOB01102", salesOrderRef: "SOA08838", location: "3445",
      items: [{ itemId: 1356, itemName: "BWS-TRE50S-RDM-CAR", quantity: 52.25,
        layerQty: 5, unit: "SQFT", itemWeight: 24 }]
    }],
    ...overrides
  };
}

export function routeFor(order) {
  const load = { id: "LOAD", stops: [
    { id: "PICK", loadId: "LOAD", type: "pick", orderId: order.id, orderRefs: [order.id], location: "3445" },
    { id: "DROP", loadId: "LOAD", type: "drop", orderId: order.id }
  ] };
  const truck = { id: "TRUCK", base: "3445", loads: [load] };
  return { plan: { orders: [order], trucks: [truck] }, truck, load };
}

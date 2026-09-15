import fs from "node:fs";
import { cargoFunctions } from "./sales-order-cargo-fixture.mjs";

export function sovBrowser(orders, stops = [], activity = []) {
  const source = fs.readFileSync(new URL("../../public/dispatch.js", import.meta.url), "utf8");
  const start = source.indexOf("const HUBS = {");
  const end = source.indexOf("const MAP_CENTER", start);
  const HUBS = Function(`${source.slice(start, end)}; return HUBS;`)();
  const load = { id: "load", stops: structuredClone(stops) };
  const trucks = [{ id: "truck", loads: [load] }];
  const orderById = id => orders.find(order => order.id === id);
  const status = record => String(record.status || "pending");
  const functions = cargoFunctions("../../public/dispatch.js", [
    "dispatchLocationHierarchyRoot", "normalizedPickupLocation", "sameDispatchLocation",
    "uniqueDispatchLocationLabels", "normalizeText", "normalizedPlaceKey", "normalizedStreetAddressKey",
    "ownYardForLocation", "isOwnYardCode", "placeForLocation", "placePosition",
    "fallbackPositionForAddress", "orderPosition", "resolveStopPlace",
    "isMbbsSpecialLinkLine", "isOperationalDispatchItem", "itemHasQuantity",
    "poRouteProjectionForOrder", "routeItemsForOrder", "positiveBalance",
    "directPickupEntriesForLocation", "directPickupItemsForLocation", "poPickupEntriesForLocation",
    "poPickupItemsForLocation", "directPickupAllocatedForItem", "itemForPickupLocation",
    "tooltipItemsForOrder", "requiredPickupLocations", "orderRequiresPickupLocation",
    "pickupStopOrderRefs", "pickupStopIncludesOrder", "materializePickupVisitOrderRefs",
    "driverActivityDetails", "dispatchEditableRouteBoundary", "opaqueDispatchStopId",
    "makePickupStop", "enablePickupVisitSchema", "ensurePickupStops", "syncPickupStops"
  ], {
    HUBS, MAP_CENTER: { lat: 43.7, lng: -79.65 },
    ownYards: Object.entries(HUBS).filter(([code]) => code !== "Vendor").map(([code, hub]) => ({ code, ...hub })),
    trucks, orderById, stopOrder: stop => orderById(stop.orderId),
    vendorYardForLocation: () => null,
    stopHasDriverActivity: (_load, stop) => activity.some(record =>
      record.stop_id === stop.id && ["in_progress", "complete"].includes(status(record))),
    loadDriverActivityRecords: () => activity,
    executionStatusFromRecord: status
  });
  return { ...functions, load };
}

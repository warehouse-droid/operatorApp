import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "Expected dispatch pickup helper source was not found.");
  return source.slice(start, end);
}

const hierarchySource = sourceSlice(
  "function dispatchLocationHierarchyRoot",
  "function orderRequiresPickupLocation"
);
const locationHelpers = Function(
  '"use strict"; ' + hierarchySource + "; return { dispatchLocationHierarchyRoot, normalizedPickupLocation, sameDispatchLocation, uniqueDispatchLocationLabels };"
)();
assert.equal(locationHelpers.dispatchLocationHierarchyRoot("3445 : 3445 Special"), "3445");
assert.equal(locationHelpers.normalizedPickupLocation("3445 : 3445 Special"), "3445");
assert.equal(locationHelpers.sameDispatchLocation("3445", "3445 : 3445 Special"), true);
assert.equal(locationHelpers.sameDispatchLocation("2967", "3445 : 3445 Special"), false);

const requiredPickupSource = sourceSlice(
  "function requiredPickupLocations",
  "function sequenceWarningsForStops"
);
const makeRequiredPickupLocations = Function(
  "normalizedPickupLocation",
  "tooltipItemsForOrder",
  "itemHasQuantity",
  "uniqueDispatchLocationLabels",
  '"use strict"; ' + requiredPickupSource + "; return requiredPickupLocations;"
);

const quantityLocations = new Set(["3445"]);
const requiredPickupLocations = makeRequiredPickupLocations(
  locationHelpers.normalizedPickupLocation,
  (_order, { pickupLocation = "" } = {}) =>
    quantityLocations.has(locationHelpers.normalizedPickupLocation(pickupLocation)) ? [{ quantity: 1 }] : [],
  (item) => Number(item?.quantity || 0) > 0,
  locationHelpers.uniqueDispatchLocationLabels
);

const externalPickupOrder = {
  id: "SOV02265",
  type: "SO",
  pickupLocations: ["195"],
  pickupAddressOverride: "10 Baytree Crescent, North York, ON"
};
assert.deepEqual(
  requiredPickupLocations(externalPickupOrder),
  ["195"],
  "An explicit pickup address must retain the primary pickup even when its external source code has no inventory allocation."
);
assert.deepEqual(
  requiredPickupLocations({ ...externalPickupOrder, pickupAddressOverride: "" }),
  [],
  "An unknown source without an explicit override must retain the allocation-based filter."
);
assert.deepEqual(
  requiredPickupLocations({
    pickupLocations: ["195", "3445", "195"],
    pickupAddressOverride: "External pickup address"
  }),
  ["195", "3445"],
  "The explicit external pickup and any additional allocated yard pickups must both remain required."
);
assert.deepEqual(
  requiredPickupLocations({ pickupLocations: ["3445 : 3445 Special", "3445"] }),
  ["3445 : 3445 Special"],
  "A NetSuite child location and its parent must produce one physical pickup."
);

const pickupStopSource = sourceSlice("function opaqueDispatchStopId", "function isScmGroupedPoOrder");
const makeEnsurePickupStops = Function(
  "requiredPickupLocations",
  "normalizedPickupLocation",
  '"use strict"; ' + pickupStopSource + "; return ensurePickupStops;"
);
const ensurePickupStops = makeEnsurePickupStops(requiredPickupLocations, locationHelpers.normalizedPickupLocation);
const load = { id: "LOAD-1", stops: [] };
assert.equal(ensurePickupStops(load, externalPickupOrder, 0), 1);
assert.equal(load.stops.length, 1);
assert.equal(load.stops[0].type, "pick");
assert.equal(load.stops[0].orderId, "SOV02265");
assert.equal(load.stops[0].location, "195");
const relatedYardLoad = { id: "LOAD-2", stops: [{ id: "PARENT", type: "pick", location: "3445" }] };
assert.equal(
  ensurePickupStops(relatedYardLoad, { pickupLocations: ["3445 : 3445 Special"] }),
  0,
  "An existing parent-yard stop must satisfy a child-location pickup."
);
assert.equal(relatedYardLoad.stops.length, 1);

const groupingSource = sourceSlice(
  "function orderGroupYard",
  "function groupedOrderDependencyStructureBlockMessage"
);
const mixedYardGroupBlockReason = Function(
  "normalizedPickupLocation",
  '"use strict"; ' + groupingSource + "; return mixedYardGroupBlockReason;"
)(locationHelpers.normalizedPickupLocation);
assert.equal(mixedYardGroupBlockReason([
  { id: "SOB117067", pickupLocations: ["3445 : 3445 Special"] },
  { id: "SOB117068", pickupLocations: ["3445"] }
]), "", "A child NetSuite location must be groupable with its parent yard.");
assert.match(mixedYardGroupBlockReason([
  { id: "SOB117067", pickupLocations: ["3445 : 3445 Special"] },
  { id: "SOB117069", pickupLocations: ["2967"] }
]), /Cannot group orders from different yards/u);

const physicalAddressSource = sourceSlice(
  "function normalizedStreetAddressKey",
  "function ownYardForLocation"
);
const makePhysicalAddressHelpers = Function(
  "normalizedPlaceKey",
  "ownYards",
  "HUBS",
  "dispatchVendorYards",
  '"use strict"; ' + physicalAddressSource + "; return { normalizedStreetAddressKey, samePhysicalAddress };"
);
const physicalAddressHelpers = makePhysicalAddressHelpers(
  (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  [{
    code: "2967",
    name: "2967",
    address: "2967 Kennedy Road, Toronto, ON"
  }],
  {},
  []
);
assert.equal(
  physicalAddressHelpers.normalizedStreetAddressKey("2967 Kennedy Rd, Scarborough, ON M1V 1S9"),
  "2967 kennedy rd"
);
assert.equal(
  physicalAddressHelpers.samePhysicalAddress(
    "2967 Kennedy Rd, Scarborough, ON M1V 1S9",
    "2967 Kennedy Road, Toronto, ON"
  ),
  true,
  "Street suffix and municipality wording must not prevent an override from resolving to the configured physical yard."
);
assert.equal(
  physicalAddressHelpers.samePhysicalAddress({ lat: 43.8, lng: -79.3 }, { lat: 43.9, lng: -79.4 }),
  false,
  "Unrelated coordinate objects must not collapse to the same normalized string."
);
assert.equal(
  physicalAddressHelpers.samePhysicalAddress("100 Martin Grove Road, Toronto, ON", "100 Martin Grove Avenue, Toronto, ON"),
  false,
  "Different street suffixes must not be treated as the same physical address."
);
assert.equal(
  physicalAddressHelpers.samePhysicalAddress("2967 Kennedy Road, Toronto, ON", "2967 Kennedy Rd, Vaughan, ON"),
  false,
  "A unique configured street must not override a conflicting municipality."
);
assert.equal(
  physicalAddressHelpers.samePhysicalAddress(
    "2967 Kennedy Road, Toronto, ON M1V 1S9",
    "2967 Kennedy Rd, Scarborough, ON M1V 2A2"
  ),
  false,
  "Conflicting Canadian postal codes must not be treated as the same physical address."
);

const ownYardSource = sourceSlice(
  "function ownYardForLocation",
  "function vendorYardForLocation"
);
const makeOwnYardForLocation = Function(
  "normalizedPlaceKey",
  "normalizedStreetAddressKey",
  "physicalAddressRegionCompatible",
  "HUBS",
  "ownYards",
  "dispatchLocationHierarchyRoot",
  '"use strict"; ' + ownYardSource + "; return ownYardForLocation;"
);
const configuredYards = [{
  code: "2967",
  name: "2967",
  address: "2967 Kennedy Road, Toronto, ON",
  lat: 43.806119,
  lng: -79.2986377
}, {
  code: "12441",
  name: "12441",
  address: "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  lat: 43.948694,
  lng: -79.3727582
}];
const ownYardForLocation = makeOwnYardForLocation(
  (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  physicalAddressHelpers.normalizedStreetAddressKey,
  (left, right) => {
    const normalized = (value) => String(value || "").toLowerCase();
    const municipality = (value) => {
      if (/\b(vaughan)\b/.test(normalized(value))) return "vaughan";
      if (/\b(toronto|scarborough|north york|etobicoke|east york|york)\b/.test(normalized(value))) return "toronto";
      return "";
    };
    const leftMunicipality = municipality(left);
    const rightMunicipality = municipality(right);
    return !leftMunicipality || !rightMunicipality || leftMunicipality === rightMunicipality;
  },
  {},
  configuredYards,
  locationHelpers.dispatchLocationHierarchyRoot
);
assert.equal(
  ownYardForLocation("2967 : Seasonal inventory")?.code,
  "2967",
  "A child location must inherit its configured parent yard and address."
);
assert.equal(
  ownYardForLocation("2967 Kennedy Rd, Scarborough, ON M1V 1S9")?.code,
  "2967",
  "The live override address spelling must resolve to the configured 2967 yard."
);
assert.equal(
  ownYardForLocation("2967 Kennedy Rd, Vaughan, ON"),
  null,
  "A matching street line in a conflicting municipality must not resolve as the configured own yard."
);

const resolvePickupSource = sourceSlice(
  "function resolveStopPlace",
  "function stopIsOwnYard"
);
const makeResolvePickup = Function(
  "placeForLocation",
  "placePosition",
  "fallbackPositionForAddress",
  "MAP_CENTER",
  '"use strict"; ' + resolvePickupSource + "; return { resolveStopPlace, pickupStopLabel };"
);
const resolvedPickup = makeResolvePickup(
  (location) => {
    const yard = ownYardForLocation(location);
    return yard ? {
      kind: "own",
      key: yard.code,
      label: yard.name,
      address: yard.address,
      lat: yard.lat,
      lng: yard.lng
    } : null;
  },
  (place) => place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lng))
    ? { lat: Number(place.lat), lng: Number(place.lng) }
    : null,
  () => ({ lat: 43.7, lng: -79.65 }),
  { lat: 43.7, lng: -79.65 }
);
const groupedPickupStop = { id: "GOA-P", type: "pick", orderId: "GOA-5634-5636", location: "12441" };
const groupedPickupOrder = {
  id: "GOA-5634-5636",
  pickupAddressOverride: "2967 Kennedy Rd, Scarborough, ON M1V 1S9"
};
const physicalPickup = resolvedPickup.resolveStopPlace(groupedPickupStop, groupedPickupOrder);
assert.equal(groupedPickupStop.location, "12441", "The inventory pickup identity must remain unchanged.");
assert.equal(physicalPickup.key, "2967");
assert.equal(physicalPickup.kind, "own");
assert.equal(physicalPickup.label, "2967");
assert.equal(physicalPickup.address, groupedPickupOrder.pickupAddressOverride);
assert.equal(physicalPickup.routeLocation, groupedPickupOrder.pickupAddressOverride);
assert.equal(physicalPickup.lat, 43.806119);
assert.equal(physicalPickup.lng, -79.2986377);
assert.equal(resolvedPickup.pickupStopLabel(groupedPickupStop, groupedPickupOrder), "2967");

const fallbackTravelSource = sourceSlice(
  "function fallbackTravelMinutesBetweenStops",
  "function loadStats"
);
const makeFallbackTravel = Function(
  "resolveStopPlace",
  "samePhysicalAddress",
  "adjustedTravelMinutesForTruck",
  "HUBS",
  "yardTravelMinutes",
  '"use strict"; ' + fallbackTravelSource + "; return fallbackTravelMinutesBetweenStops;"
);
const fallbackTravelMinutesBetweenStops = makeFallbackTravel(
  (stop, order) => {
    const address = stop.type === "pick" ? order.pickupAddressOverride : order.address;
    return { kind: "own", key: "2967", address, routeLocation: address };
  },
  physicalAddressHelpers.samePhysicalAddress,
  (_truck, value) => value,
  {},
  () => 0
);
assert.equal(
  fallbackTravelMinutesBetweenStops(
    {},
    { type: "drop" },
    groupedPickupStop,
    { address: "2967 Kennedy Road, Toronto, ON" },
    groupedPickupOrder
  ),
  0,
  "A preceding 2967 stop and the logical-12441/physical-2967 pickup must have no fallback travel leg."
);

assert.match(
  source,
  /clearActiveRouteEstimates\(\);\s*commitPlanMutation\("dispatch_order_details_updated"\)/,
  "Saving a pickup-address override must invalidate stale route estimates before rendering the updated plan."
);
assert.match(
  source,
  /const title = stop\.type === "pick"\s*\? `\$\{sequence\}\. Pickup \$\{pickupStopLabel\(stop, order\)\}`/,
  "Map route titles must use the resolved physical pickup label."
);

const travelJobIdSource = sourceSlice(
  "function driverTravelJobIdForLoad",
  "function driverSwitchApproachJobIdForLoad"
);
const makeDriverTravelJobId = Function(
  "effectiveTruckForLoad",
  "currentPlan",
  '"use strict"; ' + travelJobIdSource + "; return driverTravelJobIdForLoad;"
);
const driverTravelJobIdForLoad = makeDriverTravelJobId(
  (truck) => truck,
  { id: 6000 }
);
assert.equal(
  driverTravelJobIdForLoad(
    { id: "T1", plate: "AA100" },
    { id: "L2" },
    {
      from: "2967",
      fromJobLocation: "12441",
      to: "2967",
      toPickupLocation: "12441"
    }
  ),
  "6000:T1:L2:TRAVEL:12441:12441:",
  "The browser must look up driver travel status with stable logical stop identities."
);
assert.match(
  source,
  /jobLabel:\s*stop\.type === "pick" \? String\(stop\.location \|\| ""\)/,
  "A physicalized previous pickup must retain its logical identity for legacy driver job IDs."
);

console.log("Dispatch pickup-address override checks passed.");

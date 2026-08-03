import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "Expected dispatch route helper source was not found.");
  return source.slice(start, end);
}

const helperSource = sourceSlice("function returnYardStayMinutes", "function mapStopsForLoad");
const makeHelpers = Function(
  "truckStopMinutes",
  '"use strict"; ' + helperSource + "; return { returnYardStayMinutes, routeStayMinutesForLoad };"
);
const configuredStops = [];
const helpers = makeHelpers((_truck, serviceType) => {
  configuredStops.push(serviceType);
  return 45;
});

const manualReturn = { id: "manual-return", returnOnly: true, manual: true };
const legacyReturn = { id: "legacy-return", returnOnly: true, manual: false };
const routeStops = [
  { type: "drop", stayMinutes: 0 },
  { type: "pick", stayMinutes: 45 }
];

assert.equal(helpers.returnYardStayMinutes(manualReturn, {}), 0, "A manual return must not add own-yard stop time.");
assert.equal(configuredStops.length, 0, "Manual returns must skip the configured own-yard service calculation.");
assert.equal(helpers.returnYardStayMinutes(legacyReturn, {}), 45, "Legacy automatic returns must retain their configured yard stop.");
assert.deepEqual(configuredStops, ["own"]);
assert.equal(helpers.routeStayMinutesForLoad(manualReturn, routeStops), 0, "Manual return route totals must remain drive-only.");
assert.equal(helpers.routeStayMinutesForLoad(legacyReturn, routeStops), 45, "Non-manual routes must retain stop service time.");

assert.match(
  source,
  /title: `Return \$\{returnYard\}`[\s\S]*?stayMinutes: returnYardStayMinutes\(load, truck\)/,
  "The return-yard marker must use the manual-return stay-time rule."
);
assert.match(
  source,
  /stayMinutes: physicalVisitStayMinutes\(visit, truck\)/,
  "Every routed physical visit, including pickups, must use the canonical configured service-time helper."
);

const stopServiceTypeSource = sourceSlice("function stopServiceType", "function stopTimeWindow");
const makeStopServiceType = Function(
  "stopIsOwnYard",
  "resolveStopPlace",
  '"use strict"; ' + stopServiceTypeSource + "; return stopServiceType;"
);
const stopServiceType = makeStopServiceType(
  (stop) => stop.placeKind === "own",
  (stop) => ({ kind: stop.placeKind })
);

assert.equal(
  stopServiceType({ type: "pick", placeKind: "own" }, {}),
  "own",
  "A VRMA pickup in our yard must use the driver's own-yard fixed time."
);
assert.equal(
  stopServiceType({ type: "drop", placeKind: "vendor" }, { sourceTable: "scm_vrma_orders" }),
  "vendor",
  "A VRMA drop at a configured vendor yard must use vendor fixed time."
);
assert.equal(
  stopServiceType({ type: "drop", placeKind: "delivery" }, { type: "SO" }),
  "delivery",
  "An ordinary customer drop must retain delivery timing."
);
assert.equal(
  stopServiceType({ type: "drop", placeKind: "vendor" }, { type: "SO" }),
  "delivery",
  "An SO customer drop must not become vendor timing merely because its address matches a configured vendor yard."
);

const stopStayMinutesSource = sourceSlice("function explicitCustomDropStopMinutes", "function compactMinuteValue");
const makeStopStayMinutes = Function(
  "truckStopMinutes",
  "stopServiceType",
  "dropFootprintPallets",
  "orderFootprintPallets",
  "normalizedStopTimeOverride",
  '"use strict"; ' + stopStayMinutesSource + "; return stopStayMinutes;"
);
const configuredStopMinutes = (_truck, type, pallets) => {
  if (type === "own") return 42;
  if (type === "vendor") return 36;
  return 35 + Number(pallets || 0);
};
const stopStayMinutes = makeStopStayMinutes(
  configuredStopMinutes,
  stopServiceType,
  () => 10,
  () => 10,
  () => null
);
const vrmaStopMinutes = stopStayMinutes(
  { type: "pick", placeKind: "own" },
  { sourceTable: "scm_vrma_orders" },
  {}
) + stopStayMinutes(
  { type: "drop", placeKind: "vendor" },
  { sourceTable: "scm_vrma_orders" },
  {}
);

assert.equal(
  vrmaStopMinutes,
  78,
  "A VRMA must total own-yard fixed plus vendor-yard fixed time without delivery pallet minutes."
);
assert.equal(
  stopStayMinutes({ type: "drop", placeKind: "delivery" }, { type: "SO" }, {}),
  45,
  "A ten-pallet customer delivery must retain delivery fixed plus per-pallet time."
);
assert.equal(
  stopStayMinutes(
    { type: "drop", placeKind: "delivery" },
    { type: "CUSTOM", customOrder: true, stopMinutes: 58 },
    {}
  ),
  58,
  "A Custom Order drop must use its dispatcher-entered destination stop time."
);
assert.equal(
  stopStayMinutes(
    { type: "pick", placeKind: "vendor" },
    { type: "CUSTOM", customOrder: true, stopMinutes: 58 },
    {}
  ),
  36,
  "A Custom Order pickup must continue to use the configured vendor-yard time."
);
assert.equal(
  stopStayMinutes(
    { type: "drop", placeKind: "delivery" },
    { type: "CUSTOM", customOrder: true, stopMinutes: null },
    {}
  ),
  45,
  "A legacy Custom Order without stop time must retain the per-driver delivery fallback."
);
assert.match(
  source,
  /current \+= physicalVisitStayMinutes\(visit, truck\)/,
  "Load timeline departures must use the same canonical physical-visit time as route estimates."
);

const routeFunctionSource = sourceSlice("function routeEstimateFromGoogleLegs", "function directionsRequestForLoad");
const makeRouteHarness = Function(
  "findLoad",
  "effectiveTruckForLoad",
  "adjustedTravelMinutesForTruck",
  "cacheRouteEstimate",
  "truckTravelTimePercent",
  "truckStopMinutes",
  "samePhysicalRouteStop",
  '"use strict"; let routeEstimates = {}; ' + helperSource + routeFunctionSource
    + "; return { routeEstimateFromGoogleLegs, routeEstimates };"
);
const routeHarness = makeRouteHarness(
  () => ({ truck: null }),
  (truck) => truck || {},
  (_truck, minutes) => Number(minutes),
  () => {},
  () => 0,
  () => 45,
  (left, right) => Boolean(
    left
    && right
    && left.kind === "own"
    && right.kind === "own"
    && String(left.placeKey || "") === String(right.placeKey || "")
  )
);

const manualEstimate = routeHarness.routeEstimateFromGoogleLegs(
  { ...manualReturn },
  routeStops,
  [{ duration: { value: 5520 } }],
  {}
);
assert.equal(manualEstimate.driveMinutes, 92);
assert.equal(manualEstimate.stayMinutes, 0);
assert.equal(manualEstimate.totalMinutes, 92, "A 92-minute manual return must finish after 92 minutes, not 137.");

const legacyEstimate = routeHarness.routeEstimateFromGoogleLegs(
  { ...legacyReturn },
  routeStops,
  [{ duration: { value: 5520 } }],
  {}
);
assert.equal(legacyEstimate.totalMinutes, 137, "The narrow fix must not alter legacy automatic-return timing.");

const coLocatedStops = [
  { type: "pick", kind: "own", placeKey: "2967", routeLocation: "2967 Kennedy Rd", stayMinutes: 12 },
  { type: "pick", kind: "own", placeKey: "2967", routeLocation: "2967 Kennedy Road", stayMinutes: 18 },
  { type: "drop", kind: "delivery", placeKey: "customer", routeLocation: "89 Remington Dr", stayMinutes: 30 }
];
const coLocatedEstimate = routeHarness.routeEstimateFromGoogleLegs(
  { id: "co-located-pickups" },
  coLocatedStops,
  [{ duration: { value: 60 } }, { duration: { value: 1200 } }],
  {}
);
assert.deepEqual(coLocatedEstimate.rawLegMinutes, [0, 20]);
assert.equal(coLocatedEstimate.driveMinutes, 20, "A co-located pickup leg must not add the one-minute Google-leg floor.");
assert.equal(coLocatedEstimate.stayMinutes, 60, "Both logical pickup service times must remain in the route total.");
assert.equal(coLocatedEstimate.totalMinutes, 80);

const signatureSource = sourceSlice("function routeSignature", "function loadPersistedRouteEstimateCache");
const makeRouteSignature = Function('"use strict"; ' + signatureSource + "; return routeSignature;");
const routeSignature = makeRouteSignature();
assert.notEqual(
  routeSignature(routeStops),
  routeSignature([{ ...routeStops[0] }, { ...routeStops[1], stayMinutes: 0 }]),
  "Changing the return stay time must invalidate the old cached route estimate."
);

console.log("Dispatch manual-return route duration checks passed.");

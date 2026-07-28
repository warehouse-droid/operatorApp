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
  /stayMinutes: stop\.type === "pick"\s*\? truckStopMinutes\(truck, stopServiceType\(stop, order\), pickupFootprintForLocation\(load, stop\.location\)\)/,
  "Ordinary pickup stops must continue to use configured service time."
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

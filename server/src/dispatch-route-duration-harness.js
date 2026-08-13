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

const routeFunctionSource = sourceSlice("function googleLegDurationSeconds", "function directionsRequestForLoad");
const makeRouteHarness = Function(
  "findLoad",
  "effectiveTruckForLoad",
  "adjustedTravelMinutesForTruck",
  "cacheRouteEstimate",
  "truckTravelTimePercent",
  "truckStopMinutes",
  "samePhysicalRouteStop",
  "routeEstimateMeta",
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
  ),
  () => ({ id: "test-route", signature: "test-signature" })
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
assert.equal(coLocatedEstimate.routeEstimateId, "test-route", "A resolved estimate must retain the identity of its exact route and departure context.");
assert.equal(
  routeHarness.routeEstimateFromGoogleLegs(
    { id: "shortened-google-route" },
    coLocatedStops,
    [{ duration: { value: 60 } }],
    {}
  ),
  null,
  "A shortened Google multi-point response must not become authoritative timing."
);
assert.equal(
  routeHarness.routeEstimateFromGoogleLegs(
    { id: "failed-google-leg" },
    [coLocatedStops[1], coLocatedStops[2]],
    [{ duration: { value: 0 } }],
    {}
  ),
  null,
  "A failed physical Google leg must remain unresolved instead of becoming zero travel."
);

const trafficAdjustedHarness = makeRouteHarness(
  () => ({ truck: null }),
  (truck) => truck || {},
  (truck, minutes) => Math.round(Number(minutes) * (1 + (Number(truck?.travelTimePercent || 0) / 100))),
  () => {},
  (truck) => Number(truck?.travelTimePercent || 0),
  () => 0,
  () => false,
  () => ({ id: "traffic-route", signature: "traffic-signature" })
);
const ayrRepositionEstimate = trafficAdjustedHarness.routeEstimateFromGoogleLegs(
  { id: "ce94489-ayr-reposition" },
  [
    { type: "drop", routeLocation: "12441 Woodbine Avenue", stayMinutes: 0 },
    { type: "pick", routeLocation: "2977 Cedar Creek Road, Ayr", stayMinutes: 35 }
  ],
  [{ duration: { value: 92 * 60 }, duration_in_traffic: { value: 134 * 60 } }],
  { travelTimePercent: 30 }
);
assert.deepEqual(ayrRepositionEstimate.rawLegMinutes, [134], "The empty reposition must use Google's traffic duration, not its no-traffic duration.");
assert.deepEqual(ayrRepositionEstimate.legMinutes, [174], "CE94489's configured 30% truck adjustment must apply to the Google traffic leg.");
assert.equal(ayrRepositionEstimate.stayMinutes, 35, "Ayr yard service must remain separate from the empty reposition travel.");

const departureSource = sourceSlice("function plannedDepartureDate", "function mapMarkerIcon");
const plannedDepartureDate = Function(
  "currentPlanDate",
  `"use strict"; ${departureSource}; return plannedDepartureDate;`
)("2026-08-12");
const overdueNow = new Date("2026-08-12T19:34:00.000Z");
assert.equal(
  plannedDepartureDate((12 * 60) + 47, "2026-08-12", overdueNow).toISOString(),
  "2026-08-12T19:39:00.000Z",
  "An overdue same-day travel leg must request current traffic instead of tomorrow's lunchtime traffic."
);
assert.equal(
  plannedDepartureDate((12 * 60) + 47, "2026-08-13", overdueNow).toISOString(),
  "2026-08-13T12:47:00.000Z",
  "A future Dispatch date must route on that date instead of an unrelated tomorrow inferred from the browser clock."
);

const signatureSource = sourceSlice("function routeSignature", "function loadPersistedRouteEstimateCache");
const makeRouteSignature = Function('"use strict"; ' + signatureSource + "; return routeSignature;");
const routeSignature = makeRouteSignature();
assert.notEqual(
  routeSignature(routeStops),
  routeSignature([{ ...routeStops[0] }, { ...routeStops[1], stayMinutes: 0 }]),
  "Changing the return stay time must invalidate the old cached route estimate."
);

const payloadSource = sourceSlice("function trucksWithTimingMetadata", "function normalizePlanBeforeSave");
assert.match(payloadSource, /serializableRouteEstimateForLoad\(effectiveTruck, load\)/, "Saved Dispatch loads must serialize the resolved Google leg estimate.");
assert.match(payloadSource, /routeEstimate: savedRouteEstimate/, "The resolved per-leg estimate must travel with the server-authoritative plan timing.");

const confirmSource = sourceSlice("async function confirmCurrentPlanAtomic", "function commitPlanMutation");
assert.ok(
  confirmSource.indexOf('await ensureGoogleRouteEstimatesBeforeSave("confirm")') < confirmSource.indexOf("const payload = planPayload(savedAt)"),
  "Plan confirmation must resolve Google routes before serializing authoritative stop timing."
);

const saveQueueSource = sourceSlice("async function flushPlanSaveQueue", "function historySnapshot");
assert.ok(
  saveQueueSource.indexOf("await ensureGoogleRouteEstimatesBeforeSave()") < saveQueueSource.indexOf("const payload = planPayload(savedAt)"),
  "Autosave must not serialize guessed travel timing before every physical Google leg resolves."
);

const routePendingSource = sourceSlice("function routePendingForLoad", "function loadFinishText");
assert.match(routePendingSource, /samePhysicalRouteStop\(stops\[index\], stop\)/, "Every real physical leg, including own-yard-to-own-yard travel, must require a Google estimate.");
assert.doesNotMatch(routePendingSource, /routeStopIsOwnYard/, "Own-yard routes must not be silently excluded from Google estimation.");
assert.match(routePendingSource, /routeEstimateMatchesMeta\(estimate, meta\)/, "A stale Google estimate must not survive a route or departure-time change.");
assert.match(routePendingSource, /routeEstimateHasCompleteGoogleLegs\(stops, estimate\)/, "Every physical leg must have a resolved Google duration before save.");

const completeLegSource = sourceSlice("function routeEstimateHasCompleteGoogleLegs", "function serializableRouteEstimateForLoad");
assert.match(completeLegSource, /estimate\.legMinutes\.length !== stops\.length - 1/, "A shortened persisted estimate must not hide an omitted route leg.");
assert.match(completeLegSource, /value <= 0/, "A failed physical Google leg must not be converted into a saveable zero-minute estimate.");

const trafficLegSource = sourceSlice("async function trafficAwareGoogleLegs", "function googleRouteForLoad");
assert.match(trafficLegSource, /fullLegs\.length !== stops\.length - 1/, "A shortened multi-point response must fall back to separate Google requests for its missing legs.");
assert.match(trafficLegSource, /trafficLegs\.push\(leg \|\| null\)/, "An unavailable Google leg must remain unresolved instead of receiving a guessed duration.");

const googleRouteSource = sourceSlice("function googleRouteForLoad", "function routeEstimateSummaryHtml");
assert.match(googleRouteSource, /status !== "OK" \|\| !result[\s\S]*trafficAwareGoogleLegs\(load, stops, \[\], meta\)/, "A failed or over-limit multi-point request must retry each physical leg with Google.");
assert.match(googleRouteSource, /source: "google-per-leg"/, "A fully resolved separate-leg route must remain a Google estimate.");

const backgroundRouteSource = sourceSlice("async function runBackgroundRouteEstimates", "async function ensureGoogleRouteEstimatesBeforeSave");
assert.match(backgroundRouteSource, /if \(!routePendingForLoad\(latest\.truck, latest\.load\)\) continue;/, "A downstream route that becomes valid after an earlier Google estimate must not be fetched and replaced again.");

const googleMapsUrlSource = sourceSlice("function googleMapsLocationForStop", "function poDropStopDetails");
assert.match(googleMapsUrlSource, /mapStopsForLoad\(load, truck\)/, "The external Google Maps link must use the same complete physical route as ETA calculation.");
assert.doesNotMatch(googleMapsUrlSource, /origin:\s*"3445 Mavis Rd/, "The external route must not silently replace the actual first leg with a hard-coded yard.");

console.log("Dispatch manual-return route duration checks passed.");

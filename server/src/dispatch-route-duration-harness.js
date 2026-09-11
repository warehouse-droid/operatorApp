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

const serverRouteSource = sourceSlice("function fallbackLegMinutesForRouteStops", "function routeEstimateSummaryHtml");
assert.match(serverRouteSource, /\/api\/dispatch\/maps\/route-estimate/, "Route timing must use the central server Maps gateway.");
assert.equal((serverRouteSource.match(/fetch\(/g) || []).length, 1, "A multi-stop load must be one server route request, never one call per leg.");
assert.match(serverRouteSource, /fallbackLegMinutesForRouteStops\(stops\)/, "Every server route request must include deterministic local fallback legs.");
assert.match(serverRouteSource, /travelTimePercent: truckTravelTimePercent\(truck\)/, "The configured truck travel adjustment must be applied by the server response.");
assert.match(serverRouteSource, /stayMinutes: Number\(stop\.stayMinutes \|\| 0\)/, "Canonical service time must remain separate in every route stop.");

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
  confirmSource.indexOf("await refreshGoogleRouteEstimatesForConfirmation()") < confirmSource.indexOf("const payload = planPayload(savedAt)"),
  "Plan confirmation may refine changed routes once before serializing authoritative stop timing."
);

const saveQueueSource = sourceSlice("async function flushPlanSaveQueue", "function historySnapshot");
assert.doesNotMatch(saveQueueSource, /GoogleRoute|route-estimate|ensureGoogleRoute/, "Autosave must not consume Google Maps usage or wait for it.");

const routePendingSource = sourceSlice("function routePendingForLoad", "function loadFinishText");
assert.match(routePendingSource, /return false/, "A local route estimate must keep planning available when Google is denied or unavailable.");
assert.match(routePendingSource, /function routeNeedsGoogleEstimateForLoad/, "Google refinement eligibility must remain separate from workflow readiness.");
assert.match(routePendingSource, /routeEstimateMatchesMeta\(estimate, meta\)/, "A stale Google estimate must not survive a route or departure-time change.");
assert.match(routePendingSource, /routeEstimateHasCompleteGoogleLegs\(stops, estimate\)/, "A persisted Google estimate must still contain every physical leg.");

const completeLegSource = sourceSlice("function routeEstimateHasCompleteGoogleLegs", "function serializableRouteEstimateForLoad");
assert.match(completeLegSource, /estimate\.legMinutes\.length !== stops\.length - 1/, "A shortened persisted estimate must not hide an omitted route leg.");
assert.match(completeLegSource, /value <= 0/, "A failed physical Google leg must not be converted into a saveable zero-minute estimate.");

const googleRouteSource = sourceSlice("async function googleRouteForLoad", "function routeEstimateSummaryHtml");
assert.match(googleRouteSource, /fetch\("\/api\/dispatch\/maps\/route-estimate"/, "A changed load must use the central budgeted server route endpoint.");
assert.equal((googleRouteSource.match(/fetch\(/g) || []).length, 1, "One load refinement must issue at most one route request.");
assert.doesNotMatch(googleRouteSource, /for \([^)]*leg|DirectionsService/, "A partial response must fall back instead of multiplying one load into per-leg Google calls.");

const confirmationRouteSource = sourceSlice("async function refreshGoogleRouteEstimatesForConfirmation", "function planBadgeText");
assert.match(confirmationRouteSource, /routeNeedsGoogleEstimateForLoad/, "Confirmation must skip unchanged route fingerprints.");
assert.match(confirmationRouteSource, /reason: "confirm"/, "Confirmation route usage must be attributed to its action.");

const googleMapsUrlSource = sourceSlice("function googleMapsLocationForStop", "function poDropStopDetails");
assert.match(googleMapsUrlSource, /mapStopsForLoad\(load, truck\)/, "The external Google Maps link must use the same complete physical route as ETA calculation.");
assert.doesNotMatch(googleMapsUrlSource, /origin:\s*"3445 Mavis Rd/, "The external route must not silently replace the actual first leg with a hard-coded yard.");

console.log("Dispatch manual-return route duration checks passed.");

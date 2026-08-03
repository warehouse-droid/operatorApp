import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../public/dispatch.css", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected source between ${startMarker} and ${endMarker}.`);
  return source.slice(start, end);
}

const normalize = (value) => String(value || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const orders = new Map([
  ["PICK-1", { id: "PICK-1", type: "SO", address: "100 Main St, Toronto, ON" }],
  ["CUSTOM-1", { id: "CUSTOM-1", type: "CUSTOM", address: "100 Main St., Toronto, ON" }],
  ["SOB-1", { id: "SOB-1", type: "SO", address: " 100 MAIN ST Toronto ON " }],
  ["PICK-2", { id: "PICK-2", type: "SO", address: "100 Main St, Toronto, ON" }],
  ["SOB-2", { id: "SOB-2", type: "SO", address: "100 Main St, Toronto, ON" }],
  ["SOB-3", { id: "SOB-3", type: "SO", address: "100 Main St, Vaughan, ON" }],
  ["LOC-1", { id: "LOC-1", type: "SO", address: "200 Shared Rd, Toronto, ON" }],
  ["LOC-2", { id: "LOC-2", type: "SO", address: "200 Shared Rd, Toronto, ON" }],
  ["YARD-1", { id: "YARD-1", type: "TO", address: "Legacy 12441 label", destinationYard: "12441" }],
  ["YARD-2", { id: "YARD-2", type: "PO", address: "12441 Woodbine Avenue", destinationYard: "12441" }],
  ["YARD-150-TO", { id: "YARD-150-TO", type: "TO", address: "Transfer to Brampton", destinationYard: "150" }],
  ["YARD-150-SO", { id: "YARD-150-SO", type: "SO", address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada" }]
]);
const stopOrder = (stop) => orders.get(String(stop?.orderId || "")) || null;
const yardAddresses = {
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON",
  "150": "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada"
};
const stopAddress = (stop, order) => stop?.dropAddress
  || (stop?.type === "drop" ? yardAddresses[String(stop.dropLocation || order?.destinationYard || "")] : "")
  || order?.address
  || "";

const visitHelperSource = `${sourceSlice(
  "function physicalDropVisitKey",
  "function physicalVisitOverrideState"
)}\n${sourceSlice(
  "function consecutiveExactDropVisits",
  "function previewVisitExecutionStatus"
)}`;
const makeVisitHelpers = Function(
  "stopOrder",
  "stopAddress",
  "normalizedPlaceKey",
  "isOwnYardCode",
  "normalizedPickupLocation",
  "dropLocationForStop",
  `"use strict"; ${visitHelperSource}; return { consecutiveExactDropVisits, previewVisitTiming, previewVisitContainingStop };`
);
const visitHelpers = makeVisitHelpers(
  stopOrder,
  stopAddress,
  normalize,
  (value) => ["12441", "150"].includes(String(value)),
  normalize,
  (stop, order) => stop.dropLocation || order.destinationYard || ""
);

const stops = [
  { id: "pick-1", type: "pick", orderId: "PICK-1" },
  { id: "custom-1", type: "drop", orderId: "CUSTOM-1" },
  { id: "so-1", type: "drop", orderId: "SOB-1" },
  { id: "pick-2", type: "pick", orderId: "PICK-2" },
  { id: "so-2", type: "drop", orderId: "SOB-2" },
  { id: "so-3", type: "drop", orderId: "SOB-3" }
];
const rows = [
  { arrival: 80, depart: 95 },
  { arrival: 100, depart: 120 },
  { arrival: 120, depart: 150 },
  { arrival: 160, depart: 175 },
  { arrival: 180, depart: 205 },
  { arrival: 215, depart: 240 }
];
const beforeStops = JSON.stringify(stops);
const visits = visitHelpers.consecutiveExactDropVisits(stops, rows);

assert.equal(visits.length, 5, "Only the adjacent exact-address drops should become one physical visit.");
assert.deepEqual(
  visits[1].entries.map((entry) => entry.stop.id),
  ["custom-1", "so-1"],
  "A custom order and sales order at the same normalized address must share one preview visit."
);
assert.equal(visits[3].entries.length, 1, "A pickup between equal addresses must prevent a non-consecutive merge.");
assert.equal(visits[4].entries.length, 1, "Different municipality text must not pass the exact normalized-address match.");
assert.equal(JSON.stringify(stops), beforeStops, "Preview grouping must not mutate or replace persisted dispatch stops.");
assert.equal(
  visitHelpers.consecutiveExactDropVisits([
    { id: "loc-1", type: "drop", orderId: "LOC-1", destinationLocationId: 101 },
    { id: "loc-2", type: "drop", orderId: "LOC-2", destinationLocationId: 202 }
  ]).length,
  1,
  "Destination IDs must not prevent adjacent exact-address drops from sharing one physical visit."
);
assert.equal(
  visitHelpers.consecutiveExactDropVisits([
    { id: "yard-1", type: "drop", orderId: "YARD-1" },
    { id: "yard-2", type: "drop", orderId: "YARD-2" }
  ]).length,
  1,
  "Own-yard drops whose resolved addresses match must share one physical visit."
);
assert.equal(
  visitHelpers.consecutiveExactDropVisits([
    { id: "yard-150-to", type: "drop", orderId: "YARD-150-TO", dropLocation: "150" },
    { id: "yard-150-so", type: "drop", orderId: "YARD-150-SO" }
  ]).length,
  1,
  "A TO to yard 150 and an SO at the resolved 150 Clark address must share one mixed-service physical visit."
);
assert.deepEqual(
  visitHelpers.previewVisitTiming(visits[1]),
  { arrival: 100, depart: 150, duration: 50 },
  "A merged visit must span the first arrival through the last logical stop departure."
);
assert.deepEqual(
  visitHelpers.previewVisitContainingStop({ stops }, { rows }, "so-1")?.entries.map((entry) => entry.stop.id),
  ["custom-1", "so-1"],
  "Hovering either child stop must resolve the complete physical visit."
);

const markerHelperSource = sourceSlice(
  "function mergeConsecutiveExactDropMarkers",
  "function spreadOverlappingMarkers"
);
const makeMarkerHelper = Function(
  "normalizedPlaceKey",
  `"use strict"; ${markerHelperSource}; return mergeConsecutiveExactDropMarkers;`
);
const mergeMarkers = makeMarkerHelper(normalize);
const markers = [
  { label: "6", title: "6. Pickup", type: "pick", orderId: "PICK-1", address: "100 Main St, Toronto, ON", stayMinutes: 15 },
  { label: "7", title: "7. Drop CUSTOM-1", type: "drop", orderId: "CUSTOM-1", address: "100 Main St., Toronto, ON", stayMinutes: 20 },
  { label: "8", title: "8. Drop SOB-1", type: "drop", orderId: "SOB-1", address: "100 MAIN ST Toronto ON", stayMinutes: 30 },
  { label: "9", title: "9. Drop SOB-3", type: "drop", orderId: "SOB-3", address: "100 Main St, Vaughan, ON", stayMinutes: 25 }
];
const beforeMarkers = JSON.stringify(markers);
const mergedMarkers = mergeMarkers(markers);
assert.equal(mergedMarkers.length, 3);
assert.equal(mergedMarkers[1].label, "7-8");
assert.deepEqual(mergedMarkers[1].orderIds, ["CUSTOM-1", "SOB-1"]);
assert.equal(mergedMarkers[1].stayMinutes, 50);
assert.equal(JSON.stringify(markers), beforeMarkers, "Map-marker grouping must remain presentation-only.");

const previewSource = sourceSlice("function renderPreviewDropVisit", "function renderLoadPreview");
assert.match(previewSource, /data-preview-visit="true"/);
assert.match(previewSource, /data-start-index="\$\{first\.index\}"/);
assert.match(previewSource, /data-end-index="\$\{last\.index\}"/);
assert.match(previewSource, /class="preview-stop-child[^"]*"[\s\S]*?data-stop=/);
assert.match(previewSource, /data-action="remove-stop"/);
assert.match(previewSource, /one physical stop/);
assert.match(previewSource, /Stop time \$\{durationText\(timing\.duration\)\}/);
assert.ok(
  previewSource.indexOf("<div class=\"merged-visit-orders\">") > previewSource.indexOf("<div class=\"stop-time\">"),
  "Merged child orders must be a full-width sibling below the summary and timing row."
);
assert.doesNotMatch(
  previewSource,
  /preview-stop-child[\s\S]*durationText\(Math\.max/,
  "A merged child must not imply that its logical duration is a second physical visit."
);

const tooltipSource = sourceSlice("function showOrderTooltip", "function showLoadTooltip");
assert.match(tooltipSource, /previewVisitContainingStop/);
assert.match(tooltipSource, /previewVisitTiming/);
assert.match(tooltipSource, /<b>Stop time<\/b>/);
assert.match(tooltipSource, /combinedRefs\.join\(" \+ "\)/);
assert.match(tooltipSource, /stopTimingBasisText/);

const dropIndexSource = sourceSlice("function insertIndexFromDrop", "function ensureSplitDraft");
assert.match(dropIndexSource, /dataset\.startIndex/);
assert.match(dropIndexSource, /dataset\.endIndex/);
assert.match(dropIndexSource, /boundedEndIndex \+ 1/);

const hoverSource = sourceSlice("function dispatchTooltipOwner", 'app.addEventListener("submit"');
assert.match(hoverSource, /owner\.contains\(event\.relatedTarget\)/);
assert.match(hoverSource, /app\.addEventListener\("pointerover", showDispatchTooltip\)/);
assert.match(hoverSource, /app\.addEventListener\("pointerout", hideDispatchTooltip\)/);
assert.doesNotMatch(hoverSource, /addEventListener\("mouseover"/);
assert.doesNotMatch(hoverSource, /addEventListener\("mouseout"/);

assert.match(styles, /\.preview-stop-list\s*\{[\s\S]*?grid-auto-rows:\s*max-content/);
assert.match(styles, /\.preview-stop\s*\{[\s\S]*?height:\s*auto[\s\S]*?grid-template-areas:\s*"main timing"/);
assert.match(styles, /\.preview-stop\.merged-drop-visit\s*\{[\s\S]*?"details details"/);
assert.match(styles, /\.merged-visit-orders\s*\{[\s\S]*?grid-area:\s*details/);
assert.match(styles, /@container load-preview \(max-width:\s*450px\)[\s\S]*?"main"\s*"timing"\s*"details"/);
assert.match(styles, /\.preview-stop-basis\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);

const mapPreviewSource = sourceSlice("async function renderGoogleMapPreview", "function routeLoadsNeedingEstimate");
assert.match(
  mapPreviewSource,
  /spreadOverlappingMarkers\(mergeConsecutiveExactDropMarkers\(markerStops\)\)/
);
assert.match(mapPreviewSource, /marker\.addListener\("mouseover"/);
assert.match(mapPreviewSource, /marker\.addListener\("mouseout"/);

const directionsSource = sourceSlice("function directionsRequestForLoad", "function googleRouteForLoad");
assert.doesNotMatch(
  directionsSource,
  /mergeConsecutiveExactDropMarkers/,
  "Marker grouping must never change Google Directions inputs or logical leg indexes."
);
assert.match(directionsSource, /waypoints: stops\.slice\(1, -1\)/);

const durationHelperSource = sourceSlice("function normalizedStopTimeOverride", "function loadStats");
const durationHelpers = Function(
  "stopOrder",
  "stopAddress",
  "normalizedPlaceKey",
  "isOwnYardCode",
  "normalizedPickupLocation",
  "dropLocationForStop",
  "truckStopMinutes",
  "stopServiceType",
  "pickupFootprintForLocation",
  "loadContainingStop",
  "truckOwnYardFixedMinutes",
  "truckVendorFixedMinutes",
  "truckDeliveryFixedMinutes",
  "truckMinutesPerPallet",
  "dropFootprintPallets",
  "explicitCustomDropStopMinutes",
  `"use strict"; ${durationHelperSource}; return { physicalVisitOverrideState, physicalVisitStayMinutes };`
)(
  stopOrder,
  stopAddress,
  normalize,
  () => false,
  normalize,
  () => "",
  (_truck, type, footprint) => type === "own" ? 40 : type === "vendor" ? 35 : 30 + Number(footprint || 0),
  (_stop, order) => order.serviceType || "delivery",
  () => 0,
  () => null,
  () => 40,
  () => 35,
  () => 30,
  () => 1,
  (order) => Number(order.footprint || 0),
  (_stop, order) => order.type === "CUSTOM" && Number.isInteger(order.stopMinutes) ? order.stopMinutes : null
);

const groupedDeliveryVisit = {
  type: "drop",
  entries: [
    { stop: {}, order: { id: "SO-1", serviceType: "delivery", footprint: 4 } },
    { stop: {}, order: { id: "SO-2", serviceType: "delivery", footprint: 6 } }
  ]
};
assert.equal(
  durationHelpers.physicalVisitStayMinutes(groupedDeliveryVisit, {}),
  40,
  "A grouped delivery must apply one fixed time plus the aggregate footprint."
);
assert.equal(
  durationHelpers.physicalVisitStayMinutes({
    ...groupedDeliveryVisit,
    entries: groupedDeliveryVisit.entries.map((entry) => ({ ...entry, stop: { stopTimeOverrideMinutes: 72 } }))
  }, {}),
  72,
  "A matching dispatcher visit override must win over the automatic driver rule."
);
assert.equal(
  durationHelpers.physicalVisitOverrideState({
    ...groupedDeliveryVisit,
    entries: [
      { ...groupedDeliveryVisit.entries[0], stop: { stopTimeOverrideMinutes: 72 } },
      { ...groupedDeliveryVisit.entries[1], stop: {} }
    ]
  }).conflict,
  true,
  "A grouped numeric/Automatic mismatch must be rejected as a conflict."
);
assert.equal(
  durationHelpers.physicalVisitStayMinutes({
    type: "drop",
    entries: [{ stop: {}, order: { id: "CUSTOM", type: "CUSTOM", serviceType: "delivery", footprint: 2, stopMinutes: 58 } }]
  }, {}),
  58,
  "A single Custom Order must keep its explicit visit duration."
);

const loadStatsSource = sourceSlice("function loadStats", "function loadHasPlanningContentForAssignment");
assert.match(loadStatsSource, /rows\[entry\.index\]\s*=\s*\{[\s\S]*?arrival, depart: current/);
assert.match(loadStatsSource, /physicalVisitsForLoad\(load\)/);
assert.match(loadStatsSource, /current \+= physicalVisitStayMinutes\(visit, truck\)/);
assert.match(loadStatsSource, /order details are temporarily unavailable/);
const timingPersistenceSource = sourceSlice("function trucksWithTimingMetadata", "function normalizePlanBeforeSave");
assert.doesNotMatch(
  timingPersistenceSource,
  /arrival: stats\.start, depart: stats\.start/,
  "A transiently unresolved stop must not be persisted as a fake zero-minute visit."
);
assert.match(timingPersistenceSource, /priorTiming/);
assert.match(timingPersistenceSource, /\(stats\.rows \|\| \[\]\)\.filter\(Boolean\)\.map/);

const overrideUiSource = sourceSlice("function renderVisitStopTimeOverride", "function renderPreviewDropVisit");
assert.match(overrideUiSource, /data-stop-time-override=/);
assert.match(overrideUiSource, /physicalVisitHasDriverActivity/);
assert.match(overrideUiSource, /for \(const entry of visit\.entries\)/);
assert.match(overrideUiSource, /entry\.stop\.stopTimeOverrideMinutes = normalized/);
assert.match(overrideUiSource, /invalidateDriverRoutesFromLoad/);

const travelUiSource = sourceSlice("function renderInterStopTravelCard", "function renderCompactStopSequence");
assert.match(travelUiSource, /leg\?\.actualLeave/);
assert.match(travelUiSource, /leg\?\.actualArrival/);
assert.match(travelUiSource, /leg\?\.forecastLeave/);
assert.match(travelUiSource, /inter-stop-travel/);
assert.match(travelUiSource, /travelLegExecutionStatus\(leg\)/);
assert.match(travelUiSource, /data-execution-status=/);
assert.match(
  travelUiSource,
  /if \(!leg && samePhysicalAddress\(previousVisit\.address, nextVisit\.address\)\) return ""/,
  "Co-located pickup/drop visit pairs without a real forecast leg must not render fake travel cards."
);
const travelStatusSource = sourceSlice("function travelLegExecutionStatus", "function renderInterStopTravelCard");
const travelLegExecutionStatus = Function(
  `"use strict"; ${travelStatusSource}; return travelLegExecutionStatus;`
)();
assert.equal(travelLegExecutionStatus({ status: "completed" }), "complete");
assert.equal(travelLegExecutionStatus({ status: "pending", actualArrival: "2026-08-01T14:20:00.000Z" }), "complete");
assert.equal(travelLegExecutionStatus({ status: "pending", actualLeave: "2026-08-01T14:10:00.000Z" }), "in_progress");
assert.equal(travelLegExecutionStatus({}), "pending");
assert.match(
  styles,
  /\.stop-card\.travel\.status-complete,\s*\.preview-stop\.travel\.status-complete\s*\{[\s\S]*?background:\s*#cfd7dd;/,
  "A completed travel card must use the completed grey background."
);
assert.match(
  styles,
  /\.stop-card\.travel\.status-in_progress,\s*\.preview-stop\.travel\.status-in_progress\s*\{[\s\S]*?background:\s*#fff9d8;/,
  "An active travel card must use the in-progress background."
);
assert.match(styles, /\.inter-stop-travel\s*\{\s*border-style:\s*dashed;/, "Only inter-stop travel cards keep the dashed border.");
assert.match(
  styles,
  /\.stop-time\s*\{[\s\S]*?justify-items:\s*end;/,
  "Stop timing blocks must align against the right side of their card."
);
assert.match(
  styles,
  /\.time-compare\s*\{[\s\S]*?width:\s*max-content;[\s\S]*?justify-content:\s*end;[\s\S]*?text-align:\s*right;/,
  "Plan and Actual timing rows must use their content width and stay right-aligned."
);

const timingUiSource = sourceSlice("function planTimelineTimeText", "function loadDriverActivityRecords");
const timingUi = Function(
  "timeText",
  "actualTimeText",
  "actualMinuteOfDay",
  "escapeHtml",
  `"use strict"; ${timingUiSource}; return { varianceMinutes, timingSummaryHtml, timingDetailHtml };`
)(
  (value) => `saved-${value}`,
  (value) => ({
    "shift-start": "10:20",
    "shift-end": "10:50",
    "actual-start": "10:22",
    "actual-end": "10:47",
    "after-midnight": "00:10",
    "2026-08-01T14:00:00.000Z": "14:00",
    "2026-08-01T14:30:00.000Z": "14:30",
    "2026-08-02T04:30:00.000Z": "04:30",
    "2026-08-02T05:00:00.000Z": "05:00"
  })[value] || "--",
  (value) => ({
    "shift-start": 620,
    "shift-end": 650,
    "actual-start": 622,
    "actual-end": 647,
    "after-midnight": 10
  })[value] ?? null,
  (value) => String(value)
);
const untouchedTiming = timingUi.timingSummaryHtml({ plannedStart: 100, plannedEnd: 130 });
assert.match(untouchedTiming, />Plan</);
assert.match(untouchedTiming, /saved-100/);
assert.match(untouchedTiming, /saved-130/);
assert.doesNotMatch(untouchedTiming, /Actual|Real|Fcst|Forecast|>Var</);
const shiftedTiming = timingUi.timingSummaryHtml({
  plannedStart: 100,
  plannedEnd: 130,
  forecastStart: "shift-start",
  forecastEnd: "shift-end"
});
assert.match(shiftedTiming, />Plan</);
assert.match(shiftedTiming, /10:20/);
assert.match(shiftedTiming, /10:50/);
assert.doesNotMatch(shiftedTiming, /saved-100|saved-130|Actual|Real|Fcst|Forecast|>Var/);
const actualTiming = timingUi.timingSummaryHtml({
  plannedStart: 600,
  plannedEnd: 630,
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "actual-start",
  actualEnd: "actual-end",
  status: "complete"
});
assert.match(actualTiming, />Actual</);
assert.match(actualTiming, /10:22/);
assert.match(actualTiming, />Var</);
assert.match(actualTiming, /Arr \+22m/);
assert.match(actualTiming, /LV \+17m/);
assert.doesNotMatch(actualTiming, />Plan|10:20|saved-600|Fcst|Forecast/);
const partialActualTiming = timingUi.timingSummaryHtml({
  plannedStart: 600,
  plannedEnd: 630,
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "actual-start",
  status: "in_progress"
});
assert.match(partialActualTiming, />Plan</);
assert.match(partialActualTiming, />Actual<\/span><span>Arr 10:22<\/span>/);
assert.match(partialActualTiming, />Var<\/span><span class="variance-row"><span class="variance-value late">Arr \+22m<\/span><\/span>/);
assert.doesNotMatch(partialActualTiming, /LV --|Arr --/, "A partial driver update must show only its recorded actual side.");
const invalidActualTiming = timingUi.timingSummaryHtml({
  plannedStart: 100,
  plannedEnd: 130,
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "not-a-timestamp",
  showActual: true
});
assert.doesNotMatch(invalidActualTiming, /Actual|Real/, "An empty or invalid actual timestamp must not create an Actual row.");
const pendingTimingWithStaleEvidence = timingUi.timingSummaryHtml({
  plannedStart: 600,
  plannedEnd: 630,
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "actual-start",
  status: "pending"
});
assert.match(pendingTimingWithStaleEvidence, />Plan</);
assert.doesNotMatch(pendingTimingWithStaleEvidence, /Actual|>Var</, "Pending cards must remain moving-Plan only.");
const shiftedDetail = timingUi.timingDetailHtml({
  title: "Drop",
  plannedStart: 100,
  plannedEnd: 130,
  forecastStart: "shift-start",
  forecastEnd: "shift-end"
});
assert.match(shiftedDetail, /<strong>Plan<\/strong>/);
assert.match(shiftedDetail, /saved-100/);
assert.match(shiftedDetail, /saved-130/);
assert.match(shiftedDetail, /<strong class="timing-forecast">Forecast<\/strong>/);
assert.match(shiftedDetail, /10:20/);
assert.match(shiftedDetail, /10:50/);
assert.match(shiftedDetail, /<strong>Actual<\/strong> Arrive: -- \| Leave: --/);
assert.match(shiftedDetail, /<strong>Var<\/strong>[\s\S]*?Arrive --[\s\S]*?Leave --/);
const completedDetail = timingUi.timingDetailHtml({
  title: "Drop",
  plannedStart: 600,
  plannedEnd: 630,
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "actual-start",
  actualEnd: "actual-end",
  status: "complete"
});
assert.match(completedDetail, /<strong>Plan<\/strong>[\s\S]*?saved-600[\s\S]*?saved-630/);
assert.match(completedDetail, /<strong class="timing-forecast">Forecast<\/strong>[\s\S]*?10:20[\s\S]*?10:50/);
assert.match(completedDetail, /<strong>Actual<\/strong>/);
assert.match(completedDetail, /<strong>Var<\/strong>/);
assert.match(completedDetail, /Arrive \+22m/);
assert.match(completedDetail, /Leave \+17m/);
assert.equal(timingUi.varianceMinutes("after-midnight", 1430), 20, "Variance must use the closest planned clock time across midnight.");
const exactBaselineTiming = timingUi.timingSummaryHtml({
  plannedStart: 600,
  plannedEnd: 630,
  originalStart: "2026-08-01T14:00:00.000Z",
  originalEnd: "2026-08-01T14:30:00.000Z",
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "2026-08-02T04:30:00.000Z",
  actualEnd: "2026-08-02T05:00:00.000Z",
  status: "complete"
});
assert.match(exactBaselineTiming, /Arr \+14h30m/);
assert.match(exactBaselineTiming, /LV \+14h30m/);
assert.doesNotMatch(exactBaselineTiming, /-9h30m/, "Exact original-plan timestamps must win over nearest-clock fallback for long delays.");
const exactBaselineDetail = timingUi.timingDetailHtml({
  title: "Long delay",
  plannedStart: 600,
  plannedEnd: 630,
  originalStart: "2026-08-01T14:00:00.000Z",
  originalEnd: "2026-08-01T14:30:00.000Z",
  forecastStart: "shift-start",
  forecastEnd: "shift-end",
  actualStart: "2026-08-02T04:30:00.000Z",
  actualEnd: "2026-08-02T05:00:00.000Z",
  status: "complete"
});
assert.match(exactBaselineDetail, /<strong>Plan<\/strong> Arrive: 14:00 \| Leave: 14:30/);
assert.match(exactBaselineDetail, /<strong class="timing-forecast">Forecast<\/strong> Arrive: 10:20 \| Leave: 10:50/);
assert.match(exactBaselineDetail, /Arrive \+14h30m/);
assert.match(exactBaselineDetail, /Leave \+14h30m/);

const timelineLookupSource = sourceSlice("function forecastTimelineRecordsForLoad", "function timestampMinuteOr");
const timelineLookup = Function(
  "forecastMatchesCurrentPlan",
  "dispatchForecast",
  `"use strict"; ${timelineLookupSource}; return { forecastTimelineRecordsForLoad, forecastTimelineRecordForKind };`
)(
  () => true,
  {
    timelineEvents: [
      { eventId: "rest:L1", loadId: "L1", kind: "rest", forecastStart: "shift-start", forecastEnd: "shift-end" },
      { eventId: "switch:L1", loadId: "L1", kind: "truck_switch", forecastStart: "shift-end", forecastEnd: "actual-start" },
      { eventId: "rest:L2", loadId: "L2", kind: "rest" }
    ]
  }
);
assert.deepEqual(timelineLookup.forecastTimelineRecordsForLoad({ id: "L1" }).map((record) => record.eventId), ["rest:L1", "switch:L1"]);
assert.equal(timelineLookup.forecastTimelineRecordForKind({ id: "L1" }, "rest")?.eventId, "rest:L1");
assert.equal(timelineLookup.forecastTimelineRecordForKind({ id: "L1" }, "truck_switch")?.eventId, "switch:L1");

const restSwitchCardSource = sourceSlice("function renderTruckSwitchStop", "function renderStartTravelStop");
assert.match(restSwitchCardSource, /forecastTimelineRecordForKind\(load, "truck_switch"\)/);
assert.match(restSwitchCardSource, /forecastTimelineRecordForKind\(load, "rest"\)/);
assert.match(restSwitchCardSource, /forecastStart: timeline\?\.forecastStart/);
assert.match(restSwitchCardSource, /forecastEnd: timeline\?\.forecastEnd/);
assert.match(restSwitchCardSource, /actualStart: timeline\?\.actualStart/);
assert.match(restSwitchCardSource, /data-timeline-event=/);
const previewRestSwitchSource = sourceSlice("function renderPreviewRestStop", "function renderPreviewStop");
assert.match(previewRestSwitchSource, /forecastTimelineRecordForKind\(load, "rest"\)/);
assert.match(previewRestSwitchSource, /forecastTimelineRecordForKind\(load, "truck_switch"\)/);
assert.match(previewRestSwitchSource, /forecastStart: timeline\?\.forecastStart/);
assert.match(previewRestSwitchSource, /actualEnd: timeline\?\.actualEnd/);
const timingDetailSource = sourceSlice("function renderLoadTimingDetails", "function consecutiveExactDropVisits");
assert.match(timingDetailSource, /title: "Rest \/ Wait"[\s\S]*?forecastStart: timeline\?\.forecastStart/);
assert.match(timingDetailSource, /forecastTimelineRecordForKind\(load, "truck_switch"\)/);
assert.doesNotMatch(source, /renderRestStop\(stats\)|renderPreviewRestStop\(stats\)/);

const loadFinishUiSource = sourceSlice("function loadFinishText", "function fallbackTravelMinutesBetweenStops");
assert.match(loadFinishUiSource, /return `Finish \$\{finishText\}`/);
assert.doesNotMatch(loadFinishUiSource, /"Forecast"/);
const loadPreviewUiSource = sourceSlice("function renderLoadPreview", "function renderPreviewRestStop");
assert.match(loadPreviewUiSource, />Plan finish</);
assert.match(loadPreviewUiSource, />Plan, Forecast, Actual and Variance</);
assert.doesNotMatch(loadPreviewUiSource, /Forecast finish|Planned vs Actual|Arrival\/leave variance/);

const endingTripSource = sourceSlice("function isFinalManualReturnForDriver", "function normalizedDriverLaneOrder");
assert.match(endingTripSource, /load\.endingTrip = false/);
const endingEligibilitySource = sourceSlice("function endingTripRouteEntries", "function clearInvalidEndingTrips");
assert.match(endingEligibilitySource, /filter\(\(entry\) => loadHasPlanningContentForAssignment\(entry\.load\)\)/);
assert.match(endingEligibilitySource, /left\.plannedStart - right\.plannedStart/);
assert.match(endingEligibilitySource, /Number\(left\.load\.driverSequence \|\| 0\)/);
let endingEntries = [];
const endingEligibility = Function(
  "driverLoadEntries",
  "loadHasPlanningContentForAssignment",
  "loadStats",
  "loadDriverKey",
  `"use strict"; ${endingEligibilitySource}; return isFinalManualReturnForDriver;`
)(
  () => endingEntries,
  (load) => Boolean(load.returnOnly || load.stops?.length),
  (_truck, load) => ({ start: load.plannedStart }),
  () => "driver-1"
);
const endingReturn = { id: "return", returnOnly: true, manual: true, plannedStart: 300, driverSequence: 9, stops: [] };
endingEntries = [
  { truck: {}, load: { id: "route", plannedStart: 100, driverSequence: 5, stops: [{}] } },
  { truck: {}, load: endingReturn },
  { truck: {}, load: { id: "empty", plannedStart: 999, driverSequence: 99, stops: [] } }
];
assert.equal(endingEligibility({}, endingReturn), true, "A later empty load must not clear Ending trip.");
endingEntries.push({ truck: {}, load: { id: "later-route", plannedStart: 400, driverSequence: 1, stops: [{}] } });
assert.equal(endingEligibility({}, endingReturn), false, "A later actual route load must clear Ending trip regardless of sequence number.");
assert.match(source, /data-ending-trip=/);
assert.match(source, /clearInvalidEndingTrips\(\{ notify: true, audit: true \}\)/);

const renderStateSource = sourceSlice("function selectorForElement", "function render");
assert.match(renderStateSource, /"data-stop-time-override"/);
assert.match(renderStateSource, /"data-ending-trip"/);
assert.match(renderStateSource, /activeValue/);
assert.match(renderStateSource, /activeChecked/);
const forecastRefreshSource = sourceSlice("function forecastMatchesCurrentPlan", "function driverStatusByJobId");
assert.match(forecastRefreshSource, /dispatchBackgroundRenderBlocked/);
assert.match(forecastRefreshSource, /input, textarea, select, \[contenteditable='true'\]/);
assert.match(forecastRefreshSource, /15000/);
assert.match(forecastRefreshSource, /if \(!forecast \|\| !currentPlan\?\.id \|\| localPlanDirty\) return false/);
assert.match(forecastRefreshSource, /if \(!planId \|\| localPlanDirty \|\| dispatchForecastInFlight\) return false/);
assert.match(forecastRefreshSource, /sequence !== dispatchForecastRequestSequence[\s\S]*?\|\| localPlanDirty/);
const mutationSource = sourceSlice("function commitPlanMutation", "async function loadPlanHistory");
assert.match(mutationSource, /if \(planChanged\) clearDispatchForecast\(\)/);
const saveSource = sourceSlice("async function savePlanToServer", "function queueServerSave");
assert.ok(
  saveSource.indexOf("clearLocalPlanDirty(payload.savedAt, saveGeneration);")
    < saveSource.indexOf("loadDispatchForecast({ renderAfter: true })"),
  "A successful save must clear local dirty state before requesting its revision-matched forecast."
);
const statusRefreshSource = sourceSlice("async function loadDriverJobStatuses", "function forecastMatchesCurrentPlan");
assert.match(statusRefreshSource, /const preserveExisting = Boolean\(requestedPlanId && driverJobStatusesLoadedPlanId === requestedPlanId\)/);
assert.match(statusRefreshSource, /if \(!preserveExisting\) \{[\s\S]*?driverJobStatuses = \[\]/);
assert.ok(
  (statusRefreshSource.match(/String\(currentPlan\?\.id \|\| ""\) !== requestedPlanId/g) || []).length >= 2,
  "Status refresh must guard the plan both before assignment and after the attention request."
);
assert.doesNotMatch(
  statusRefreshSource,
  /catch \{\s*driverJobStatuses = \[\]/,
  "A transient same-plan poll failure must not repaint active jobs as pending or unlock controls."
);

const pickupRepresentativeSource = sourceSlice("function directOrderForStop", "function stopById");
assert.match(pickupRepresentativeSource, /pickupRepresentativeOrder\(loadContainingStop\(stop\), stop\) \|\| direct/);
assert.match(pickupRepresentativeSource, /if \(stopHasDriverActivity\(load, stop\)\) continue/);
assert.match(pickupRepresentativeSource, /stop\.orderId = replacement\.id/);
assert.doesNotMatch(pickupRepresentativeSource, /stop\.id\s*=/, "Pickup representative repair must preserve the opaque stop ID.");

console.log("Dispatch consecutive physical-visit preview checks passed.");

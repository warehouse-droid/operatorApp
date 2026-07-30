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
  ["SOB-3", { id: "SOB-3", type: "SO", address: "100 Main St, Vaughan, ON" }]
]);
const stopOrder = (stop) => orders.get(String(stop?.orderId || "")) || null;
const stopAddress = (_stop, order) => order?.address || "";

const visitHelperSource = sourceSlice(
  "function consecutiveExactDropVisits",
  "function previewVisitExecutionStatus"
);
const makeVisitHelpers = Function(
  "stopOrder",
  "stopAddress",
  "normalizedPlaceKey",
  `"use strict"; ${visitHelperSource}; return { consecutiveExactDropVisits, previewVisitTiming, previewVisitContainingStop };`
);
const visitHelpers = makeVisitHelpers(stopOrder, stopAddress, normalize);

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

console.log("Dispatch consecutive physical-visit preview checks passed.");

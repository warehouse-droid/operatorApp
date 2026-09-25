import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {return "";}
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

function context({ derived = false, grouped = false } = {}) {
  const record = { started_at: "2026-09-14T10:46:48.000Z", completed_at: "2026-09-14T11:28:49.000Z", actual_arrival_resolution_status: "unresolved", actual_arrival_error: "destination_coordinates_unavailable" };
  const forecast = { plannedArrival: "", actualArrival: derived ? "2026-09-14T11:15:00.000Z" : null, actualLeave: record.completed_at, actualArrivalSource: derived ? "samsara_gps_history" : "unresolved", actualArrivalReason: derived ? "" : "destination_coordinates_unavailable" };
  const order = { id: "TEST", address: "Test destination", type: "SO" };
  const stop = { id: "D1", type: "drop", loadId: "L1", orderId: "TEST" };
  const row = { arrival: 420, depart: 450 };
  const entries = [0, 1].map(index => ({ order, stop: { ...stop, id: `D${index + 1}` }, index, row }));
  const captured = [];
  const globals = {
    selectedOrderId: "", stopOrder: () => order, stopExecutionStatus: () => "complete", driverRecordForStop: () => record,
    forecastRecordForStop: () => forecast, escapeHtml: value => String(value ?? "").replaceAll("<", "&lt;"),
    isDispatchPlanEditor: () => false, orderHasDriverActivityInLoad: () => true, stopActivityLockNotice: () => "Locked",
    dropStopLabel: () => "TEST", stopAddress: () => order.address, stopTimingBasisText: () => "",
    previewVisitExecutionStatus: () => "complete", durationText: () => "30m", renderVisitStopTimeOverride: () => "",
    orderTypeLabel: () => "SO", recordStartedAt: r => r?.started_at || "", recordCompletedAt: r => r?.completed_at || "",
    timingSummaryHtml: options => { captured.push(options); return "TIMING"; }, timingDetailHtml: options => { captured.push(options); return "DETAIL"; },
    physicalVisitsForLoad: () => [{ entries: grouped ? entries : [entries[0]], address: order.address }]
  };
  const c = vm.createContext(globals);
  for (const name of ["forecastTimingForStop", "stopArrivalTiming", "previewVisitTiming", "renderStop", "renderCompactDropVisit", "renderPreviewStop", "renderPreviewDropVisit", "renderLoadTimingDetails"]) {vm.runInContext(fn(name), c);}
  return { c, captured, stop, row, visit: { entries, address: order.address }, load: { id: "L1" } };
}

for (const name of ["renderStop", "renderCompactDropVisit", "renderPreviewStop", "renderPreviewDropVisit", "renderLoadTimingDetails"]) {
  test(`${name} retains completion but never restores an unresolved arrival from job start`, () => {
    const { c, captured, stop, row, visit, load } = context({ grouped: true });
    if (name === "renderLoadTimingDetails") {c[name]({}, load, { rows: [], restBefore: 0, switchBefore: false, startTravel: null });}
    else if (["renderCompactDropVisit", "renderPreviewDropVisit"].includes(name)) {c[name]({}, load, visit);}
    else {c[name]({}, load, stop, 0, row);}
    assert.ok(captured.length > 0);
    assert.equal(captured.at(-1).actualStart, "");
    assert.equal(captured.at(-1).actualEnd, "2026-09-14T11:28:49.000Z");
    assert.equal(captured.at(-1).arrivalUnavailable, true);
  });
}

test("resolved arrival is shown even if an older record had an unresolved calculation", () => {
  const { c, captured, stop, row, load } = context({ derived: true });
  c.renderStop({}, load, stop, 0, row);
  assert.equal(captured[0].actualStart, "2026-09-14T11:15:00.000Z");
});

test("timing markup explains unavailable arrival without inventing a timestamp", () => {
  const c = vm.createContext({
    escapeHtml: value => String(value ?? "").replaceAll("<", "&lt;"),
    actualTimelineText: () => "LV 07:28", timelineDisplayStatus: () => "complete", varianceTimelineHtml: () => "",
    planTimelineTimeText: () => "07:00"
  });
  vm.runInContext(fn("arrivalUnavailableText") + fn("timingSummaryHtml"), c);
  const html = c.timingSummaryHtml({ status: "complete", actualEnd: "2026-09-14T11:28:49.000Z", arrivalUnavailable: true, arrivalReason: "destination_coordinates_unavailable" });
  assert.match(html, /Arrival unavailable/i);
  assert.match(html, /destination coordinates/i);
  assert.doesNotMatch(html, /06:46/);
});

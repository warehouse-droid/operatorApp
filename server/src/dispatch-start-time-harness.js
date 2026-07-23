import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dispatch.js", import.meta.url), "utf8");

function sourceSlice(startMarker, endMarker, description = startMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected ${description} source was not found.`);
  return source.slice(start, end);
}

const startHelperSource = sourceSlice(
  "function normalizeTypedDispatchTime",
  "function driverJobIdForStop",
  "dispatch start-time helpers"
);
const makeStartHelpers = Function(
  `"use strict"; ${startHelperSource}; return { normalizeTypedDispatchTime, resolvedLoadStartMode };`
);
const { normalizeTypedDispatchTime, resolvedLoadStartMode } = makeStartHelpers();

for (const [typed, expected] of [
  ["7", "07:00"],
  ["07", "07:00"],
  ["700", "07:00"],
  ["0730", "07:30"],
  ["7:30", "07:30"],
  ["7:5", "07:05"],
  ["  23:59  ", "23:59"],
  ["0000", "00:00"]
]) {
  assert.equal(normalizeTypedDispatchTime(typed), expected, `Expected ${JSON.stringify(typed)} to normalize to ${expected}.`);
}

for (const typed of ["", null, undefined, "24:00", "12:60", "-1", "7pm", "12.30", "12345", "::", "noon"]) {
  assert.equal(normalizeTypedDispatchTime(typed), "", `Expected ${JSON.stringify(typed)} to be rejected.`);
}

assert.equal(resolvedLoadStartMode({}), "auto", "A legacy blank load must inherit its start automatically.");
assert.equal(resolvedLoadStartMode({ start: "" }), "auto", "A legacy empty start must infer auto mode.");
assert.equal(resolvedLoadStartMode({ start: "08:15" }), "fixed", "A legacy populated start must infer fixed mode.");
assert.equal(resolvedLoadStartMode({ startMode: "auto", start: "08:15" }), "auto", "An explicit auto mode must override a stale legacy start value.");
assert.equal(resolvedLoadStartMode({ start_mode: "fixed" }), "fixed", "The persisted snake-case start mode must remain compatible.");
assert.equal(resolvedLoadStartMode({ startMode: "unexpected", start: "09:00" }), "fixed", "An unknown mode must fall back to legacy inference.");

const loadStartInfoSource = sourceSlice("function loadStartInfo", "function startPointAfterLoad", "load start calculation");
const makeLoadStartInfo = Function(
  "driverOrientedPlanningEnabled",
  "previousDriverLoad",
  "effectiveTruckForLoad",
  "minutes",
  "loadStats",
  "loadTruckPlate",
  "dispatchPlanningSettings",
  "switchApproachTravelForLoad",
  "routeLegMinutesForLoad",
  "loadIndexInTruck",
  "DEFAULT_FIRST_LOAD_START",
  `"use strict"; ${startHelperSource} ${loadStartInfoSource}; return loadStartInfo;`
);

let previousEntry = null;
const loadStartInfo = makeLoadStartInfo(
  () => true,
  () => previousEntry,
  (truck) => truck,
  (value) => {
    const [hour, minute] = String(value || "00:00").split(":").map(Number);
    return (hour * 60) + minute;
  },
  (_truck, load) => ({ finish: Number(load.finish || 0) }),
  (truck, load) => String(load?.truckPlate || truck?.plate || ""),
  { truckSwitchMinutes: 10 },
  () => null,
  () => [],
  () => 0,
  "07:00"
);

const truck = { id: "truck-1", plate: "TRK-1", start: "07:00" };
previousEntry = { truck, load: { id: "prior", truckPlate: "TRK-1", finish: 600 } };

const inherited = loadStartInfo(truck, { id: "auto", truckPlate: "TRK-1", startMode: "auto", start: "08:00" });
assert.equal(inherited.start, 600, "An auto load must inherit the prior load's 10:00 finish.");
assert.equal(inherited.scheduledStart, 600, "A stale stored start must not become an auto load's schedule.");
assert.equal(inherited.restBefore, 0, "An inherited start must not create artificial rest time.");
assert.equal(inherited.startClamped, false);

const dedicated = loadStartInfo(truck, { id: "fixed", truckPlate: "TRK-1", startMode: "fixed", start: "11:00" });
assert.equal(dedicated.start, 660, "A dedicated 11:00 start must remain fixed.");
assert.equal(dedicated.scheduledStart, 660);
assert.equal(dedicated.restBefore, 60, "A later dedicated start must expose the one-hour gap.");
assert.equal(dedicated.startClamped, false);

const clamped = loadStartInfo(truck, { id: "fixed-early", truckPlate: "TRK-1", startMode: "fixed", start: "09:30" });
assert.equal(clamped.scheduledStart, 570, "The requested fixed time must remain visible for diagnostics.");
assert.equal(clamped.start, 600, "A fixed time cannot overlap the preceding load.");
assert.equal(clamped.startClamped, true, "An overlapping fixed time must be marked as clamped.");

const legacyFixed = loadStartInfo(truck, { id: "legacy", truckPlate: "TRK-1", start: "10:30" });
assert.equal(legacyFixed.start, 630, "Existing plans with a populated legacy start must keep that dedicated start.");

previousEntry = null;
const firstAuto = loadStartInfo(truck, { id: "first-auto", truckPlate: "TRK-1", startMode: "auto", start: "09:00" });
assert.equal(firstAuto.start, 420, "The first auto load must use the truck/default lane start, not stale typed data.");

const startControlSource = sourceSlice("function renderLoadStartControl", "function renderLoadAssignmentControls", "shared load start controls");
assert.match(startControlSource, /data-load-start-mode=/, "The shared control must offer an explicit Auto/Fixed start mode.");
assert.match(startControlSource, /data-load-start=/, "The shared control must retain a dedicated start input.");
assert.match(startControlSource, /type="text"/, "The dedicated start input must accept direct compact typing such as 700 and 0730.");
assert.match(startControlSource, /inputmode="numeric"/, "The dedicated start input must request a numeric keyboard.");
assert.doesNotMatch(startControlSource, /data-load-start=[^>]*type="time"/, "The shared control must not depend on the browser time picker.");

const assignmentUiSource = sourceSlice("function renderLoadAssignmentControls", "\nfunction renderLoad(parentTruck, load)", "load assignment start controls");
assert.match(assignmentUiSource, /renderLoadStartControl\(parentTruck, load,/, "The load card must render the shared Auto/Fixed start control.");

const previewUiSource = sourceSlice("function renderLoadPreview", "function renderPreviewRestStop", "load preview start controls");
assert.match(previewUiSource, /renderLoadStartControl\(parentTruck, load,\s*{[^}]*preview:\s*true[^}]*}\)/, "The preview must render the same direct-typing Auto/Fixed control as the load card.");

const payloadSource = sourceSlice("function trucksWithTimingMetadata", "function normalizePlanBeforeSave", "saved load timing metadata");
assert.match(payloadSource, /startMode(?:\s*:\s*startMode)?\s*,/, "Saved loads must retain their resolved start mode.");
assert.match(payloadSource, /start:\s*startMode\s*===\s*"auto"\s*\?\s*""/, "Auto loads must not persist a stale dedicated start.");

const startModeHandlerIndex = source.indexOf("dataset?.loadStartMode");
assert.ok(startModeHandlerIndex >= 0, "The change handler must process start-mode changes.");
const startModeHandlerSource = source.slice(startModeHandlerIndex, startModeHandlerIndex + 1800);
assert.match(startModeHandlerSource, /loadStartInfo\(found\.truck, found\.load\)\.start/, "The mode handler must capture the inherited time before changing the model.");
assert.match(startModeHandlerSource, /found\.load\.startMode\s*=/, "The selected mode must be written to the load model.");
assert.match(startModeHandlerSource, /load_start_mode_updated/, "Mode changes must be visible in dispatch audit history.");

const sourceAfterModeHandler = source.slice(startModeHandlerIndex + 1);
const startHandlerMatch = /event\.target\?\.dataset\?\.loadStart(?:\s*!==\s*undefined)?\)/.exec(sourceAfterModeHandler);
const startHandlerIndex = startHandlerMatch ? startModeHandlerIndex + 1 + startHandlerMatch.index : -1;
assert.ok(startHandlerIndex >= 0, "The change handler must process a dedicated start value.");
const startHandlerSource = source.slice(startHandlerIndex, startHandlerIndex + 1600);
assert.match(startHandlerSource, /normalizeTypedDispatchTime\(event\.target\.value\)/, "Typed start values must be normalized before reaching the model.");
assert.match(startHandlerSource, /found\.load\.startMode\s*=\s*"fixed"/, "Entering a dedicated time must switch the load to fixed mode.");

const reflowSource = sourceSlice("function reflowDriverLaneEntries", "function moveLoadToDriverLane", "driver-lane reflow");
assert.match(reflowSource, /resolvedLoadStartMode\(entry\.load\)/, "Lane reflow must preserve auto versus fixed semantics.");

console.log("Dispatch start-time behavior and integration checks passed.");

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");

const [setupUi, plannerUi, repository, setupHtml, plannerHtml] = await Promise.all([
  fs.readFile(path.join(publicDir, "dispatch-setup.js"), "utf8"),
  fs.readFile(path.join(publicDir, "dispatch.js"), "utf8"),
  fs.readFile(path.join(dirname, "dispatch-setup-repository.js"), "utf8"),
  fs.readFile(path.join(publicDir, "dispatch-setup.html"), "utf8"),
  fs.readFile(path.join(publicDir, "dispatch.html"), "utf8")
]);

function sourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0, `Missing source marker: ${startMarker}`);
  assert(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const setupFunctions = [
  sourceRange(setupUi, "function setupRecordActive", "function validateUniqueDriverLogins"),
  sourceRange(setupUi, "function moveSetupDriver", "function renderOwnYards")
].join("\n");
const setupContext = vm.createContext({});
vm.runInContext(`
  let drivers = [
    { id: "old", login: "old", name: "Old", active: false, displayOrder: 0 },
    { id: "bravo", login: "bravo", name: "Bravo", active: true, displayOrder: 1 },
    { id: "alpha", login: "alpha", name: "Alpha", active: true, displayOrder: 2 }
  ];
  let selectedSetupIndex = 1;
  ${setupFunctions}
  const shownBefore = driverSetupRows().map(({ driver }) => driver.login);
  const moved = moveSetupDriver(1, 2);
  const canonicalAfter = drivers.map((driver) => driver.login);
  const shownAfter = driverSetupRows().map(({ driver }) => driver.login);
  const inactiveMove = moveSetupDriver(0, 1);
  globalThis.result = { shownBefore, moved, canonicalAfter, shownAfter, selectedSetupIndex, inactiveMove };
`, setupContext);
const setupResult = JSON.parse(JSON.stringify(setupContext.result));
assert.deepEqual(setupResult.shownBefore, ["bravo", "alpha", "old"], "Setup must show active drivers in persisted order, then disabled drivers.");
assert.equal(setupResult.moved, true, "Active driver drag did not reorder.");
assert.deepEqual(setupResult.canonicalAfter, ["old", "alpha", "bravo"], "Active reorder overwrote the disabled driver canonical slot.");
assert.deepEqual(setupResult.shownAfter, ["alpha", "bravo", "old"], "Dragged active order was not reflected in setup.");
assert.equal(setupResult.selectedSetupIndex, 2, "Selected driver did not follow its canonical record after drag.");
assert.equal(setupResult.inactiveMove, false, "Disabled driver was allowed into the new-plan ordering drag.");

const plannerFunctions = sourceRange(plannerUi, "function normalizedDriverLaneOrder", "function nextDriverSequence");
const plannerContext = vm.createContext({});
vm.runInContext(`
  let drivers = [];
  let trucks = [];
  let driverLaneOrder = [];
  let currentPlan = { id: 77 };
  let currentPlanDate = "2026-07-22";
  const audit = [];
  function driverKey(driver) { return String(driver?.login || driver?.name || "").trim(); }
  function loadDriverKey(truck, load) { return String(load?.driverLogin || truck?.driverLogin || "").trim().toLowerCase(); }
  function loadHasPlanningContentForAssignment(load) { return Boolean(load?.returnOnly || (load?.stops || []).length || (load?.orders || []).length); }
  function driverLoadEntries() {
    const entries = [];
    for (const truck of trucks) {
      for (const load of truck.loads || []) {
        const login = loadDriverKey(truck, load);
        const driver = drivers.find((item) => driverKey(item).toLowerCase() === login) || null;
        entries.push({ truck, load, driverLogin: login, driver });
      }
    }
    return entries;
  }
  function logDispatchAudit(record) { audit.push(record); }
  ${plannerFunctions}
  drivers = [
    { login: "zulu", name: "Zulu", displayOrder: 0 },
    { login: "alpha", name: "Alpha", displayOrder: 1 }
  ];
  trucks = [];
  const freshOrder = [...ensureDriverLaneOrder(defaultDriverLaneOrder())];
  const moved = moveDriverLaneByDrop("zulu", "alpha", true);
  const movedOrder = [...driverLaneOrder];
  drivers = [{ login: "alpha", name: "Alpha", displayOrder: 1 }];
  trucks = [{
    driverLogin: "old", driver: "Old Driver", license: "DZ",
    loads: [{ id: "old-load", driverLogin: "old", driverName: "Old Driver", stops: [{ id: "drop-1" }] }]
  }];
  ensureDriverLaneOrder(["old", "alpha"]);
  const historicalOrder = [...driverLaneOrder];
  const historicalLane = driverLanes().find((lane) => lane.driverLogin === "old");
  trucks = [];
  const resetOrder = [...ensureDriverLaneOrder(defaultDriverLaneOrder())];
  globalThis.result = { freshOrder, moved, movedOrder, historicalOrder, historicalLane, resetOrder, audit };
`, plannerContext);
const plannerResult = JSON.parse(JSON.stringify(plannerContext.result));
assert.deepEqual(plannerResult.freshOrder, ["zulu", "alpha"], "New plan ignored persisted non-alphabetical driver order.");
assert.equal(plannerResult.moved, true, "Marker drop did not reorder a plan lane.");
assert.deepEqual(plannerResult.movedOrder, ["alpha", "zulu"], "Marker drop inserted the lane at the wrong side of its target.");
assert.deepEqual(plannerResult.historicalOrder, ["old", "alpha"], "Saved disabled-driver lane order was filtered by the active setup list.");
assert.equal(plannerResult.historicalLane?.historical, true, "Disabled saved driver was not rendered as a historical lane.");
assert.equal(plannerResult.historicalLane?.driverName, "Old Driver", "Historical lane lost its saved driver name.");
assert.deepEqual(plannerResult.resetOrder, ["alpha"], "A disabled historical driver leaked into fresh plan initialization.");
assert.equal(plannerResult.audit.length, 1, "Marker reorder did not create exactly one lane-order audit record.");

assert(setupUi.includes("driverSetupRows().map(({ driver, canonicalIndex })"), "Setup driver list is not using active-first derived rows.");
assert(setupUi.includes("data-driver-index") && setupUi.includes("draggedDriverSetupIndex"), "Setup driver drag hooks are missing.");
assert(setupUi.includes("previousDrivers = [...drivers]") && setupUi.includes("drivers = previousDrivers"), "Driver drag does not roll back after a failed save.");
assert(plannerUi.includes('dragged = { type: "driver-lane-order", driverLogin }'), "Lane marker drag has no isolated drag type.");
assert(plannerUi.includes('commitPlanMutation("move-driver-lane")'), "Lane marker drop is not persisted as a plan mutation.");
assert(plannerUi.includes('data-driver-lane-reorderable="${canReorder ? "true" : "false"}"'), "Historical/unassigned lanes are not excluded from lane reordering.");
assert(plannerUi.includes('${isHistorical ? "" : `data-driver-lane-drop="'), "Historical disabled lane can still accept dropped work.");
assert(plannerUi.includes("Disabled (historical plan)"), "Historical disabled lanes are not identified to the dispatcher.");
const savedRestore = sourceRange(plannerUi, "function applySavedPlan", "function compactCurrentPlan");
assert(savedRestore.indexOf("trucks = trucksFromFleetAndSavedPlan(saved.trucks);") < savedRestore.indexOf("ensureDriverLaneOrder(Array.isArray(saved.summary?.driverLaneOrder)"), "Saved lane order is restored before historical truck/load metadata.");
assert(repository.includes("displayOrder: numberValue(row.display_order, 0)"), "Setup API does not expose persisted display order.");
assert(repository.includes("cleanDriver(driver, index)"), "Driver request order is not explicitly persisted as display_order.");
assert(setupHtml.includes("20260723-driver-order-v1") && plannerHtml.includes("20260723-driver-order-v1"), "Browser asset versions were not bumped.");

console.log(JSON.stringify({
  ok: true,
  activeFirstSetup: true,
  persistedNewPlanOrder: true,
  historicalDisabledLane: true,
  markerLaneDrag: true,
  tests: 21
}));

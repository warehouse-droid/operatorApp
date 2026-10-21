import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { parse } from "espree";
import fc from "fast-check";

const source = readFileSync("public/dispatch.js", "utf8");
const declarations = parse(source, { ecmaVersion: "latest", sourceType: "script", range: true }).body;
function frontend(names, values = {}) {
  const context = vm.createContext(values);
  for (const name of ["isMbtPlanningLoad", "isPlanningLoadReadOnly", ...names]) {
    const node = declarations.find(item => item.type === "FunctionDeclaration" && item.id.name === name);
    assert.ok(node, name);
    vm.runInContext(source.slice(...node.range), context);
  }
  return context;
}

test("read-only ownership follows load kind for both planners, including returns and canonical BIN stops", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (binPage, binLoad, returnOnly) => {
    const api = frontend([], binPage ? { MbbsBinPlanning: {} } : {});
    const load = { mbtPlanning: binLoad, returnOnly, stops: [] };
    const before = JSON.stringify(load);
    assert.equal(api.isPlanningLoadReadOnly(load), binPage !== binLoad);
    assert.equal(JSON.stringify(load), before);
    assert.equal(api.isPlanningLoadReadOnly(null), false);
    assert.equal(api.isPlanningLoadReadOnly({ stops: [{ mbt: { visitId: "canonical-bin" } }] }), !binPage);
  }), { numRuns: 100, seed: 270927 });
});

test("read-only truck-switch timing stays on the saved schedule while another planner has a draft", () => {
  const api = frontend(["loadStartInfo"], { MbbsBinPlanning: {},
    driverOrientedPlanningEnabled: () => true,
    previousDriverLoad: () => ({ truck: { plate: "BIN" }, load: { plannedFinishMinute: 1000 } }),
    loadTruckPlate: truck => truck.plate, resolvedLoadStartMode: () => "fixed",
    switchApproachTravelForLoad: () => ({ from: "Draft site", to: "12441", minutes: 99 }) });
  const load = { stops: [], truckSwitchMinutes: 10, timing: { start: 900, scheduledStart: 900,
    previousFinish: 480, restBefore: 380, switchStart: 890,
    handoffTravel: { from: "Saved site", to: "12441", minutes: 30, start: 860, finish: 890 } } };
  const before = JSON.stringify(load);
  const actual = api.loadStartInfo({ plate: "FLATBED" }, load);
  assert.equal(actual.start, 900); assert.equal(actual.previousFinish, 480);
  assert.equal(actual.restBefore, 380); assert.equal(actual.switchBefore, true);
  assert.equal(actual.switchMinutes, 10); assert.equal(actual.handoffStart, 860);
  assert.equal(actual.handoffTravel.from, "Saved site"); assert.equal(actual.handoffMinutes, 30);
  assert.equal(JSON.stringify(load), before);
});

function timingFrontend(loads) {
  const truck = { id: "flatbed", plate: "FLATBED", loads };
  return frontend(["loadStats", "loadStartInfo", "loadHasPlanningContentForAssignment", "localDispatchLoadAssignmentConflict"], {
    trucks: [truck], dispatchPlanningSettings: { truckSwitchMinutes: 10 },
    driverOrientedPlanningEnabled: () => true,
    previousDriverLoad: (_truck, load) => {
      const index = loads.indexOf(load);
      return index > 0 ? { truck, load: loads[index - 1] } : null;
    },
    loadTruckPlate: () => "FLATBED", loadDriverKey: () => "aurther", loadDriver: () => ({ name: "Aurther" }),
    effectiveTruckForLoad: value => value, resolvedLoadStartMode: load => load.startMode || "auto",
    normalizeTypedDispatchTime: value => value || "", DEFAULT_FIRST_LOAD_START: "08:00",
    minutes: value => value.split(":").reduce((hours, minute) => hours * 60 + Number(minute)),
    timeText: value => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`,
    estimateForLoad: () => null, adjustedTravelMinutesForTruck: (_truck, value) => value,
    truckCapacityLbs: () => 20000
  });
}

function savedReturn(id, start, finish, overrides = {}) {
  return { id, name: `Load ${id}`, returnOnly: true, stops: [], returnMinutes: 90,
    plannedStartMinute: start, plannedFinishMinute: finish,
    timing: { start, finish, scheduledStart: start, restBefore: 0 }, ...overrides };
}

test("BIN planning uses saved Dispatch finishes instead of creating an Aurther Load 2/3 overlap", () => {
  const loads = [savedReturn("2", 480, 510), savedReturn("3", 510, 540)];
  const api = timingFrontend(loads);
  const before = JSON.stringify(loads);
  assert.equal(api.localDispatchLoadAssignmentConflict(), null, "Dispatch automatically sequences its editable loads");
  assert.equal(api.loadStats(api.trucks[0], loads[0]).finish, 570);
  api.MbbsBinPlanning = {};
  assert.equal(api.localDispatchLoadAssignmentConflict(), null, "Read-only Dispatch loads retain their saved non-overlapping intervals");
  for (const load of loads) {
    const stats = api.loadStats(api.trucks[0], load);
    assert.equal(stats.start, load.plannedStartMinute);
    assert.equal(stats.finish, load.plannedFinishMinute);
    assert.equal(stats.returnTrip, 30);
  }
  assert.equal(JSON.stringify(loads), before);
});

test("BIN planning still detects an editable BIN load overlapping the next saved Dispatch load", () => {
  const loads = [savedReturn("2", 480, 510, { mbtPlanning: true }), savedReturn("3", 510, 540)];
  const api = timingFrontend(loads);
  api.MbbsBinPlanning = {};
  assert.equal(api.loadStats(api.trucks[0], loads[0]).finish, 570, "Editable BIN timing must still recalculate");
  assert.equal(api.localDispatchLoadAssignmentConflict()?.code, "DISPATCH_DRIVER_TIME_CONFLICT");
});

test("legacy read-only loads without a saved finish retain calculated timing", () => {
  const load = savedReturn("2", 480, 510);
  delete load.plannedFinishMinute;
  delete load.timing.finish;
  const api = timingFrontend([load]);
  api.MbbsBinPlanning = {};
  assert.equal(api.loadStats(api.trucks[0], load).finish, 570);
});

test("shared mutation entry points refuse read-only loads even outside their disabled card controls", () => {
  for (const binPage of [false, true]) {
    const load = { id: "locked", mbtPlanning: !binPage, stops: [] };
    const truck = { id: "truck", loads: [load] };
    const api = frontend(["addOrderToLoad", "deleteLoad", "moveLoadToDriverLane", "moveLoadToPhysicalTruck", "updatePhysicalVisitStopTimeOverride"], {
      ...(binPage ? { MbbsBinPlanning: {} } : {}), trucks: [truck],
      findLoad: () => ({ load, truck }), orderById: () => ({ id: "order" }), ensureDispatchPlanEditor: () => true,
      loadHasDriverActivity: () => assert.fail("Read-only load entered the delete workflow") });
    const before = JSON.stringify(truck);
    assert.equal(api.addOrderToLoad("order", "locked"), false);
    assert.equal(api.moveLoadToDriverLane("locked", "driver"), null);
    assert.equal(api.moveLoadToPhysicalTruck("locked", "truck"), null);
    assert.equal(api.updatePhysicalVisitStopTimeOverride("locked", "stop", 90), false);
    api.deleteLoad("locked");
    assert.equal(JSON.stringify(truck), before);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dispatchSource = await readFile(
  new URL("../../../public/dispatch.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = dispatchSource.indexOf(marker);
  assert.notEqual(start, -1, `Expected ${name} to be implemented.`);
  const parametersOpen = dispatchSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "(") {
      parameterDepth += 1;
    }
    if (dispatchSource[index] === ")") {
      parameterDepth -= 1;
    }
    if (!parameterDepth) {
      parametersClose = index;
      break;
    }
  }
  assert.notEqual(parametersClose, -1, `Could not read ${name} parameters.`);
  const open = dispatchSource.indexOf("{", parametersClose);
  let depth = 0;
  for (let index = open; index < dispatchSource.length; index += 1) {
    if (dispatchSource[index] === "{") {
      depth += 1;
    }
    if (dispatchSource[index] === "}") {
      depth -= 1;
    }
    if (!depth) {
      return dispatchSource.slice(start, index + 1);
    }
  }
  throw new Error(`Could not read ${name}.`);
}

const plannerFunctions = [
  "timeText",
  "normalizeTypedDispatchTime",
  "resolvedLoadStartMode",
  "firstTruckUseEntry",
  "isFirstTruckUse",
  "driverLanePositionMetadata",
  "reflowDriverLaneEntries",
  "moveLoadToDriverLane"
].map(functionBody).join("\n");

const buildPlannerHarness = Function(
  "initialLoads",
  `"use strict";
    const DEFAULT_FIRST_LOAD_START = "07:00";
    const dispatchPlanningSettings = { truckSwitchMinutes: 10 };
    const drivers = [{ login: "driver-a", name: "Driver A" }];
    let trucks = [{
      id: "truck-a",
      plate: "TRUCK-A",
      base: "3445",
      start: "07:00",
      loads: structuredClone(initialLoads)
    }];

    function minutes(value) {
      const match = /^(\\d{1,2}):(\\d{2})$/.exec(String(value || DEFAULT_FIRST_LOAD_START));
      return match ? (Number(match[1]) * 60) + Number(match[2]) : 0;
    }
    function loadDriverKey(truck, load) {
      return String(load?.driverLogin || truck?.driverLogin || "").trim().toLowerCase();
    }
    function driverByKey(login) {
      return drivers.find((driver) => driver.login === String(login || "").toLowerCase()) || null;
    }
    function loadTruckPlate(truck, load) {
      return String(load?.truckPlate || truck?.plate || "").replace(/\\s+/g, "").toUpperCase();
    }
    function loadSwitchYard(truck, load) {
      return String(load?.switchYard || truck?.base || "12441").trim();
    }
    function loadHasPlanningContentForAssignment(load) {
      return Boolean(load?.returnOnly || load?.stops?.length || load?.orders?.length);
    }
    function findLoad(loadId) {
      for (const truck of trucks) {
        const load = (truck.loads || []).find((candidate) => candidate.id === loadId);
        if (load) return { truck, load };
      }
      return {};
    }
    function driverLoadEntries(driverLogin = null) {
      const requested = driverLogin === null ? null : String(driverLogin || "").toLowerCase();
      return trucks.flatMap((truck, truckIndex) => (truck.loads || []).map((load, loadIndex) => ({
        truck,
        load,
        truckIndex,
        loadIndex,
        driverLogin: loadDriverKey(truck, load),
        driver: driverByKey(loadDriverKey(truck, load)),
        sequence: Number(load.driverSequence || 0)
      }))).filter((entry) => requested === null || entry.driverLogin === requested)
        .sort((left, right) => left.sequence - right.sequence || left.loadIndex - right.loadIndex);
    }
    function calculatedTimingByLoad() {
      const result = new Map();
      let previousFinish = minutes(DEFAULT_FIRST_LOAD_START);
      for (const [index, entry] of driverLoadEntries("driver-a").entries()) {
        const mode = resolvedLoadStartMode(entry.load);
        const requested = minutes(normalizeTypedDispatchTime(entry.load.start) || DEFAULT_FIRST_LOAD_START);
        const start = index === 0
          ? (mode === "fixed" ? requested : minutes(DEFAULT_FIRST_LOAD_START))
          : (mode === "fixed" ? Math.max(requested, previousFinish) : previousFinish);
        const duration = Number(entry.load.testDuration || 30);
        result.set(entry.load.id, { start, duration });
        previousFinish = start + duration;
      }
      return result;
    }
    function driverEntryTimingSnapshot() {
      return calculatedTimingByLoad();
    }
    function assignLoadToDriver(_truck, load, login) {
      load.driverLogin = String(login || "").toLowerCase();
      load.driverName = driverByKey(login)?.name || "";
      return load;
    }
    function renumberDriverLoads() {
      for (const [index, entry] of driverLoadEntries("driver-a").entries()) {
        entry.load.name = "Load " + (index + 1);
      }
    }
    function driverOrientedPlanningEnabled() { return true; }
    function loadEndOwnYard(load) { return String(load?.endYard || ""); }
    function startPointAfterLoad() { return null; }
    function sameDispatchLocation(left, right) { return String(left || "") === String(right || ""); }
    function adjustedTravelMinutesForTruck(_truck, value) { return Number(value || 0); }
    function effectiveTruckForLoad(truck) { return truck; }
    function travelMinutesBetweenPoints() { return 0; }

    ${plannerFunctions}

    function moveBefore(loadId, targetLoadId) {
      return moveLoadToDriverLane(loadId, "driver-a", { targetLoadId, insertAfter: false });
    }
    function moveAfter(loadId, targetLoadId) {
      return moveLoadToDriverLane(loadId, "driver-a", { targetLoadId, insertAfter: true });
    }
    function lane() {
      return driverLoadEntries("driver-a").map(({ truck, load }) => ({
        id: load.id,
        name: load.name,
        driverSequence: load.driverSequence,
        startMode: resolvedLoadStartMode(load),
        start: load.start || "",
        switchYard: load.switchYard || "",
        truckId: load.truckId,
        truckPlate: load.truckPlate,
        stopIds: (load.stops || []).map((stop) => stop.id),
        firstTruckUse: isFirstTruckUse(truck, load)
      }));
    }
    function savedPayload() {
      return {
        trucks: trucks.map((truck) => ({
          ...truck,
          loads: driverLoadEntries("driver-a")
            .filter((entry) => entry.truck.id === truck.id)
            .map((entry) => ({ ...entry.load }))
        }))
      };
    }
    return { moveBefore, moveAfter, lane, savedPayload };
  `
);

const initialLoads = Object.freeze([
  {
    id: "load-a",
    name: "Load 1",
    driverLogin: "driver-a",
    driverName: "Driver A",
    driverSequence: 0,
    truckId: "truck-a",
    truckPlate: "TRUCK-A",
    startMode: "fixed",
    start: "07:00",
    switchYard: "3445",
    testDuration: 30,
    stops: [{ id: "stop-a", orderId: "SO-A", type: "drop" }]
  },
  {
    id: "load-b",
    name: "Load 2",
    driverLogin: "driver-a",
    driverName: "Driver A",
    driverSequence: 1,
    truckId: "truck-a",
    truckPlate: "TRUCK-A",
    startMode: "auto",
    start: "",
    switchYard: "2967",
    testDuration: 35,
    stops: [{ id: "stop-b", orderId: "SO-B", type: "drop" }]
  },
  {
    id: "load-c",
    name: "Load 3",
    driverLogin: "driver-a",
    driverName: "Driver A",
    driverSequence: 2,
    truckId: "truck-a",
    truckPlate: "TRUCK-A",
    startMode: "fixed",
    start: "13:00",
    switchYard: "150",
    testDuration: 40,
    stops: [{ id: "stop-c", orderId: "SO-C", type: "drop" }]
  }
]);

const expectedContent = new Map(initialLoads.map((load) => [load.id, {
  truckId: load.truckId,
  truckPlate: load.truckPlate,
  stopIds: load.stops.map((stop) => stop.id)
}]));

function newHarness() {
  return buildPlannerHarness(initialLoads);
}

function assertLaneInvariant(harness, expectedIds, label) {
  const lane = harness.lane();
  assert.deepEqual(lane.map((load) => load.id), expectedIds, `${label}: wrong load identity order.`);
  assert.deepEqual(lane.map((load) => load.name), ["Load 1", "Load 2", "Load 3"], `${label}: names did not follow positions.`);
  assert.deepEqual(lane.map((load) => load.driverSequence), [0, 1, 2], `${label}: sequence did not follow positions.`);
  assert.deepEqual(lane.map((load) => [load.startMode, load.start]), [
    ["fixed", "07:00"],
    ["auto", ""],
    ["fixed", "13:00"]
  ], `${label}: start metadata moved with load identity instead of staying with its route position.`);
  assert.equal(lane[0].switchYard, "3445", `${label}: the current Load 1 lost the starting yard.`);
  assert.deepEqual(lane.map((load) => load.firstTruckUse), [true, false, false], `${label}: Start Yard would render on the wrong load card.`);
  for (const load of lane) {
    assert.deepEqual({
      truckId: load.truckId,
      truckPlate: load.truckPlate,
      stopIds: load.stopIds
    }, expectedContent.get(load.id), `${label}: immutable load content changed for ${load.id}.`);
  }
}

function reorderTo(harness, expectedIds) {
  for (let index = 0; index < expectedIds.length; index += 1) {
    const currentIds = harness.lane().map((load) => load.id);
    if (currentIds[index] === expectedIds[index]) {
      continue;
    }
    harness.moveBefore(expectedIds[index], currentIds[index]);
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("DLR-01/DLR-02: non-adjacent Load 3 and Load 1 swaps keep route-start metadata positional", () => {
  const harness = newHarness();
  harness.moveBefore("load-c", "load-a");
  assertLaneInvariant(harness, ["load-c", "load-a", "load-b"], "Load 3 before Load 1");

  harness.moveAfter("load-c", "load-b");
  assertLaneInvariant(harness, ["load-a", "load-b", "load-c"], "Load 1 restored after Load 3");

  harness.moveAfter("load-a", "load-c");
  assertLaneInvariant(harness, ["load-b", "load-c", "load-a"], "Load 1 after Load 3");
});

test("DLR-03: all six three-load permutations preserve positional timing and immutable content", () => {
  const permutations = [
    ["load-a", "load-b", "load-c"],
    ["load-a", "load-c", "load-b"],
    ["load-b", "load-a", "load-c"],
    ["load-b", "load-c", "load-a"],
    ["load-c", "load-a", "load-b"],
    ["load-c", "load-b", "load-a"]
  ];
  for (const permutation of permutations) {
    const harness = newHarness();
    reorderTo(harness, permutation);
    assertLaneInvariant(harness, permutation, permutation.join(" > "));
  }
});

test("DLR-04: 6,400 seeded arbitrary before/after moves never detach Load 1 start context", () => {
  const seen = new Set();
  for (let seed = 1; seed <= 64; seed += 1) {
    const random = seededRandom(seed);
    const harness = newHarness();
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const ids = harness.lane().map((load) => load.id);
      const sourceIndex = Math.floor(random() * ids.length);
      let targetIndex = Math.floor(random() * (ids.length - 1));
      if (targetIndex >= sourceIndex) {
        targetIndex += 1;
      }
      const insertAfter = random() >= 0.5;
      if (insertAfter) {
        harness.moveAfter(ids[sourceIndex], ids[targetIndex]);
      } else {
        harness.moveBefore(ids[sourceIndex], ids[targetIndex]);
      }
      const currentIds = harness.lane().map((load) => load.id);
      seen.add(currentIds.join(","));
      assertLaneInvariant(harness, currentIds, `seed ${seed}, move ${iteration + 1}`);
    }
  }
  assert.equal(seen.size, 6, "Random moves did not cover all six load permutations.");
});

test("DLR-05: the save path serializes the corrected positional fields", () => {
  const harness = newHarness();
  harness.moveBefore("load-c", "load-a");
  const savedLoads = harness.savedPayload().trucks[0].loads;
  assert.deepEqual(savedLoads.map((load) => load.id), ["load-c", "load-a", "load-b"]);
  assert.deepEqual(savedLoads.map((load) => [load.startMode, load.start]), [
    ["fixed", "07:00"],
    ["auto", ""],
    ["fixed", "13:00"]
  ]);
  assert.equal(savedLoads[0].switchYard, "3445");
  assert.match(functionBody("planPayload"), /trucks:\s*trucksWithTimingMetadata\(\)/u);
  assert.match(functionBody("assignLoadFields"), /load\.switchYard\s*=\s*loadSwitchYard/u);
  assert.match(functionBody("trucksWithTimingMetadata"), /\.\.\.assignment[\s\S]*startMode/u);
});

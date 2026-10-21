import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { validateBinBoard } from "../../../src/mbt/bin-planning-board.js";

const uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const visit = { visitId: uuid, expectedVisitRevision: 1, stopOverrides: [] };
const load = { id: "load", truckId: "1", driverId: "2", driverSequence: 0, startMode: "fixed", start: "07:00",
  plannedStartMinute: 420, plannedFinishMinute: 480, visits: [visit] };
const plan = { trucks: [] };
const invalid = value => assert.throws(() => validateBinBoard(plan, value), e => e.status === 400 && e.code === "MBT_BIN_BOARD_INVALID");

test("board input rejects malformed IDs, null overrides, invalid timing and oversized collections before SQL", () => {
  for (const value of [null, {}, Array(501).fill(load), [null], [{ ...load, id: "" }], [load, load],
    [{ ...load, visits: [visit, visit] }], [{ ...load, visits: [null] }], [{ ...load, truckId: "bad" }],
    [{ ...load, driverId: "bad" }], [{ ...load, visits: [{ ...visit, visitId: "bad" }] }],
    [{ ...load, driverSequence: -1 }], [{ ...load, startMode: "later" }], [{ ...load, start: "25:00" }],
    [{ ...load, returnOnly: true }], [{ ...load, visits: Array(501).fill(visit) }],
    ...[null, {}, [null], [{ sequence: 0, minutes: 5 }], [{ sequence: 1, minutes: -1 }],
      [{ sequence: 1, minutes: 1441 }], [{ sequence: 1, minutes: 0 }, { sequence: 1, minutes: 5 }], Array(101).fill({ sequence: 1, minutes: 1 })]
      .map(stopOverrides => [{ ...load, visits: [{ ...visit, stopOverrides }] }]),
    [{ ...load, visits: [{ ...visit, expectedVisitRevision: 0 }] }],
    ...[null, [null], [{ sequence: 1, arrival: 450, depart: 449 }], [{ sequence: 1, arrival: -1, depart: 0 }],
      [{ sequence: 1, arrival: 420, depart: 1441 }], [{ sequence: 1, arrival: 420.1, depart: 425 }]]
      .map(stopTimings => [{ ...load, visits: [{ ...visit, stopTimings }] }])]) { invalid(value); }
});

test("board validation preserves arbitrary valid whole-visit order and rejects every duplicate", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 20 }), fc.integer({ min: 0, max: 1440 }), (ids, minutes) => {
    const visits = ids.map(visitId => ({ visitId, expectedVisitRevision: 1, stopOverrides: [{ sequence: 1, minutes }] }));
    const loads = [{ ...load, visits }]; const before = structuredClone(loads);
    assert.doesNotThrow(() => validateBinBoard(plan, loads));
    assert.deepEqual(loads, before);
    invalid([{ ...load, visits: [...visits, visits[0]] }]);
  }), { numRuns: 1000, seed: 20260927 });
});

test("bounded step timings preserve both endpoints and ordinary loads always remain protected", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1439 }), fc.integer({ min: 0, max: 100 }), (arrival, duration) => {
    const depart = Math.min(1440, arrival + duration);
    const candidate = { ...load, visits: [{ ...visit, stopTimings: [{ sequence: 1, arrival, depart }] }] };
    assert.doesNotThrow(() => validateBinBoard(plan, [candidate]));
    invalid([{ ...candidate, visits: [{ ...visit, stopTimings: [{ sequence: 1, arrival: -1, depart }] }] }]);
    const ordinary = { trucks: [{ truckType: "flatbed", loads: [{ id: candidate.id, stops: [{ type: "drop", orderId: "SO-1" }] }] }] };
    assert.throws(() => validateBinBoard(ordinary, [candidate]), e => e.status === 409 && e.code === "MBT_BIN_LOAD_REQUIRED");
  }), { numRuns: 1000, seed: 20260928 });
});

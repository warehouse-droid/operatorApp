import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { sequenceBinVisit, assertBinRouteCapacity, assertOrdinaryDispatchPreservesBins } from "../../../src/mbt/bin-planning-domain.js";

const groups = fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 20 }).map(ids => ids.map(visitId =>
  [1, 2, 3].map(sequence => ({ id: `${visitId}-${sequence}`, type: "BIN", mbt: { visitId, sequence } }))));
test("property: moving any visit preserves every group and its internal sequence", () => {
  fc.assert(fc.property(groups, fc.nat(), fc.boolean(), (visits, raw, earlier) => {
    const index = raw % visits.length; const delta = earlier ? -1 : 1;
    const stops = visits.flat(); const saved = structuredClone(stops);
    const result = sequenceBinVisit(stops, visits[index][0].mbt.visitId, delta);
    assert.deepEqual(stops, saved);
    assert.deepEqual(result.map(s => s.id).sort(), stops.map(s => s.id).sort());
    for (const group of visits) {
      const position = result.findIndex(s => s.id === group[0].id);
      assert.deepEqual(result.slice(position, position + group.length), group);
    }
    const expectedIndex = Math.min(visits.length - 1, Math.max(0, index + delta));
    assert.equal(result[expectedIndex * 3].mbt.visitId, visits[index][0].mbt.visitId);
  }), { seed: 9272026, numRuns: 1000 });
});
test("property: capacity depends on peak physical occupancy, not the number of visits", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 50 }), weights => {
    const movements = weights.flatMap((weightLbs, assetId) => [{ assetId, weightLbs, delta: 1 }, { assetId, delta: -1 }]);
    assert.equal(assertBinRouteCapacity([{ slotCapacity: 1, capacityLbs: Math.max(...weights), movements }]), true);
    assert.throws(() => assertBinRouteCapacity([{ slotCapacity: 1, capacityLbs: Math.max(...weights) - 1, movements }]),
      error => error.code === "MBT_BIN_CAPACITY_EXCEEDED");
  }), { seed: 9272027, numRuns: 1000 });
});
test("property: ordinary edits preserve BIN work while any stop mutation is rejected", () => {
  fc.assert(fc.property(groups, fc.string(), (visits, name) => {
    const plan = { trucks: [{ id: "1", loads: [{ id: "bin", driverLogin: "driver", plannedStartMinute: 400,
      plannedFinishMinute: 500, stops: visits.flat() }] }, { id: "2", loads: [] }], orders: [] };
    const next = structuredClone(plan); next.trucks[1].loads.push({ id: "ordinary", name });
    assert.equal(assertOrdinaryDispatchPreservesBins(plan, next), true);
    next.trucks[0].loads[0].stops[0].mbt.sequence++;
    assert.throws(() => assertOrdinaryDispatchPreservesBins(plan, next), error => error.code === "MBT_BIN_PLANNING_REQUIRED");
  }), { seed: 9272028, numRuns: 1000 });
});

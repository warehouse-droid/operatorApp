import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDispatchPlanDelta,
  buildDispatchPlanDelta
} from "../../../src/dispatch-planner-optimization.js";

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

test("DPO-03 property: arbitrary keyed board edits round-trip and reapply idempotently", () => {
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = seededRandom(seed);
    const beforeOrderIds = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, index) => `SO-${seed}-${index}`);
    const afterOrderIds = shuffled(beforeOrderIds.filter(() => random() > 0.25), random);
    if (random() > 0.3) {afterOrderIds.push(`CUSTOM-${seed}`);}
    const beforeTruckIds = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index) => `T-${seed}-${index}`);
    const afterTruckIds = shuffled(beforeTruckIds.filter(() => random() > 0.15), random);
    if (!afterTruckIds.length || random() > 0.6) {afterTruckIds.push(`T-${seed}-new`);}
    const before = {
      planDate: "2026-08-20",
      orders: beforeOrderIds.map((id, index) => ({ id, type: "SO", pallets: index + 1 })),
      trucks: beforeTruckIds.map((id, index) => ({ id, plate: `P-${index}`, loads: [] })),
      summary: { seed, phase: "before" }
    };
    const after = {
      ...before,
      orders: afterOrderIds.map((id, index) => ({ id, type: id.startsWith("CUSTOM") ? "CUSTOM" : "SO", pallets: index + seed })),
      trucks: afterTruckIds.map((id, index) => ({ id, plate: `A-${index}`, loads: [{ id: `${id}-L`, stops: [] }] })),
      summary: { seed, phase: "after", order: afterOrderIds }
    };
    const delta = buildDispatchPlanDelta(before, after);
    const applied = applyDispatchPlanDelta(before, delta);
    assert.deepEqual(applied, after, `seed ${seed} round-trip`);
    assert.deepEqual(applyDispatchPlanDelta(applied, delta), after, `seed ${seed} idempotency`);
    assert.deepEqual(applyDispatchPlanDelta(before, { orders: [] }), before,
      `seed ${seed} one-sided keyed delta preserves both keyed boards`);
  }
});

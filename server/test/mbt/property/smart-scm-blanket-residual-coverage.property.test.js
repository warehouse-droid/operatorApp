import assert from "node:assert/strict";
import test from "node:test";

import { smartScmAllocateBlanketCoverage } from "../../../src/smart-scm-blanket-coverage.js";

const LOCATIONS = [1, 15, 26, 28];
const YARDS = new Map([[1, "3445"], [15, "12441"], [26, "150"], [28, "2967"]]);
const LEVELS = ["normal", "urgent", "super_urgent", "ultimate_urgent"];

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function state(itemId, locationId, requiredPallets, urgencyLevel, urgencyScore, temporarilyExcluded) {
  return {
    key: `${itemId}:${locationId}`,
    requiredPallets,
    urgencyLevel,
    urgencyScore,
    urgent: urgencyLevel !== "normal",
    policy: {
      item_id: itemId,
      location_id: locationId,
      yard_code: YARDS.get(locationId),
      to_plt: 10,
      temporarily_excluded: temporarilyExcluded
    }
  };
}

function poolRow(itemId, index, remainingPallets, toPlt = 10) {
  return {
    source_po_id: 9000 + index,
    source_po_ref: `PO-${9000 + index}`,
    source_line_id: 10000 + index,
    item_id: itemId,
    to_plt: toPlt,
    remaining_pallets: remainingPallets,
    remaining_sales_qty: remainingPallets * toPlt,
    trandate: `2026-0${index + 1}-01`
  };
}

function compact(result) {
  return result.states
    .map((entry) => ({
      locationId: entry.policy.location_id,
      covered: entry.blanketCoveragePallets,
      residual: entry.residualRequiredPallets,
      refs: entry.blanketSourcePoRefs
    }))
    .sort((left, right) => left.locationId - right.locationId);
}

test("Blanket allocation conserves arbitrary whole pools and is input-order independent", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const next = random(seed);
    const itemId = 880000 + seed;
    const states = LOCATIONS.map((locationId) => {
      const whole = Math.floor(next() * 21);
      const fraction = [0, 0.25, 0.5, 0.75][Math.floor(next() * 4)];
      const urgencyLevel = LEVELS[Math.floor(next() * LEVELS.length)];
      return state(itemId, locationId, whole + fraction, urgencyLevel, Math.floor(next() * 101), next() < 0.2);
    });
    const poolRows = [0, 1, 2].map((index) => poolRow(itemId, index, Math.floor(next() * 16)));
    poolRows.push(poolRow(itemId, 8, 50, 12));
    const originalStates = structuredClone(states);
    const originalPool = structuredClone(poolRows);

    const result = smartScmAllocateBlanketCoverage({ states, poolRows });
    const reordered = smartScmAllocateBlanketCoverage({
      states: [...states].reverse(),
      poolRows: [...poolRows].reverse()
    });

    assert.deepEqual(states, originalStates, `seed ${seed}: input states must not mutate`);
    assert.deepEqual(poolRows, originalPool, `seed ${seed}: input pool must not mutate`);
    assert.deepEqual(compact(result), compact(reordered), `seed ${seed}: allocation must be deterministic`);

    const eligibleWholeDemand = states
      .filter((entry) => entry.policy.temporarily_excluded !== true)
      .reduce((sum, entry) => sum + Math.floor(entry.requiredPallets), 0);
    const compatiblePool = poolRows
      .filter((row) => row.to_plt === 10)
      .reduce((sum, row) => sum + Math.floor(row.remaining_pallets), 0);
    const totalCovered = result.states.reduce((sum, entry) => sum + entry.blanketCoveragePallets, 0);
    assert.equal(totalCovered, Math.min(eligibleWholeDemand, compatiblePool), `seed ${seed}: both conservation bounds`);
    assert.equal(result.allocations.reduce((sum, entry) => sum + entry.pallets, 0), totalCovered,
      `seed ${seed}: allocation ledger conservation`);

    for (const entry of result.states) {
      assert.equal(Number.isInteger(entry.blanketCoveragePallets), true, `seed ${seed}: whole Blanket pallets`);
      assert.equal(entry.residualRequiredPallets, entry.requiredPallets - entry.blanketCoveragePallets,
        `seed ${seed}: exact residual subtraction`);
      assert.ok(entry.blanketCoveragePallets <= Math.floor(entry.requiredPallets),
        `seed ${seed}: no item-yard overcoverage`);
      if (entry.policy.temporarily_excluded) {
        assert.equal(entry.blanketCoveragePallets, 0);
      }
    }

    const usedBySource = new Map();
    for (const allocation of result.allocations) {
      usedBySource.set(allocation.sourceLineId,
        (usedBySource.get(allocation.sourceLineId) || 0) + allocation.pallets);
    }
    for (const row of poolRows.filter((entry) => entry.to_plt === 10)) {
      assert.ok((usedBySource.get(row.source_line_id) || 0) <= row.remaining_pallets,
        `seed ${seed}: source ${row.source_line_id} cannot be overdrawn`);
    }
  }
});

test("invalid, mismatched, and sub-pallet source quantities cannot create coverage", () => {
  const itemId = 777001;
  const result = smartScmAllocateBlanketCoverage({
    states: [state(itemId, 1, 3.75, "urgent", 100, false)],
    poolRows: [
      poolRow(itemId, 0, 0.99),
      poolRow(itemId, 1, -4),
      poolRow(itemId, 2, Number.NaN),
      poolRow(itemId, 3, 20, 11),
      poolRow(itemId + 1, 4, 20)
    ]
  });

  assert.equal(result.states[0].blanketCoveragePallets, 0);
  assert.equal(result.states[0].residualRequiredPallets, 3.75);
  assert.deepEqual(result.allocations, []);
});

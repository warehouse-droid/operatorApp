import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  applyDispatchPlanCommand,
  buildCompactDispatchSnapshot,
  createDispatchCommandReceiptStore,
  digestDispatchPlan
} from "../../../src/dispatch-planner-performance.js";

const SEED = 20_260_806;
const RUNS = 300;

function sourcePlan(orderRefs) {
  return {
    id: "property-plan",
    planDate: "2026-08-06",
    revision: 1,
    orders: orderRefs.map((id) => ({ id, type: "SO", address: `${id} address`, items: [] })),
    trucks: [{ id: "truck-1", loads: [{
      id: "load-1",
      stops: orderRefs.flatMap((id) => [{ id: `pick-${id}`, type: "pick", orderId: id }, { id: `drop-${id}`, type: "drop", orderId: id }])
    }] }]
  };
}

test("DP-04 property: adding arbitrary unassigned source orders never changes compact data or its digest", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.stringMatching(/^POOL-[A-Z0-9]{1,8}$/), { minLength: 0, maxLength: 100 }),
    (poolRefs) => {
      const base = sourcePlan(["ASSIGNED"]);
      const noisy = structuredClone(base);
      noisy.orders.push(...poolRefs.map((id) => ({ id, type: "SO", address: id, items: [] })));

      assert.deepEqual(buildCompactDispatchSnapshot(noisy), buildCompactDispatchSnapshot(base));
      assert.equal(digestDispatchPlan(noisy), digestDispatchPlan(base));
    }
  ), { seed: SEED, numRuns: RUNS });
});

test("DP-06 property: every exact retry is observationally equivalent to the first command", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.stringMatching(/^[A-Z]{1,6}$/), { minLength: 1, maxLength: 20 }),
    (refs) => {
      const initial = sourcePlan(refs);
      const target = refs[0];
      const store = createDispatchCommandReceiptStore();
      const command = {
        commandId: `remove-${target}`,
        baseRevision: 1,
        type: "remove_order",
        payload: { orderRef: target }
      };
      const first = applyDispatchPlanCommand({ plan: initial, command, receiptStore: store });
      const retry = applyDispatchPlanCommand({ plan: first.plan, command, receiptStore: store });

      assert.equal(first.replay, false);
      assert.equal(retry.replay, true);
      assert.equal(first.revision, 2);
      assert.equal(retry.revision, 2);
      assert.deepEqual(retry.plan, first.plan);
      assert.equal(first.plan.trucks[0].loads[0].stops.some((stop) => stop.orderId === target), false);
    }
  ), { seed: SEED + 1, numRuns: RUNS });
});

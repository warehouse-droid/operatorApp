import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { evaluateExecutedPrefixPolicy } from "../../../src/dispatch-planner-performance.js";

function generatedPlan(loadCount, boundary) {
  return {
    id: "property-plan",
    trucks: [{
      id: "property-truck",
      plate: "PROPERTY",
      driverLogin: "property-driver",
      loads: Array.from({ length: loadCount }, (_, index) => ({
        id: `load-${index}`,
        name: `Load ${index}`,
        driverLogin: "property-driver",
        driverSequence: index,
        plannedStartMinute: 300 + index * 60,
        plannedFinishMinute: 350 + index * 60,
        stops: [{ id: `stop-${index}`, type: "drop", orderId: `SO-${index}`, location: `Address ${index}` }],
        orders: [{ id: `SO-${index}` }]
      }))
    }],
    boundary
  };
}

test("every generated load at or before execution is immutable and every later load remains editable", () => {
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 20 }),
    fc.integer({ min: 0, max: 19 }),
    fc.integer({ min: 0, max: 19 }),
    (loadCount, rawBoundary, rawMutation) => {
      const boundary = rawBoundary % loadCount;
      const mutation = rawMutation % loadCount;
      const previousPlan = generatedPlan(loadCount, boundary);
      const nextPlan = structuredClone(previousPlan);
      nextPlan.trucks[0].loads[mutation].name += " changed";
      const activity = [{
        status: "complete",
        driver_login: "property-driver",
        load_id: `load-${boundary}`,
        stop_id: `stop-${boundary}`,
        stop_type: "dropoff",
        order_refs: [`SO-${boundary}`]
      }];
      const result = evaluateExecutedPrefixPolicy({ previousPlan, nextPlan, activity });
      assert.equal(result.allowed, mutation > boundary);
    }
  ), { numRuns: 500 });
});

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { dispatchFleetAssignmentStatusConflicts } from "../../../src/dispatch-fleet-status.js";

test("S3: activation state cannot prevent planning for an existing driver", () => {
  fc.assert(fc.property(fc.boolean(), fc.integer({ min: 1, max: 500 }), (active, count) => {
    const conflicts = dispatchFleetAssignmentStatusConflicts({ trucks: [{ id: "1", plate: "TEST",
      loads: [{ id: "load", driverLogin: "driver", orders: Array.from({ length: count }, (_, i) => `SO-${i}`) }] }] }, {
      drivers: [{ login: "driver", name: "Test driver", active }], trucks: [{ id: "1", plate: "TEST", active: true }]
    });
    assert.deepEqual(conflicts, []);
  }), { seed: 20261029, numRuns: 100 });
});

test("S3: unknown drivers and inactive trucks still fail planning validation", () => {
  const conflicts = dispatchFleetAssignmentStatusConflicts({ trucks: [{ id: "1", plate: "TEST",
    loads: [{ id: "load", driverLogin: "unknown", orders: ["SO-1"] }] }] }, {
    drivers: [], trucks: [{ id: "1", plate: "TEST", active: false }]
  });
  assert.deepEqual(conflicts.map(conflict => conflict.code), ["DISPATCH_DRIVER_DISABLED", "DISPATCH_TRUCK_DISABLED"]);
});

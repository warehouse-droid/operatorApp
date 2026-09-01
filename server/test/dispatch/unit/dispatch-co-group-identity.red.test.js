import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeDispatchCoGroupIdentities,
  dispatchCoGroupIdentityMappings,
  isTerminalDispatchCoStatus
} from "../../../src/dispatch-co-group-identity.js";

function legacyCoGroupPlan() {
  const oldRef = "GOA-7510-7512";
  return {
    id: "263",
    planDate: "2026-08-30",
    orders: [{
      id: oldRef,
      orderId: oldRef,
      type: "CO",
      childOrders: ["CO-SOA07510", "CO-SOA07512"],
      childOrderDetails: [
        { id: "CO-SOA07510", type: "CO" },
        { id: "CO-SOA07512", type: "CO" }
      ]
    }],
    trucks: [{
      loads: [{
        id: "stable-load",
        stops: [{
          id: `stable-stop-${oldRef}-driver-evidence`,
          type: "drop",
          orderId: oldRef,
          orderRefs: [oldRef]
        }]
      }]
    }]
  };
}

test("individual CO grouping and grouped-source CO creation converge on CO-GOA-7510-7512", () => {
  const input = legacyCoGroupPlan();
  assert.deepEqual(dispatchCoGroupIdentityMappings(input), [{
    oldRef: "GOA-7510-7512",
    newRef: "CO-GOA-7510-7512"
  }]);

  const canonical = canonicalizeDispatchCoGroupIdentities(input);
  assert.equal(canonical.orders[0].id, "CO-GOA-7510-7512");
  assert.equal(canonical.orders[0].orderId, "CO-GOA-7510-7512");
  assert.equal(canonical.trucks[0].loads[0].stops[0].orderId, "CO-GOA-7510-7512");
  assert.deepEqual(canonical.trucks[0].loads[0].stops[0].orderRefs, ["CO-GOA-7510-7512"]);
  assert.equal(
    canonical.trucks[0].loads[0].stops[0].id,
    "stable-stop-GOA-7510-7512-driver-evidence",
    "embedded immutable stop IDs must not be rewritten"
  );
  assert.deepEqual(canonical.orders[0].childOrders, ["CO-SOA07510", "CO-SOA07512"]);
  assert.notEqual(canonical, input, "canonicalization must not mutate a caller-owned snapshot");
  assert.equal(input.orders[0].id, "GOA-7510-7512");

  assert.deepEqual(canonicalizeDispatchCoGroupIdentities(canonical), canonical,
    "canonicalization must be idempotent");
});

test("a mixed CO and non-CO group is rejected fail-closed", () => {
  const mixed = legacyCoGroupPlan();
  mixed.orders[0].childOrders = ["CO-SOA07510", "SOA07512"];
  mixed.orders[0].childOrderDetails[1] = { id: "SOA07512", type: "SO" };

  assert.throws(
    () => canonicalizeDispatchCoGroupIdentities(mixed),
    (error) => error?.code === "DISPATCH_CO_GROUP_MIXED_TYPES" && error?.status === 409
  );
  assert.equal(mixed.orders[0].id, "GOA-7510-7512",
    "failed canonicalization must not partially mutate the input"
  );
});

test("an existing canonical target collision is rejected fail-closed", () => {
  const collision = legacyCoGroupPlan();
  collision.orders.push({ id: "CO-GOA-7510-7512", type: "CO", sourceOrderId: "OTHER" });

  assert.throws(
    () => canonicalizeDispatchCoGroupIdentities(collision),
    (error) => error?.code === "DISPATCH_CO_GROUP_IDENTITY_CONFLICT" && error?.status === 409
  );
  assert.equal(collision.orders[0].id, "GOA-7510-7512");
});

test("only completed and received CO lifecycle states satisfy a hidden transit prerequisite", () => {
  assert.equal(isTerminalDispatchCoStatus("completed"), true);
  assert.equal(isTerminalDispatchCoStatus("Completed"), true);
  assert.equal(isTerminalDispatchCoStatus("received"), true);
  for (const status of ["", "missing", "cancelled", "pending_load", "planned", "loaded"] ) {
    assert.equal(isTerminalDispatchCoStatus(status), false, `${status || "blank"} must not bypass sequencing`);
  }
});

test("canonicalization tolerates compact and partially hydrated plan shapes", () => {
  const timestamp = new Date("2040-01-02T03:04:05.000Z");
  const compact = {
    orders: [
      null,
      [],
      {},
      {
        orderId: "GOA-10-20",
        type: "CO",
        childOrderDetails: [
          { orderRef: "CO-SOA10", type: "CO" },
          { tranid: "CO-SOA20", type: "CO" }
        ]
      }
    ],
    trucks: [
      {},
      { loads: [{}, { orders: ["GOA-10-20", null] }] }
    ],
    generatedAt: timestamp
  };

  const canonical = canonicalizeDispatchCoGroupIdentities(compact);
  assert.equal(canonical.orders[3].orderId, "CO-GOA-10-20");
  assert.equal(canonical.generatedAt.toISOString(), timestamp.toISOString());
  assert.equal(canonical.trucks[1].loads[1].orders[0], "CO-GOA-10-20");
});

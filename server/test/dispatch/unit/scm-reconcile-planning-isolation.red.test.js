import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { changedPlacedDispatchScmAssignmentRefs } from "../../../src/dispatch-scm-placement.js";

function board() {
  return {
    orders: [
      {
        id: "TO-REVIEWED",
        type: "TO",
        sourceId: 10,
        pickup: "Source Yard",
        dropoff: "Destination Yard",
        weight: 100,
        reconciliationBlocked: true
      },
      { id: "SO-UNRELATED", type: "SO", weight: 20 }
    ],
    trucks: [{
      id: "TRUCK-1",
      loads: [{
        id: "LOAD-1",
        stops: [
          { id: "to-drop", orderId: "TO-REVIEWED", type: "drop", location: "Destination Yard" },
          { id: "so-drop", orderId: "SO-UNRELATED", type: "drop", location: "Customer" }
        ]
      }]
    }]
  };
}

test("RAR-P1: metadata refresh and unrelated work do not revalidate an unchanged reviewed TO", () => {
  const before = board();
  const after = structuredClone(before);
  after.orders[0] = {
    ...after.orders[0],
    weight: 88,
    pickup: "Canonical Source Yard",
    calculatedStatus: "Reconcile Review",
    updatedAt: "2026-08-29T02:00:00.000Z"
  };
  after.trucks[0].loads[0].stops = after.trucks[0].loads[0].stops
    .filter((stop) => stop.orderId !== "SO-UNRELATED");

  assert.deepEqual(changedPlacedDispatchScmAssignmentRefs(before, after), []);
});
test("RAR-P2: adding or moving the reviewed TO is still scoped into the edit guard", () => {
  const before = board();
  const moved = structuredClone(before);
  moved.trucks[0].loads.push({
    id: "LOAD-2",
    stops: [moved.trucks[0].loads[0].stops.shift()]
  });
  assert.deepEqual(
    changedPlacedDispatchScmAssignmentRefs(before, moved),
    ["TO-REVIEWED"]
  );

  const unplaced = board();
  unplaced.trucks[0].loads[0].stops = unplaced.trucks[0].loads[0].stops
    .filter((stop) => stop.orderId !== "TO-REVIEWED");
  assert.deepEqual(
    changedPlacedDispatchScmAssignmentRefs(unplaced, board()),
    ["TO-REVIEWED"]
  );
});

test("RAR-P3: every Dispatch save editability guard uses assignment deltas, not catalog metadata", async () => {
  const source = await readFile(new URL("../../../src/server.js", import.meta.url), "utf8");
  assert.equal(
    source.includes("function dispatchScmPlacementMap"),
    false,
    "The broad SCM catalog/metadata diff must not decide which reviewed order blocks a save."
  );
  assert.equal(
    source.includes("function changedDispatchScmRefs"),
    false,
    "The legacy broad reviewed-order diff must be removed."
  );
  const assignmentScopedChanges = source.match(
    /const changedScmRefs = changedPlacedDispatchScmAssignmentRefs\(/g
  ) || [];
  assert.ok(
    assignmentScopedChanges.length >= 4,
    "All current save/restore paths must derive reconciliation guards from actual placed assignment changes."
  );
});

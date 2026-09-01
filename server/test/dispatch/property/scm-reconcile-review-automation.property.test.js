import assert from "node:assert/strict";
import test from "node:test";

import { changedPlacedDispatchScmAssignmentRefs } from "../../../src/dispatch-scm-placement.js";
import {
  scmActiveSplitExceedsSource,
  scmPlannedQuantityChangeRequiresReview,
  scmScheduleHasOperationalPlanningEvidence
} from "../../../src/scm-reconcile-review-policy.js";

function generator(seed = 0x5c0a2026) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("RAR-PR1: planning evidence classification matches the truth table over 1,000 cases", () => {
  const random = generator();
  const statuses = [
    "", "Queued", "Hold", "Reconcile Review", "Urgent",
    "Planned", "Partially Done", "In Transit", "Completed"
  ];
  const operational = new Set(["Planned", "Partially Done", "In Transit", "Completed"]);
  for (let index = 0; index < 1_000; index += 1) {
    const sourceDispatchPlanned = random() < 0.2;
    const scheduleId = random() < 0.8 ? index + 1 : 0;
    const scheduleStatus = statuses[Math.floor(random() * statuses.length)];
    const scheduleEtaDate = random() < 0.15 ? "2026-08-29" : null;
    const scheduleDispatchPlanId = random() < 0.15 ? index + 11 : 0;
    const expected = sourceDispatchPlanned || Boolean(
      scheduleId
      && (
        operational.has(scheduleStatus)
        || scheduleEtaDate
        || scheduleDispatchPlanId
      )
    );
    assert.equal(scmScheduleHasOperationalPlanningEvidence({
      sourceDispatchPlanned,
      scheduleId,
      scheduleStatus,
      scheduleEtaDate,
      scheduleDispatchPlanId
    }), expected, `case ${index}`);
  }
});

test("RAR-PR2: quantity automation never accepts an increase or split overflow", () => {
  const random = generator(0xa110ca7e);
  for (let index = 0; index < 1_000; index += 1) {
    const local = Number((random() * 10_000).toFixed(4));
    const authoritative = Number((random() * 10_000).toFixed(4));
    const split = Number((random() * 10_000).toFixed(4));
    assert.equal(scmPlannedQuantityChangeRequiresReview({
      orderKind: "TO",
      localOrderedQuantity: local,
      authoritativeOrderedQuantity: authoritative
    }), authoritative > local + 0.000001, `TO case ${index}`);
    assert.equal(scmActiveSplitExceedsSource({
      activeSplitQuantity: split,
      authoritativeSourceQuantity: authoritative
    }), split > authoritative + 0.000001, `split case ${index}`);
  }
});

test("RAR-PR3: unrelated catalog refreshes never become reviewed-order placement changes", () => {
  const random = generator(0xb10c2026);
  for (let index = 0; index < 500; index += 1) {
    const before = {
      orders: [
        { id: "TO-REVIEWED", type: "TO", weight: 100, pickup: "A", dropoff: "B" },
        { id: `SO-${index}`, type: "SO" }
      ],
      trucks: [{
        id: "TRUCK-1",
        loads: [{
          id: "LOAD-1",
          stops: [
            { id: "to-drop", orderId: "TO-REVIEWED", type: "drop", location: "B" },
            { id: "so-drop", orderId: `SO-${index}`, type: "drop", location: "Customer" }
          ]
        }]
      }]
    };
    const after = structuredClone(before);
    after.orders[0] = {
      ...after.orders[0],
      weight: Number((random() * 1_000).toFixed(2)),
      pickup: `A-${index}`,
      updatedAt: new Date(1_787_966_400_000 + index * 1_000).toISOString()
    };
    if (random() < 0.5) {
      after.trucks[0].loads[0].stops.pop();
    }
    assert.deepEqual(
      changedPlacedDispatchScmAssignmentRefs(before, after),
      [],
      `unrelated case ${index}`
    );
  }
});

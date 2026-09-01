import assert from "node:assert/strict";
import test from "node:test";

import {
  scmActiveSplitExceedsSource,
  scmPlannedQuantityChangeRequiresReview,
  scmScheduleHasOperationalPlanningEvidence
} from "../../../src/scm-reconcile-review-policy.js";

test("RAR-U1: only durable operational facts make a schedule planned", () => {
  assert.equal(scmScheduleHasOperationalPlanningEvidence(), false);
  assert.equal(scmScheduleHasOperationalPlanningEvidence({
    scheduleId: 1,
    scheduleStatus: "Queued"
  }), false);
  assert.equal(scmScheduleHasOperationalPlanningEvidence({
    scheduleId: 1,
    scheduleStatus: "Reconcile Review"
  }), false);
  assert.equal(scmScheduleHasOperationalPlanningEvidence({
    sourceDispatchPlanned: true
  }), true);
  for (const scheduleStatus of ["Planned", "Partially Done", "In Transit", "Completed"]) {
    assert.equal(scmScheduleHasOperationalPlanningEvidence({
      scheduleId: 1,
      scheduleStatus
    }), true, scheduleStatus);
  }
  assert.equal(scmScheduleHasOperationalPlanningEvidence({
    scheduleId: 1,
    scheduleEtaDate: "2026-08-29"
  }), true);
  assert.equal(scmScheduleHasOperationalPlanningEvidence({
    scheduleId: 1,
    scheduleDispatchPlanId: 99
  }), true);
  assert.equal(scmScheduleHasOperationalPlanningEvidence({
    scheduleId: 1,
    scheduleStatus: null,
    scheduleEtaDate: "not-a-date",
    scheduleDispatchPlanId: "not-an-id"
  }), false);
});

test("RAR-U2: exact TO decreases auto-apply while increases and PO plan changes remain reviewable", () => {
  assert.equal(scmPlannedQuantityChangeRequiresReview({
    orderKind: "TO",
    localOrderedQuantity: 10,
    authoritativeOrderedQuantity: 8
  }), false);
  assert.equal(scmPlannedQuantityChangeRequiresReview({
    orderKind: "TO",
    localOrderedQuantity: 10,
    authoritativeOrderedQuantity: 10
  }), false);
  assert.equal(scmPlannedQuantityChangeRequiresReview({
    orderKind: "TO",
    localOrderedQuantity: 10,
    authoritativeOrderedQuantity: 11
  }), true);
  assert.equal(scmPlannedQuantityChangeRequiresReview({
    orderKind: "PO",
    localOrderedQuantity: 10,
    authoritativeOrderedQuantity: 8
  }), true);
  assert.equal(scmPlannedQuantityChangeRequiresReview(), false);
  assert.equal(scmPlannedQuantityChangeRequiresReview({
    orderKind: null,
    localOrderedQuantity: "not-a-quantity",
    authoritativeOrderedQuantity: -1
  }), false);
});

test("RAR-U3: active split capacity may equal but never exceed the amended source", () => {
  assert.equal(scmActiveSplitExceedsSource({
    activeSplitQuantity: 6,
    authoritativeSourceQuantity: 6
  }), false);
  assert.equal(scmActiveSplitExceedsSource({
    activeSplitQuantity: 6.000002,
    authoritativeSourceQuantity: 6
  }), true);
  assert.equal(scmActiveSplitExceedsSource({
    activeSplitQuantity: "1,200",
    authoritativeSourceQuantity: 1199
  }), true);
  assert.equal(scmActiveSplitExceedsSource(), false);
  assert.equal(scmActiveSplitExceedsSource({
    activeSplitQuantity: null,
    authoritativeSourceQuantity: null
  }), false);
});

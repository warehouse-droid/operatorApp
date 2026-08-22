import assert from "node:assert/strict";
import test from "node:test";

import {
  driverRouteReadiness,
  evaluateDependencyMutationBlockers,
  normalizeDependencyMutationAction
} from "../../../src/scm-dependency-management-policy.js";

test("shared blocker returns stable codes in safety priority order", () => {
  const blockers = evaluateDependencyMutationBlockers({
    closedOrders: ["SO-CLOSED"],
    targetChanged: true,
    planChanged: true,
    editLease: { operatorName: "Planner A", expiresAt: "2026-08-19T12:01:00.000Z" },
    operatorActivity: { refs: ["SO-A"] },
    receivingActivity: { refs: ["PO-A"] },
    dependencyExecution: { dependencyIds: [41] },
    driverActivity: { jobIds: ["job-1"] },
    offlineEvidence: { eventIds: ["event-1"] },
    planTerminal: "completed",
    sequenceConflicts: ["TO-A must finish first"]
  });
  assert.deepEqual(blockers.map((blocker) => blocker.code), [
    "ORDER_CLOSED",
    "DISPATCH_TARGET_CHANGED",
    "DISPATCH_PLAN_CHANGED",
    "DISPATCH_EDIT_LEASE_HELD",
    "OPERATOR_ACTIVITY_STARTED",
    "SCM_RECEIVING_ACTIVITY_STARTED",
    "DEPENDENCY_EXECUTION_STARTED",
    "DRIVER_ACTIVITY_STARTED",
    "DRIVER_OFFLINE_EVIDENCE_PENDING",
    "DISPATCH_PLAN_TERMINAL",
    "DISPATCH_ORDER_DEPENDENCY_CONFLICT"
  ]);
  assert.ok(blockers.every((blocker) => blocker.message && blocker.details));
});

test("shared blocker returns no false positive for an untouched draft target", () => {
  assert.deepEqual(evaluateDependencyMutationBlockers({}), []);
});

test("same-target link normalizes to extension but cross-target and mode changes stay blocked", () => {
  assert.deepEqual(normalizeDependencyMutationAction({
    action: "link_to",
    targetRef: "SOB118134",
    mode: "yard_replenishment",
    existing: {
      id: 200,
      targetRef: "SOB118134",
      mode: "yard_replenishment"
    }
  }), {
    action: "link_to",
    effectiveAction: "extend_to",
    dependencyId: 200
  });
  assert.throws(
    () => normalizeDependencyMutationAction({
      action: "link_to",
      targetRef: "SOB118999",
      mode: "yard_replenishment",
      existing: { id: 200, targetRef: "SOB118134", mode: "yard_replenishment" }
    }),
    (error) => error?.status === 409 && error?.code === "TO_ALREADY_LINKED_ELSEWHERE"
  );
  assert.throws(
    () => normalizeDependencyMutationAction({
      action: "link_to",
      targetRef: "SOB118134",
      mode: "direct_to_customer",
      existing: { id: 200, targetRef: "SOB118134", mode: "yard_replenishment" }
    }),
    (error) => error?.status === 409 && error?.code === "DEPENDENCY_MODE_MISMATCH"
  );
});

test("confirmed issued route requires every visible synchronized device to acknowledge", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const baseDevice = {
    driverLogin: "cheng",
    deviceId: "device-a",
    manifestId: "00000000-0000-4000-8000-000000000001",
    visible: true,
    online: true,
    syncState: "clean",
    pendingEventCount: 0,
    pendingPhotoCount: 0,
    activeJobId: "",
    heartbeatAt: "2026-08-19T11:59:55.000Z",
    readyAt: "2026-08-19T11:59:56.000Z",
    readyExpiresAt: "2026-08-19T12:01:56.000Z"
  };
  assert.deepEqual(driverRouteReadiness({ planStatus: "draft", devices: [baseDevice], now }), {
    required: false,
    ready: true,
    blockers: []
  });
  assert.equal(driverRouteReadiness({ planStatus: "confirmed", devices: [], now }).ready, true);
  assert.equal(driverRouteReadiness({ planStatus: "confirmed", devices: [baseDevice], now }).ready, true);

  const screenOff = driverRouteReadiness({
    planStatus: "confirmed",
    devices: [{ ...baseDevice, visible: false, heartbeatAt: "2026-08-19T11:58:00.000Z" }],
    now
  });
  assert.equal(screenOff.ready, false);
  assert.equal(screenOff.pendingRequestRequired, true);
  assert.equal(screenOff.blockers[0].code, "DRIVER_ROUTE_OFFLINE");

  const unsynced = driverRouteReadiness({
    planStatus: "confirmed",
    devices: [{ ...baseDevice, syncState: "pending", pendingEventCount: 1 }],
    now
  });
  assert.equal(unsynced.ready, false);
  assert.equal(unsynced.blockers[0].code, "DRIVER_OFFLINE_EVIDENCE_PENDING");

  const oneOfTwoMissing = driverRouteReadiness({
    planStatus: "confirmed",
    devices: [baseDevice, { ...baseDevice, deviceId: "device-b", readyAt: "", readyExpiresAt: "" }],
    now
  });
  assert.equal(oneOfTwoMissing.ready, false);
  assert.equal(oneOfTwoMissing.blockers[0].code, "DRIVER_ROUTE_UPDATE_REQUIRED");
});

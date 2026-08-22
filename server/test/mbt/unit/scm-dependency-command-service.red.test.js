import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { executeScmDependencyCommand } from "../../../src/scm-dependency-command-service.js";

function command() {
  return {
    requestId: crypto.randomUUID(),
    payloadHash: "a".repeat(64),
    action: "link_to",
    targetRef: "SOB118191",
    planId: 91,
    planDate: "2026-08-19",
    expectedPlanRevision: 8,
    expectedPlanDigest: "b".repeat(64),
    payload: { transferOrderRef: "TOB00937", allocations: [] }
  };
}

function transactionalPorts({ failPlanSave = false, existingReceipt = null, routeReady = true } = {}) {
  const state = {
    relationships: 0,
    planRevision: 8,
    operatorMaterializations: 0,
    supersededManifests: 0,
    pendingRequests: 0,
    receipt: existingReceipt,
    calls: []
  };
  const ports = {
    getReceipt: async () => state.receipt,
    withTransaction: async (callback) => {
      const before = structuredClone(state);
      state.calls.push("transaction.begin");
      try {
        const result = await callback();
        state.calls.push("transaction.commit");
        return result;
      } catch (error) {
        Object.assign(state, before);
        state.calls.push("transaction.rollback");
        throw error;
      }
    },
    preview: async () => {
      state.calls.push("preview.locked");
      return {
        allowed: routeReady,
        blockers: routeReady ? [] : [{ code: "DRIVER_ROUTE_OFFLINE", message: "Driver screen is off.", details: {} }],
        routeReadiness: routeReady
          ? { required: true, ready: true, blockers: [] }
          : { required: true, ready: false, pendingRequestRequired: true, blockers: [{ code: "DRIVER_ROUTE_OFFLINE" }] },
        affectedPlan: { id: 91, revision: state.planRevision, status: "confirmed" },
        affectedDriverDevices: [{ driverLogin: "cheng", deviceId: "iphone", manifestId: crypto.randomUUID() }]
      };
    },
    createPendingRequest: async () => {
      state.calls.push("pending.create");
      state.pendingRequests += 1;
      return { status: "waiting_driver" };
    },
    reserveReceipt: async () => {
      state.calls.push("receipt.reserve");
      state.receipt = { status: "executing" };
      return { created: true, receipt: state.receipt };
    },
    mutateRelationship: async () => {
      state.calls.push("relationship.mutate");
      state.relationships += 1;
      return { dependencyId: 41, effectiveAction: "link_to" };
    },
    refreshPlan: async () => {
      state.calls.push("plan.save");
      if (failPlanSave) {throw Object.assign(new Error("injected plan save failure"), { code: "INJECTED_PLAN_SAVE" });}
      state.planRevision += 1;
      return { id: 91, revision: state.planRevision, status: "confirmed" };
    },
    validatePlan: async () => {
      state.calls.push("plan.validate");
      return [];
    },
    materializeOperator: async () => {
      state.calls.push("operator.materialize");
      state.operatorMaterializations += 1;
      return { updated: 1 };
    },
    supersedeDriverArtifacts: async () => {
      state.calls.push("driver.supersede");
      state.supersededManifests += 1;
      return { manifestIds: ["old-manifest"] };
    },
    completeReceipt: async (_requestId, result) => {
      state.calls.push("receipt.complete");
      state.receipt = { status: "succeeded", result };
      return state.receipt;
    }
  };
  return { state, ports };
}

test("relationship, refreshed snapshot, Operator materialization, and manifest fence commit atomically", async () => {
  const { state, ports } = transactionalPorts();
  const result = await executeScmDependencyCommand(command(), { id: "scm-user", surface: "scm" }, ports);
  assert.equal(result.status, "applied");
  assert.equal(state.relationships, 1);
  assert.equal(state.planRevision, 9);
  assert.equal(state.operatorMaterializations, 1);
  assert.equal(state.supersededManifests, 1);
  assert.deepEqual(state.calls, [
    "transaction.begin",
    "preview.locked",
    "receipt.reserve",
    "relationship.mutate",
    "plan.save",
    "plan.validate",
    "operator.materialize",
    "driver.supersede",
    "receipt.complete",
    "transaction.commit"
  ]);
});

test("an injected snapshot failure rolls the relationship and all materialization back", async () => {
  const { state, ports } = transactionalPorts({ failPlanSave: true });
  await assert.rejects(
    executeScmDependencyCommand(command(), { id: "scm-user", surface: "scm" }, ports),
    (error) => error?.code === "INJECTED_PLAN_SAVE"
  );
  assert.equal(state.relationships, 0);
  assert.equal(state.planRevision, 8);
  assert.equal(state.operatorMaterializations, 0);
  assert.equal(state.supersededManifests, 0);
  assert.equal(state.receipt, null);
  assert.equal(state.calls.at(-1), "transaction.rollback");
});

test("screen-off Driver creates only a pending request and never mutates the route", async () => {
  const { state, ports } = transactionalPorts({ routeReady: false });
  const result = await executeScmDependencyCommand(command(), { id: "scm-user", surface: "scm" }, ports);
  assert.equal(result.status, "waiting_driver");
  assert.equal(state.pendingRequests, 1);
  assert.equal(state.relationships, 0);
  assert.equal(state.receipt, null);
  assert.deepEqual(state.calls, ["transaction.begin", "preview.locked", "pending.create", "transaction.commit"]);
});

test("a committed request retry returns its original result without another mutation", async () => {
  const previousResult = { status: "applied", dependencyId: 41, planRevision: 9 };
  const { state, ports } = transactionalPorts({
    existingReceipt: { payloadHash: "a".repeat(64), status: "succeeded", result: previousResult }
  });
  const result = await executeScmDependencyCommand(command(), { id: "scm-user", surface: "dispatch" }, ports);
  assert.deepEqual(result, { ...previousResult, idempotent: true });
  assert.equal(state.relationships, 0);
  assert.deepEqual(state.calls, []);
});

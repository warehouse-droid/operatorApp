import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPATCH_OPTIMIZED_ORDER_POOL_FLAG_KEY,
  evaluateDispatchOrderPoolPolicy,
  getDispatchOrderPoolPolicy
} from "../../../src/dispatch-order-pool-policy.js";

function readyCatalog(overrides = {}) {
  return {
    status: "ready",
    ready: true,
    generation: 12,
    source: "test",
    catalogCount: 2400,
    legacyCount: 2400,
    assignmentsReady: true,
    shadowMatchCount: 3,
    shadowMismatchCount: 0,
    pendingRefreshCount: 0,
    lastShadowComparisonAt: "2026-08-27T12:02:00.000Z",
    lastFullRefreshAt: "2026-08-27T12:00:00.000Z",
    lastError: "",
    updatedAt: "2026-08-27T12:00:00.000Z",
    ...overrides
  };
}

function flagResult(enabled, present = true) {
  return {
    rows: present ? [{
      enabled,
      revision: 4,
      updated_at: "2026-08-27T12:01:00.000Z"
    }] : []
  };
}

test("deployment off performs no readiness/control queries and stays on legacy", async () => {
  let calls = 0;
  const policy = await getDispatchOrderPoolPolicy({
    deploymentMode: "off",
    queryFn: async () => { calls += 1; return flagResult(true); },
    getCatalogStateFn: async () => { calls += 1; return readyCatalog(); }
  });
  assert.equal(calls, 0);
  assert.equal(policy.runtimeMode, "off");
  assert.equal(policy.effective, false);
  assert.equal(policy.fallbackReason, "deployment_off");
});

test("shadow warms and verifies a ready catalog without consulting the Admin cutover", async () => {
  let gateQueries = 0;
  const policy = await getDispatchOrderPoolPolicy({
    deploymentMode: "shadow",
    queryFn: async () => { gateQueries += 1; return flagResult(true); },
    getCatalogStateFn: async () => readyCatalog()
  });
  assert.equal(gateQueries, 0);
  assert.equal(policy.runtimeMode, "shadow");
  assert.equal(policy.readModelReady, true);
  assert.equal(policy.effective, false);
  assert.equal(policy.fallbackReason, "shadow_verification");
});

test("deployment on still requires the present, enabled Admin gate", async () => {
  for (const [result, reason] of [
    [flagResult(false), "gate_disabled"],
    [flagResult(false, false), "gate_missing"]
  ]) {
    const policy = await getDispatchOrderPoolPolicy({
      deploymentMode: "on",
      queryFn: async (sql, parameters) => {
        assert.match(sql, /mbt_feature_flags/u);
        assert.deepEqual(parameters, [DISPATCH_OPTIMIZED_ORDER_POOL_FLAG_KEY]);
        return result;
      },
      getCatalogStateFn: async () => readyCatalog()
    });
    assert.equal(policy.runtimeMode, "shadow");
    assert.equal(policy.effective, false);
    assert.equal(policy.fallbackReason, reason);
  }
});

test("enabled gate cuts over only when catalog and assignment projections are ready", async () => {
  const enabled = async () => flagResult(true);
  const warming = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog({ status: "warming", ready: false })
  });
  assert.equal(warming.effective, false);
  assert.equal(warming.fallbackReason, "catalog_not_ready");

  const assignmentsWarming = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog({ assignmentsReady: false })
  });
  assert.equal(assignmentsWarming.effective, false);
  assert.equal(assignmentsWarming.fallbackReason, "assignments_not_ready");

  const neverRefreshed = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog({ generation: 0, lastFullRefreshAt: null })
  });
  assert.equal(neverRefreshed.effective, false);
  assert.equal(neverRefreshed.fallbackReason, "catalog_uninitialized");

  const emptyMismatch = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog({ catalogCount: 0, legacyCount: 2400 })
  });
  assert.equal(emptyMismatch.effective, false);
  assert.equal(emptyMismatch.fallbackReason, "catalog_population_mismatch");

  const ready = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog()
  });
  assert.equal(ready.runtimeMode, "on");
  assert.equal(ready.effective, true);
  assert.equal(ready.fallbackReason, "active");
  assert.equal(ready.gateRevision, 4);
  assert.equal(ready.shadowVerified, true);
  assert.equal(ready.activationReady, true);

  const insufficientShadowEvidence = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog({ shadowMatchCount: 2 })
  });
  assert.equal(insufficientShadowEvidence.effective, true,
    "An already-enabled gate stays available while new shadow evidence is collected only before activation.");
  assert.equal(insufficientShadowEvidence.activationReady, false);
  assert.equal(insufficientShadowEvidence.activationBlockReason, "shadow_samples_required");

  const shadowMismatch = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: enabled,
    getCatalogStateFn: async () => readyCatalog({ shadowMismatchCount: 1 })
  });
  assert.equal(shadowMismatch.activationReady, false);
  assert.equal(shadowMismatch.activationBlockReason, "shadow_mismatch");
});

test("control or catalog errors fail closed without taking Dispatch down", async () => {
  const gateFailure = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: () => { throw new Error("feature table unavailable"); },
    getCatalogStateFn: async () => readyCatalog()
  });
  assert.equal(gateFailure.effective, false);
  assert.equal(gateFailure.runtimeMode, "shadow");
  assert.equal(gateFailure.fallbackReason, "gate_unavailable");

  const catalogFailure = await getDispatchOrderPoolPolicy({
    deploymentMode: "on",
    queryFn: async () => flagResult(true),
    getCatalogStateFn: () => { throw new Error("catalog table unavailable"); }
  });
  assert.equal(catalogFailure.effective, false);
  assert.equal(catalogFailure.readModelReady, false);
  assert.equal(catalogFailure.fallbackReason, "catalog_unavailable");
});

test("pure evaluation defaults every unknown input to the legacy path", () => {
  const policy = evaluateDispatchOrderPoolPolicy({
    deploymentMode: "unexpected",
    gate: { present: true, enabled: true },
    catalogState: readyCatalog()
  });
  assert.equal(policy.deploymentMode, "off");
  assert.equal(policy.runtimeMode, "off");
  assert.equal(policy.effective, false);
});

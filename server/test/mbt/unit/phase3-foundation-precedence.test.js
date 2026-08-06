import assert from "node:assert/strict";
import test from "node:test";

import { evaluateMbtPhase3Capability } from "../../../src/mbt/phase3-capabilities.js";

const environment = Object.freeze({
  enabled: true,
  billingOperationsEnabled: false
});

test("P3 compatibility: a closed foundation takes precedence over a granular billing gate", () => {
  assert.deepEqual(evaluateMbtPhase3Capability({
    capability: "billingOperations",
    environment,
    databaseFlags: {
      mbt_enabled: false,
      mbt_billing_operations: false
    },
    pilotAuthorized: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "database_root_disabled"
  });

  assert.deepEqual(evaluateMbtPhase3Capability({
    capability: "billingOperations",
    environment,
    databaseFlags: { mbt_billing_operations: false },
    pilotAuthorized: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "database_root_missing"
  });
});

test("P3 compatibility: a live foundation retains the granular recovery state", () => {
  assert.deepEqual(evaluateMbtPhase3Capability({
    capability: "billingOperations",
    environment,
    databaseFlags: {
      mbt_enabled: true,
      mbt_billing_operations: false
    },
    pilotAuthorized: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "environment_capability_disabled"
  });
});

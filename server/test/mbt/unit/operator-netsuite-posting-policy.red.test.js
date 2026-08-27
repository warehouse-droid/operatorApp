// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExpectedOperatorNetSuitePostingPolicy,
  materializeOperatorNetSuitePostingPolicy,
  normalizeOperatorNetSuiteLocationId,
  OPERATOR_NETSUITE_GATE_DEFINITIONS,
  OPERATOR_NETSUITE_POSTING_FUNCTIONS,
  OPERATOR_NETSUITE_YARDS,
  operatorNetSuitePostingGateKey
} from "../../../src/operator-netsuite-posting-policy.js";

const EXPECTED_YARDS = Object.freeze([
  { locationId: 1, yardCode: "3445" },
  { locationId: 28, yardCode: "2967" },
  { locationId: 15, yardCode: "12441" },
  { locationId: 26, yardCode: "150" }
]);

const EXPECTED_FUNCTIONS = Object.freeze({
  customerPickup: Object.freeze({
    functionKey: "customer_pickup",
    transactionType: "IF",
    gateSegment: "customer_pickup_if"
  }),
  receiving: Object.freeze({
    functionKey: "receiving",
    transactionType: "IR",
    gateSegment: "receiving_ir"
  }),
  deliveryPrep: Object.freeze({
    functionKey: "delivery_prep",
    transactionType: "IF",
    gateSegment: "delivery_prep_if"
  })
});

test("G1 policy exposes the exact four yards, three functions, and twelve disabled-by-default gate definitions", () => {
  assert.deepEqual(OPERATOR_NETSUITE_YARDS, EXPECTED_YARDS);
  assert.deepEqual(OPERATOR_NETSUITE_POSTING_FUNCTIONS, EXPECTED_FUNCTIONS);
  assert.equal(OPERATOR_NETSUITE_GATE_DEFINITIONS.length, 12);
  assert.deepEqual(
    OPERATOR_NETSUITE_GATE_DEFINITIONS.map(({ flagKey }) => flagKey),
    [
      "operator_netsuite_customer_pickup_if_3445",
      "operator_netsuite_receiving_ir_3445",
      "operator_netsuite_delivery_prep_if_3445",
      "operator_netsuite_customer_pickup_if_2967",
      "operator_netsuite_receiving_ir_2967",
      "operator_netsuite_delivery_prep_if_2967",
      "operator_netsuite_customer_pickup_if_12441",
      "operator_netsuite_receiving_ir_12441",
      "operator_netsuite_delivery_prep_if_12441",
      "operator_netsuite_customer_pickup_if_150",
      "operator_netsuite_receiving_ir_150",
      "operator_netsuite_delivery_prep_if_150"
    ]
  );
  assert.ok(OPERATOR_NETSUITE_GATE_DEFINITIONS.every((definition) => (
    definition.configuredDefault === false
      && definition.requiresNetSuiteDirectAccess === true
      && definition.independent === true
      && definition.locked === false
  )));
});

test("G2 each yard/function resolves one exact readable gate key", () => {
  for (const yard of EXPECTED_YARDS) {
    for (const details of Object.values(EXPECTED_FUNCTIONS)) {
      assert.equal(operatorNetSuitePostingGateKey({
        functionKey: details.functionKey,
        locationId: yard.locationId
      }), `operator_netsuite_${details.gateSegment}_${yard.yardCode}`);
    }
  }
  assert.equal(operatorNetSuitePostingGateKey({ functionKey: "unknown", locationId: 15 }), null);
  assert.equal(operatorNetSuitePostingGateKey({ functionKey: "delivery_prep", locationId: 999 }), null);
});

test("G3/G4 location normalization accepts canonical IDs and legacy 2967 only", () => {
  for (const yard of EXPECTED_YARDS) {
    assert.equal(normalizeOperatorNetSuiteLocationId(yard.locationId), yard.locationId);
    assert.equal(normalizeOperatorNetSuiteLocationId(String(yard.locationId)), yard.locationId);
    assert.equal(normalizeOperatorNetSuiteLocationId(yard.yardCode), yard.locationId);
  }
  assert.equal(normalizeOperatorNetSuiteLocationId(13), 28);
  assert.equal(normalizeOperatorNetSuiteLocationId("13"), 28);
  for (const unsupported of [null, undefined, "", 0, -1, 999, "12441 Woodbine", {}, []]) {
    assert.equal(normalizeOperatorNetSuiteLocationId(unsupported), null);
  }
});

test("G2/G3 materialization isolates one cell and applies the deployment ceiling", () => {
  assert.equal(OPERATOR_NETSUITE_GATE_DEFINITIONS.length, 12);
  for (const definition of OPERATOR_NETSUITE_GATE_DEFINITIONS) {
    const active = materializeOperatorNetSuitePostingPolicy({
      functionKey: definition.operatorFunction,
      locationId: definition.locationId,
      flag: { enabled: true, revision: 7 },
      directAccessEnabled: true
    });
    assert.deepEqual({
      gateKey: active.gateKey,
      configured: active.configured,
      effective: active.effective,
      revision: active.revision,
      transactionType: active.transactionType,
      locationId: active.locationId,
      yardCode: active.yardCode
    }, {
      gateKey: definition.flagKey,
      configured: true,
      effective: true,
      revision: 7,
      transactionType: definition.transactionType,
      locationId: definition.locationId,
      yardCode: definition.yardCode
    });

    const ceilingClosed = materializeOperatorNetSuitePostingPolicy({
      functionKey: definition.operatorFunction,
      locationId: definition.locationId,
      flag: { enabled: true, revision: 8 },
      directAccessEnabled: false
    });
    assert.equal(ceilingClosed.configured, true);
    assert.equal(ceilingClosed.environmentAllowed, false);
    assert.equal(ceilingClosed.effective, false);
  }
});

test("G1/G3 missing, malformed, or unsupported policy inputs fail closed", () => {
  const missing = materializeOperatorNetSuitePostingPolicy({
    functionKey: "delivery_prep",
    locationId: 15,
    flag: null,
    directAccessEnabled: true
  });
  assert.equal(missing.gateKey, "operator_netsuite_delivery_prep_if_12441");
  assert.equal(missing.present, false);
  assert.equal(missing.configured, false);
  assert.equal(missing.effective, false);
  assert.equal(missing.revision, null);

  for (const input of [
    { functionKey: "delivery_prep", locationId: 999 },
    { functionKey: "bad", locationId: 15 },
    { functionKey: "", locationId: 15 }
  ]) {
    const policy = materializeOperatorNetSuitePostingPolicy({
      ...input,
      flag: { enabled: true, revision: 1 },
      directAccessEnabled: true
    });
    assert.equal(policy.supported, false);
    assert.equal(policy.effective, false);
    assert.equal(policy.gateKey, null);
  }
});

test("G4 an exact expected policy passes and every stale/forged identity fails before mutation", () => {
  const actual = materializeOperatorNetSuitePostingPolicy({
    functionKey: "delivery_prep",
    locationId: 15,
    flag: { enabled: true, revision: 19 },
    directAccessEnabled: true
  });
  assert.doesNotThrow(() => assertExpectedOperatorNetSuitePostingPolicy({
    expected: { gateKey: actual.gateKey, revision: 19, effective: true },
    actual
  }));

  for (const expected of [
    null,
    {},
    { gateKey: actual.gateKey, revision: 18, effective: true },
    { gateKey: actual.gateKey, revision: 19, effective: false },
    { gateKey: "operator_netsuite_delivery_prep_if_2967", revision: 19, effective: true }
  ]) {
    assert.throws(
      () => assertExpectedOperatorNetSuitePostingPolicy({ expected, actual }),
      (error) => error?.status === 409 && error?.code === "OPERATOR_NETSUITE_POSTING_POLICY_CHANGED"
    );
  }
});

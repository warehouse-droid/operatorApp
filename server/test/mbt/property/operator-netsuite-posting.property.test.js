// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import {
  materializeOperatorNetSuitePostingPolicy,
  OPERATOR_NETSUITE_GATE_DEFINITIONS
} from "../../../src/operator-netsuite-posting-policy.js";

const REQUEST_ID = "f9199b36-36c9-49a7-bbe8-304564559e39";

function draftForQuantities(quantities, { reverseTargets = false } = {}) {
  const targets = quantities.map((quantity, index) => ({
    sourceOrderKind: "SO",
    sourceNetSuiteId: 99001,
    sourceOrderRef: "SO-PROPERTY",
    selectedLines: [{
      orderLine: 1,
      quantity,
      location: 15,
      localOrderKey: `delivery_prep:sales_order:${index + 1}`,
      localLineId: `line-${index + 1}`
    }],
    availableLines: [
      { orderLine: 1, location: 15 },
      { orderLine: 2, location: 15 }
    ]
  }));
  return buildOperatorNetSuitePostingDraft({
    requestId: REQUEST_ID,
    actorOperatorId: "property-operator",
    functionKey: "delivery_prep",
    transactionType: "IF",
    policy: {
      gateKey: "operator_netsuite_delivery_prep_if_12441",
      revision: 9,
      effective: true,
      functionKey: "delivery_prep",
      transactionType: "IF",
      locationId: 15,
      yardCode: "12441"
    },
    photoRefs: ["r2://operator/property.jpg"],
    localOrderKeys: quantities.map((_, index) => `delivery_prep:sales_order:${index + 1}`),
    localOperation: { kind: "delivery_prep_load", orderId: "group-property", orderType: "group_order" },
    targets: reverseTargets ? targets.reverse() : targets
  });
}

test("G2/G3 property: only configured plus environment-allowed cells can become effective", () => {
  fc.assert(fc.property(
    fc.constantFrom(...OPERATOR_NETSUITE_GATE_DEFINITIONS),
    fc.boolean(),
    fc.boolean(),
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    (definition, configured, directAccessEnabled, revision) => {
      const policy = materializeOperatorNetSuitePostingPolicy({
        functionKey: definition.operatorFunction,
        locationId: definition.locationId,
        flag: { enabled: configured, revision },
        directAccessEnabled
      });
      assert.equal(policy.gateKey, definition.flagKey);
      assert.equal(policy.effective, configured && directAccessEnabled);
      assert.equal(policy.revision, revision);
    }
  ), { numRuns: 500 });
});

test("P4/P5 property: split quantities aggregate once and permutation cannot change the command hash", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 20 }),
    (quantities) => {
      const forward = draftForQuantities(quantities);
      const reversed = draftForQuantities(quantities, { reverseTargets: true });
      assert.equal(forward.steps.length, 1);
      assert.equal(forward.steps[0].payload.item.items[0].quantity, quantities.reduce((sum, value) => sum + value, 0));
      assert.deepEqual(forward.steps[0].payload.item.items[1], {
        orderLine: 2,
        itemReceive: false,
        location: 15
      });
      assert.equal(forward.inputHash, reversed.inputHash);
    }
  ), { numRuns: 300 });
});

test("R2/R3 property: live remaining quantity is a shared cap across every split permutation", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 12 }),
    fc.nat(),
    (quantities, seed) => {
      const requested = quantities.reduce((sum, value) => sum + value, 0);
      const remaining = seed % (requested + 1);
      const authoritativeInput = (reverseTargets) => {
        const targets = quantities.map((quantity, index) => ({
          sourceOrderKind: "SO",
          sourceNetSuiteId: 99001,
          sourceOrderRef: "SO-PROPERTY",
          selectedLines: [{
            orderLine: 1,
            quantity,
            location: 15,
            sourceLineKey: "stable-1",
            localOrderKey: `delivery_prep:sales_order:${index + 1}`,
            localLineId: `line-${index + 1}`
          }],
          availableLines: [{
            orderLine: 1,
            location: 15,
            sourceLineKey: "stable-1",
            orderedQuantity: requested,
            completedQuantity: requested - remaining,
            remainingQuantity: remaining
          }]
        }));
        return buildOperatorNetSuitePostingDraft({
          requestId: REQUEST_ID,
          actorOperatorId: "property-operator",
          functionKey: "delivery_prep",
          transactionType: "IF",
          policy: {
            gateKey: "operator_netsuite_delivery_prep_if_12441",
            revision: 9,
            effective: true,
            functionKey: "delivery_prep",
            transactionType: "IF",
            locationId: 15,
            yardCode: "12441"
          },
          photoRefs: ["r2://operator/property.jpg"],
          localOrderKeys: quantities.map((_, index) => `delivery_prep:sales_order:${index + 1}`),
          localOperation: { kind: "delivery_prep_load", orderId: "group-property", orderType: "group_order" },
          targets: reverseTargets ? targets.reverse() : targets
        });
      };
      const forward = authoritativeInput(false);
      const reversed = authoritativeInput(true);
      assert.equal(forward.steps.length, remaining > 0 ? 1 : 0);
      if (remaining > 0) {
        assert.equal(forward.steps[0].payload.item.items[0].quantity, remaining);
      }
      assert.equal(forward.lineReconciliation.lines[0].requestedQuantity, requested);
      assert.equal(forward.lineReconciliation.lines[0].postedQuantity, remaining);
      assert.equal(forward.lineReconciliation.lines[0].reconciledQuantity, requested - remaining);
      assert.equal(forward.inputHash, reversed.inputHash);
    }
  ), { numRuns: 300 });
});

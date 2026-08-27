// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEffectiveReattemptIdentity,
  buildReattemptIdentityFingerprint,
  evaluateReattemptDriverReadiness,
  normalizeReattemptCorrectionCommand
} from "../../../src/sales-order-reattempt-correction.js";

const historicalLine = Object.freeze({
  lineRowId: "reattempt:2:0",
  lineId: 4760329,
  salesOrderLineId: 168936,
  itemId: 3631,
  sku: "UNI-WIN70T-RDM-CG",
  itemName: "UNI-WIN70T-RDM-CG",
  description: "Windermere Cliffside Grey",
  pallets: 16,
  quantity: 1470.08,
  salesQty: 1470.08,
  unit: "SQFT",
  historicalItemId: 3631,
  historicalSku: "UNI-WIN70T-RDM-CG",
  currentItemId: 3632,
  currentSku: "UNI-WIN70T-RDM-GN"
});

const correction = Object.freeze({
  correctionId: 44,
  childOrderId: 128,
  cycleId: 2,
  parentSalesOrderId: 945867,
  netsuiteLineId: 4760329,
  beforeItemId: 3631,
  beforeSku: "UNI-WIN70T-RDM-CG",
  afterItemId: 3632,
  afterSku: "UNI-WIN70T-RDM-GN",
  afterItemName: "UNI-WIN70T-RDM-GN",
  afterDescription: "Windermere Granite Blend",
  afterSalesUom: "SQFT",
  targetSalesQty: 1470.08,
  targetPalletQty: 16,
  reason: "Confirmed the physical second attempt delivered GN",
  createdAt: "2026-08-25T18:00:00.000Z"
});

test("effective projection overlays GN while preserving immutable historical CG and quantity", () => {
  const projected = applyEffectiveReattemptIdentity(historicalLine, correction);
  assert.equal(projected.itemId, 3632);
  assert.equal(projected.sku, "UNI-WIN70T-RDM-GN");
  assert.equal(projected.itemName, "UNI-WIN70T-RDM-GN");
  assert.equal(projected.description, "Windermere Granite Blend");
  assert.equal(projected.effectiveItemId, 3632);
  assert.equal(projected.effectiveSku, "UNI-WIN70T-RDM-GN");
  assert.equal(projected.historicalItemId, 3631);
  assert.equal(projected.historicalSku, "UNI-WIN70T-RDM-CG");
  assert.equal(projected.pallets, 16);
  assert.equal(projected.salesQty, 1470.08);
  assert.equal(historicalLine.sku, "UNI-WIN70T-RDM-CG", "The source evidence must not be mutated.");
});

test("effective projection handles legacy fallback shapes without losing historical identity", () => {
  assert.deepEqual(applyEffectiveReattemptIdentity({ itemId: 7, itemName: "LEGACY-NAME" }), {
    itemId: 7,
    itemName: "LEGACY-NAME",
    historicalItemId: 7,
    historicalSku: "LEGACY-NAME",
    effectiveItemId: 7,
    effectiveSku: "LEGACY-NAME",
    identityCorrected: false
  });
  assert.deepEqual(applyEffectiveReattemptIdentity(), {
    historicalItemId: null,
    historicalSku: "",
    effectiveItemId: null,
    effectiveSku: "",
    identityCorrected: false
  });

  const variants = [
    {
      line: {
        itemId: 1,
        sku: "OLD-1",
        quantity: 2,
        palletQty: 1,
        currentItemId: 11,
        currentSku: "NEW-1",
        description: "Fallback description",
        salesUom: "EA"
      },
      correction: { id: 1, targetSalesQty: 2, targetPalletQty: 1 },
      expected: { itemId: 11, sku: "NEW-1", description: "Fallback description", unit: "" }
    },
    {
      line: {
        itemId: 2,
        sku: "OLD-2",
        targetSalesQty: 3,
        targetPalletQty: 2,
        itemDescription: "Item description fallback",
        unit: "SQFT"
      },
      correction: { targetSalesQty: 3, targetPalletQty: 2 },
      expected: { itemId: 2, sku: "OLD-2", description: "", unit: "SQFT" }
    },
    {
      line: {
        itemName: "OLD-3",
        loadedQty: 4,
        packedPallets: 3
      },
      correction: { targetSalesQty: 4, targetPalletQty: 3 },
      expected: { itemId: null, sku: "", description: "", unit: "" }
    },
    {
      line: {},
      correction: {},
      expected: { itemId: null, sku: "", description: "", unit: "" }
    }
  ];
  for (const variant of variants) {
    const projected = applyEffectiveReattemptIdentity(variant.line, variant.correction);
    assert.equal(projected.itemId, variant.expected.itemId);
    assert.equal(projected.sku, variant.expected.sku);
    assert.equal(projected.description, variant.expected.description);
    assert.equal(projected.unit, variant.expected.unit);
    assert.equal(projected.identityCorrected, true);
  }
});

test("correction fingerprint is deterministic and binds identity, quantity, child, and lifecycle state", () => {
  const state = {
    childOrderId: 128,
    cycleId: 2,
    parentSalesOrderId: 945867,
    netsuiteLineId: 4760329,
    beforeItemId: 3631,
    beforeSku: "UNI-WIN70T-RDM-CG",
    afterItemId: 3632,
    afterSku: "UNI-WIN70T-RDM-GN",
    currentSalesQty: 1470.08,
    currentPalletQty: 16,
    targetSalesQty: 1470.08,
    targetPalletQty: 16,
    childStatus: "completed",
    cycleStatus: "authorized"
  };
  const first = buildReattemptIdentityFingerprint(state);
  const second = buildReattemptIdentityFingerprint({ ...state });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
  assert.notEqual(buildReattemptIdentityFingerprint({ ...state, afterItemId: 9999 }), first);
  assert.notEqual(buildReattemptIdentityFingerprint({ ...state, targetPalletQty: 15 }), first);
  assert.notEqual(buildReattemptIdentityFingerprint({ ...state, currentSalesQty: 1469 }), first);
  assert.notEqual(buildReattemptIdentityFingerprint({ ...state, currentPalletQty: 15 }), first);
  assert.notEqual(buildReattemptIdentityFingerprint({ ...state, childStatus: "open" }), first);
  assert.match(buildReattemptIdentityFingerprint(), /^[a-f0-9]{64}$/);
});

test("completed correction command rejects blank reason, stale state, and invalid idempotency keys", () => {
  const valid = {
    orderRef: "SOM05681-R1",
    idempotencyKey: "4a7e8919-cdd8-48ae-bdf3-a9175f3da600",
    expectedStateFingerprint: "a".repeat(64),
    reason: "Confirmed the physical second attempt delivered GN",
    physicallyDeliveredCurrentItem: true
  };
  assert.deepEqual(normalizeReattemptCorrectionCommand(valid), valid);
  for (const input of [
    { ...valid, orderRef: "" },
    { ...valid, orderRef: "R".repeat(101) },
    { ...valid, reason: "  " },
    { ...valid, reason: "R".repeat(501) },
    { ...valid, idempotencyKey: "not-a-uuid" },
    { ...valid, expectedStateFingerprint: "bad" },
    { ...valid, physicallyDeliveredCurrentItem: false }
  ]) {
    assert.throws(
      () => normalizeReattemptCorrectionCommand(input),
      (error) => String(error?.code || "").startsWith("REATTEMPT_CORRECTION_")
    );
  }
  assert.throws(
    () => normalizeReattemptCorrectionCommand(),
    (error) => error?.code === "REATTEMPT_CORRECTION_ORDER_REF_INVALID"
  );
});

test("future re-attempt Driver execution stays blocked until a genuine Operator load completed it", () => {
  assert.deepEqual(evaluateReattemptDriverReadiness(), { allowed: true, code: "" });
  assert.deepEqual(evaluateReattemptDriverReadiness({ workflowKind: "standard_reload" }), {
    allowed: true,
    code: ""
  });
  for (const state of [
    { workflowKind: "sales_order_reattempt", cycleStatus: "authorized", hasOperatorLoad: false },
    {
      workflowKind: "sales_order_reattempt",
      cycleStatus: "completed",
      completionSource: "driver_completion_reconciliation",
      hasOperatorLoad: false
    },
    {
      workflowKind: "sales_order_reattempt",
      cycleStatus: "completed",
      completionSource: "operator_load",
      hasOperatorLoad: false
    }
  ]) {
    assert.deepEqual(evaluateReattemptDriverReadiness(state), {
      allowed: false,
      code: "DRIVER_REATTEMPT_OPERATOR_LOAD_REQUIRED"
    });
  }
  assert.deepEqual(evaluateReattemptDriverReadiness({
    workflowKind: "sales_order_reattempt",
    cycleStatus: "completed",
    completionSource: "operator_load",
    hasOperatorLoad: true
  }), { allowed: true, code: "" });
});

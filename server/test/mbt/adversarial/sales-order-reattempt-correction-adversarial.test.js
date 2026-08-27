// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEffectiveReattemptIdentity,
  evaluateReattemptDriverReadiness,
  normalizeReattemptCorrectionCommand
} from "../../../src/sales-order-reattempt-correction.js";

const correction = Object.freeze({
  afterItemId: 3632,
  afterSku: "UNI-WIN70T-RDM-GN",
  targetSalesQty: 1470.08,
  targetPalletQty: 16
});

test("malformed and drifting correction quantities fail closed without mutating the source", () => {
  const line = Object.freeze({
    itemId: 3631,
    sku: "UNI-WIN70T-RDM-CG",
    historicalItemId: 3631,
    historicalSku: "UNI-WIN70T-RDM-CG",
    salesQty: 1470.08,
    pallets: 16
  });
  for (const candidate of [
    { ...line, salesQty: 1470.07 },
    { ...line, pallets: 15 },
    { ...line, salesQty: Number.NaN },
    { ...line, salesQty: Number.POSITIVE_INFINITY },
    { ...line, pallets: -1 }
  ]) {
    assert.throws(
      () => applyEffectiveReattemptIdentity(candidate, correction),
      (error) => String(error?.code || "").startsWith("REATTEMPT_CORRECTION_QUANTITY_")
    );
  }
  assert.equal(line.sku, "UNI-WIN70T-RDM-CG");
  assert.equal(line.salesQty, 1470.08);
});

test("physical confirmation cannot be supplied through truthy strings or numbers", () => {
  const base = {
    orderRef: "SOM05681-R1",
    idempotencyKey: "4a7e8919-cdd8-48ae-bdf3-a9175f3da600",
    expectedStateFingerprint: "a".repeat(64),
    reason: "Physically verified against the second delivery",
    physicallyDeliveredCurrentItem: true
  };
  for (const value of ["true", 1, {}, [], null, undefined]) {
    assert.throws(
      () => normalizeReattemptCorrectionCommand({ ...base, physicallyDeliveredCurrentItem: value }),
      (error) => error?.code === "REATTEMPT_CORRECTION_PHYSICAL_CONFIRMATION_REQUIRED"
    );
  }
});

test("reconciled or incomplete cycles never become executable Driver work", () => {
  for (const state of [
    { cycleStatus: "authorized", completionSource: "", hasOperatorLoad: false },
    { cycleStatus: "completed", completionSource: "driver_completion_reconciliation", hasOperatorLoad: false },
    { cycleStatus: "completed", completionSource: "operator_load", hasOperatorLoad: false },
    { cycleStatus: "completed", completionSource: "driver_completion_reconciliation", hasOperatorLoad: true }
  ]) {
    assert.equal(evaluateReattemptDriverReadiness({
      workflowKind: "sales_order_reattempt",
      ...state
    }).allowed, false);
  }
});

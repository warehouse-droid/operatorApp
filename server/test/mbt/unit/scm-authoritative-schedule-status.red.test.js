import assert from "node:assert/strict";
import test from "node:test";

import { driverOrderDetailsFromPlan } from "../../../src/driver-repository.js";
import {
  classifyNetSuiteLifecycle,
  derivePoToReconciliationState
} from "../../../src/scm-reconciliation.js";
import { isNetSuiteOrderClosed } from "../../../src/netsuite-closed-order-policy.js";

test("SAS-U1: authoritative VRMA source wins over the legacy PO plan type", () => {
  const details = driverOrderDetailsFromPlan("RP-UNI-AYR-0806-2", {
    id: "RP-UNI-AYR-0806-2",
    type: "PO",
    sourceTable: "scm_vrma_orders",
    items: [{ sku: "PALLET", quantity: 1 }]
  });

  assert.equal(details.orderType, "VRMA");
});

test("SAS-U2: rejected NetSuite orders are terminal instead of operational", () => {
  const lifecycle = classifyNetSuiteLifecycle("Transfer Order : Rejected", "C");
  assert.equal(lifecycle.rejected, true);
  assert.equal(lifecycle.closed, true);
  assert.equal(isNetSuiteOrderClosed({
    status: "C",
    statusText: "Transfer Order : Rejected"
  }), true);

  const untouched = derivePoToReconciliationState({
    kind: "TO",
    statusText: "Transfer Order : Rejected",
    statusCode: "C",
    orderedQty: 100
  });
  assert.equal(untouched.applicationStatus, "Cancelled");
  assert.deepEqual(untouched.quantities, {
    ordered: 100,
    fulfilled: 0,
    received: 0,
    abandoned: 100,
    remaining: 0,
    destinationRemaining: 0
  });

  const partial = derivePoToReconciliationState({
    kind: "TO",
    statusText: "Transfer Order : Rejected",
    statusCode: "C",
    orderedQty: 100,
    fulfilledQty: 40,
    receivedQty: 20
  });
  assert.equal(partial.applicationStatus, "Completed");
  assert.equal(partial.reconciliationStatus, "ok");
  assert.deepEqual(partial.quantities, {
    ordered: 100,
    fulfilled: 40,
    received: 20,
    abandoned: 60,
    remaining: 0,
    destinationRemaining: 0
  });
});

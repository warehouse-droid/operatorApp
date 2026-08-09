import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  derivePoToReconciliationState,
  shouldFetchPoToLinkedTransactions
} from "./scm-reconciliation.js";

const exactPo = (statusText) => ({
  kind: "PO",
  statusText,
  lines: [{
    stage: "receiving",
    sourceLineKey: "101",
    identityStatus: "exact",
    quantity: 10,
    cumulativeProgressQuantity: 0,
    cumulativeProgressObserved: true
  }]
});

const exactTo = (statusText) => ({
  kind: "TO",
  statusText,
  lines: [
    {
      stage: "outbound",
      sourceLineKey: "201",
      logicalLineIdentity: "transfer-anchor:201",
      identityStatus: "exact",
      quantity: 10,
      cumulativeProgressQuantity: 0,
      cumulativeProgressObserved: true
    },
    {
      stage: "receiving",
      sourceLineKey: "202",
      logicalLineIdentity: "transfer-anchor:201",
      identityStatus: "exact",
      quantity: 10,
      cumulativeProgressQuantity: 0,
      cumulativeProgressObserved: true
    }
  ]
});

test("internal PO/TO progress values cannot become transport schedule statuses", () => {
  for (const previousStatus of ["not_received", "not_fulfilled", "partial_received", "partial_fulfilled"]) {
    const result = derivePoToReconciliationState({
      kind: "TO",
      statusText: "Pending Fulfillment",
      orderedQty: 10,
      previousStatus
    });
    assert.equal(result.applicationStatus, "Queued", previousStatus);
  }
  for (const previousStatus of ["Queued", "Planned", "Urgent", "Hold", "Priority", "Surplus Only", "Book Appt"]) {
    const result = derivePoToReconciliationState({
      kind: "PO",
      statusText: "Pending Receipt",
      orderedQty: 10,
      previousStatus
    });
    assert.equal(result.applicationStatus, previousStatus, previousStatus);
  }
});

test("unambiguous terminal PO and TO headers supply completed receipt progress", () => {
  for (const statusText of [
    "Purchase Order : Received",
    "Purchase Order : Pending Billing",
    "Purchase Order : Pending Bill",
    "Purchase Order : Billed",
    "Purchase Order : Fully Billed"
  ]) {
    const result = derivePoToReconciliationState({
      kind: "PO",
      statusText,
      orderedQty: 10,
      receivedQty: 0
    });
    assert.equal(result.applicationStatus, "Completed", statusText);
    assert.equal(result.quantities.received, 10, statusText);
    assert.equal(result.quantities.remaining, 0, statusText);
  }

  const receivedTransfer = derivePoToReconciliationState({
    kind: "TO",
    statusText: "Transfer Order : Received",
    orderedQty: 10,
    fulfilledQty: 0,
    receivedQty: 0
  });
  assert.equal(receivedTransfer.applicationStatus, "Completed");
  assert.equal(receivedTransfer.quantities.fulfilled, 10);
  assert.equal(receivedTransfer.quantities.received, 10);
  assert.equal(receivedTransfer.quantities.destinationRemaining, 0);
});

test("only safe terminal PO/TO headers can skip linked IF/IR lookup", () => {
  for (const order of [
    exactPo("Purchase Order : Received"),
    exactPo("Purchase Order : Pending Billing"),
    exactPo("Purchase Order : Fully Billed"),
    exactTo("Transfer Order : Received")
  ]) {
    assert.equal(
      shouldFetchPoToLinkedTransactions(order),
      false,
      order.statusText
    );
  }

  for (const order of [
    exactPo("Purchase Order : Pending Receipt"),
    exactPo("Purchase Order : Partially Received"),
    exactPo("Purchase Order : Pending Billing / Partially Received"),
    exactPo("Purchase Order : Closed"),
    exactTo("Transfer Order : Pending Fulfillment"),
    exactTo("Transfer Order : Pending Receipt"),
    exactTo("Transfer Order : Partially Fulfilled"),
    exactTo("Transfer Order : Partially Received")
  ]) {
    assert.equal(
      shouldFetchPoToLinkedTransactions(order),
      true,
      order.statusText
    );
  }
});

test("terminal headers still use linked IF/IR for split, pinned, missing-line, or ambiguous evidence", () => {
  assert.equal(shouldFetchPoToLinkedTransactions(
    exactPo("Purchase Order : Pending Billing"),
    { linkedEvidenceSensitive: true }
  ), true);

  assert.equal(shouldFetchPoToLinkedTransactions({
    ...exactTo("Transfer Order : Received"),
    headerOnlyFallback: true
  }), true);

  assert.equal(shouldFetchPoToLinkedTransactions({
    ...exactPo("Purchase Order : Fully Billed"),
    lines: [{
      ...exactPo("Purchase Order : Fully Billed").lines[0],
      identityStatus: "ambiguous"
    }]
  }), true);

  assert.equal(shouldFetchPoToLinkedTransactions({
    ...exactTo("Transfer Order : Received"),
    lines: exactTo("Transfer Order : Received").lines.filter((line) =>
      line.stage === "receiving"
    )
  }), true);

  assert.equal(shouldFetchPoToLinkedTransactions({
    ...exactPo("Purchase Order : Received"),
    lines: []
  }), true);

  assert.equal(shouldFetchPoToLinkedTransactions({
    kind: "SO",
    statusText: "Sales Order : Fulfilled",
    lines: exactPo("Purchase Order : Received").lines
  }), true);
});

test("the reconciliation worker partitions linked lookups and preserves skipped historical evidence", async () => {
  const serviceSource = await readFile(
    new URL("./scm-reconciliation-service.js", import.meta.url),
    "utf8"
  );
  assert.match(serviceSource, /shouldFetchPoToLinkedTransactions/);
  assert.match(serviceSource, /listScmReconciliationLinkedEvidenceSensitiveSourceKeys/);
  assert.match(serviceSource, /linkedLookupSkippedOrders/);
  assert.match(serviceSource, /authoritativeLinkedEvidence/);
});

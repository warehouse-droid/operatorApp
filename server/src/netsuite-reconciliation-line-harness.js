import assert from "node:assert/strict";
import {
  normalizePoToLinkedTransactionRows,
  normalizePoToReconciliationLines
} from "./netsuite.js";
import {
  matchCurrentProgress,
  scmReconciliationLineIdentityIssues
} from "./scm-reconciliation-repository.js";

function transferRow({
  sourceLineKey,
  orderLine,
  stage = "outbound",
  itemId = 700,
  quantity = 100,
  progress = 20,
  doNotPrintLine,
  lineSequenceNumber
}) {
  return {
    sourceLineKey: String(sourceLineKey),
    orderLine,
    stage,
    itemId,
    itemName: `ITEM-${itemId}`,
    itemDescription: "Concrete product",
    itemType: "InvtPart",
    itemTypeText: "Inventory Item",
    signedQuantity: stage === "outbound" ? -quantity : quantity,
    quantity,
    cumulativeProgressQuantity: progress,
    doNotPrintLine,
    lineSequenceNumber,
    unit: "EA",
    locationId: stage === "outbound" ? 1 : 2,
    location: stage === "outbound" ? "Source" : "Destination",
    itemWeight: 1,
    palletQty: 1,
    layerQty: 0,
    sectionQty: 0,
    pieceQty: 0,
    toPlt: 100,
    toLyr: 10,
    toSec: 1,
    toPcs: 1,
    raw: { sourceLineKey: String(sourceLineKey), orderLine }
  };
}

const liveTransferTriplets = normalizePoToReconciliationLines([
  transferRow({
    sourceLineKey: 701,
    orderLine: 1,
    progress: 0,
    doNotPrintLine: "F",
    lineSequenceNumber: 1
  }),
  transferRow({
    sourceLineKey: 702,
    orderLine: 2,
    progress: 60,
    doNotPrintLine: "T",
    lineSequenceNumber: 2
  }),
  transferRow({
    sourceLineKey: 703,
    orderLine: 3,
    stage: "receiving",
    progress: 40,
    doNotPrintLine: "T",
    lineSequenceNumber: 3
  }),
  transferRow({
    sourceLineKey: 704,
    orderLine: 4,
    progress: 0,
    doNotPrintLine: "F",
    lineSequenceNumber: 4
  }),
  transferRow({
    sourceLineKey: 705,
    orderLine: 5,
    progress: 100,
    doNotPrintLine: "T",
    lineSequenceNumber: 5
  }),
  transferRow({
    sourceLineKey: 706,
    orderLine: 6,
    stage: "receiving",
    progress: 100,
    doNotPrintLine: "T",
    lineSequenceNumber: 6
  })
], "TO");
assert.equal(
  liveTransferTriplets.length,
  4,
  "Two real NetSuite F/T/T transfer triplets must remain two logical lines per stage."
);
const liveOutbound = liveTransferTriplets.filter((line) => line.stage === "outbound");
const liveReceiving = liveTransferTriplets.filter((line) => line.stage === "receiving");
assert.deepEqual(liveOutbound[0].sourceLineAliases, ["701", "702"]);
assert.deepEqual(liveReceiving[0].sourceLineAliases, ["703"]);
assert.equal(liveOutbound[0].cumulativeProgressQuantity, 60);
assert.equal(liveReceiving[0].cumulativeProgressQuantity, 40);
assert.ok(liveTransferTriplets.every((line) => line.identityStatus === "exact"));
assert.equal(
  liveOutbound[0].logicalLineIdentity,
  liveReceiving[0].logicalLineIdentity,
  "The source and destination rows must share the visible TO anchor identity."
);
assert.notEqual(
  liveOutbound[0].logicalLineIdentity,
  liveOutbound[1].logicalLineIdentity,
  "Repeated identical item lines must retain separate logical identities."
);

const harmlessRoleDifferences = normalizePoToReconciliationLines([
  {
    ...transferRow({
      sourceLineKey: 711,
      orderLine: 11,
      progress: 0,
      doNotPrintLine: "F",
      lineSequenceNumber: 11
    }),
    itemDescription: "Visible description"
  },
  {
    ...transferRow({
      sourceLineKey: 712,
      orderLine: 12,
      progress: 25,
      doNotPrintLine: "T",
      lineSequenceNumber: 12
    }),
    itemDescription: "Accounting description"
  },
  {
    ...transferRow({
      sourceLineKey: 713,
      orderLine: 13,
      stage: "receiving",
      progress: 10,
      doNotPrintLine: "T",
      lineSequenceNumber: 13
    }),
    itemDescription: "Destination description"
  }
], "TO");
assert.equal(harmlessRoleDifferences.length, 2);
assert.ok(
  harmlessRoleDifferences.every((line) => line.identityStatus === "exact"),
  "Role-only memo or accounting metadata must not split the item/quantity/UOM triplet."
);

const extraAccountingRow = normalizePoToReconciliationLines([
  transferRow({
    sourceLineKey: 721,
    orderLine: 21,
    progress: 0,
    doNotPrintLine: "F",
    lineSequenceNumber: 21
  }),
  transferRow({
    sourceLineKey: 722,
    orderLine: 22,
    progress: 50,
    doNotPrintLine: "T",
    lineSequenceNumber: 22
  }),
  transferRow({
    sourceLineKey: 723,
    orderLine: 23,
    progress: 50,
    doNotPrintLine: "T",
    lineSequenceNumber: 23
  }),
  transferRow({
    sourceLineKey: 724,
    orderLine: 24,
    stage: "receiving",
    progress: 50,
    doNotPrintLine: "T",
    lineSequenceNumber: 24
  })
], "TO");
assert.equal(
  extraAccountingRow.length,
  2,
  "An unmatched hidden accounting row must not become extra ordered quantity."
);
assert.equal(
  extraAccountingRow.filter((line) => line.stage === "outbound")
    .reduce((sum, line) => sum + line.quantity, 0),
  100
);
assert.ok(extraAccountingRow.every((line) => line.identityStatus === "ambiguous"));

const repeatedIdentical = normalizePoToReconciliationLines([
  transferRow({ sourceLineKey: 101, orderLine: 1 }),
  transferRow({ sourceLineKey: 102, orderLine: 1 }),
  transferRow({ sourceLineKey: 103, orderLine: 2 }),
  transferRow({ sourceLineKey: 104, orderLine: 2 }),
  transferRow({ sourceLineKey: 201, orderLine: 1, stage: "receiving" }),
  transferRow({ sourceLineKey: 202, orderLine: 1, stage: "receiving" }),
  transferRow({ sourceLineKey: 203, orderLine: 2, stage: "receiving" }),
  transferRow({ sourceLineKey: 204, orderLine: 2, stage: "receiving" })
], "TO");

assert.equal(repeatedIdentical.length, 4, "Two legitimate identical TO lines must remain two logical lines per stage.");
const outbound = repeatedIdentical.filter((line) => line.stage === "outbound");
assert.equal(outbound.reduce((sum, line) => sum + line.quantity, 0), 200, "TO mirror rows must not double ordered quantity.");
assert.deepEqual(outbound[0].sourceLineAliases, ["101", "102"]);
assert.deepEqual(outbound[1].sourceLineAliases, ["103", "104"]);
assert.ok(outbound.every((line) => line.identityStatus === "exact"));

const inferredPair = normalizePoToReconciliationLines([
  transferRow({ sourceLineKey: 301, orderLine: 10 }),
  transferRow({ sourceLineKey: 302, orderLine: 11 })
], "TO");
assert.equal(inferredPair.length, 1, "Equal mirror values without shared line identity should count once.");
assert.equal(inferredPair[0].quantity, 100);
assert.equal(inferredPair[0].identityStatus, "ambiguous", "Inferred mirror pairing must force reconciliation review.");
assert.match(inferredPair[0].identityIssue, /paired by equal line values/i);
assert.deepEqual(
  scmReconciliationLineIdentityIssues(inferredPair),
  [inferredPair[0].identityIssue],
  "An ambiguous mirror identity must become a reconciliation review reason."
);

const progressMismatch = normalizePoToReconciliationLines([
  transferRow({ sourceLineKey: 401, orderLine: 20, progress: 10 }),
  transferRow({ sourceLineKey: 402, orderLine: 20, progress: 30 })
], "TO");
assert.equal(progressMismatch.length, 1);
assert.equal(progressMismatch[0].cumulativeProgressQuantity, 30, "Mirror progress must use the authoritative maximum, never sum.");
assert.equal(progressMismatch[0].identityStatus, "ambiguous");

const unpaired = normalizePoToReconciliationLines([
  transferRow({ sourceLineKey: 501, orderLine: 30 })
], "TO");
assert.equal(unpaired.length, 1);
assert.equal(unpaired[0].quantity, 100);
assert.equal(unpaired[0].identityStatus, "ambiguous");
assert.match(unpaired[0].identityIssue, /no exact/i);

const purchaseLines = normalizePoToReconciliationLines([
  transferRow({ sourceLineKey: 601, orderLine: 1, stage: "receiving" }),
  transferRow({ sourceLineKey: 602, orderLine: 2, stage: "receiving" })
], "PO");
assert.equal(purchaseLines.length, 2, "PO lines must never be mirror-collapsed.");
assert.ok(purchaseLines.every((line) => line.identityStatus === "exact"));

const linked = normalizePoToLinkedTransactionRows([
  {
    sourceOrderId: 99,
    transactionType: "IR",
    transactionId: 1001,
    transactionLineKey: "9001",
    sourceOrderLine: 1,
    sourceLineKey: "101",
    itemId: 700,
    quantity: 100,
    raw: {}
  },
  {
    sourceOrderId: 99,
    transactionType: "IR",
    transactionId: 1001,
    transactionLineKey: "9001",
    sourceOrderLine: 1,
    sourceLineKey: "102",
    itemId: 700,
    quantity: 100,
    raw: {}
  }
]);
assert.equal(linked.length, 1, "A mirrored source join must produce one IF/IR snapshot line.");
assert.deepEqual(linked[0].sourceLineAliases, ["101", "102"]);
assert.equal(linked[0].quantity, 100, "Mirrored source joins must not double IF/IR progress.");
assert.equal(linked[0].sourceIdentityIssue, "");

const ambiguousLinkedSource = normalizePoToLinkedTransactionRows([
  {
    ...linked[0],
    sourceLineKey: "101",
    sourceOrderLine: 1,
    sourceLineAliases: undefined,
    sourceOrderLineAliases: undefined
  },
  {
    ...linked[0],
    sourceLineKey: "201",
    sourceOrderLine: 2,
    sourceLineAliases: undefined,
    sourceOrderLineAliases: undefined
  }
]);
assert.match(
  ambiguousLinkedSource[0].sourceIdentityIssue,
  /more than one Transfer Order line number/i,
  "A linked event line spanning distinct TO line numbers must force review."
);

const aliasMatch = matchCurrentProgress({
  kind: "TO",
  lines: [outbound[0]]
}, {
  rows: [{
    transaction_type: "IF",
    netsuite_transaction_id: 1002,
    netsuite_line_key: "9002",
    source_order_line_key: "102",
    quantity: 40
  }]
});
assert.equal(aliasMatch.unmatched.length, 0, "IF/IR source keys must match every physical mirror alias.");
assert.equal(
  aliasMatch.lineProgress.get(`outbound:${outbound[0].sourceLineKey}`).fulfilled,
  40
);

const liveProgressMatch = matchCurrentProgress({
  kind: "TO",
  lines: liveTransferTriplets
}, {
  rows: [
    {
      transaction_type: "IF",
      netsuite_transaction_id: 2001,
      netsuite_line_key: "9101",
      source_order_line_key: "702",
      quantity: 20
    },
    {
      transaction_type: "IF",
      netsuite_transaction_id: 2002,
      netsuite_line_key: "9102",
      source_order_line_key: "702",
      quantity: 40
    },
    {
      transaction_type: "IR",
      netsuite_transaction_id: 2003,
      netsuite_line_key: "9201",
      source_order_line_key: "703",
      quantity: 40
    }
  ]
});
assert.equal(liveProgressMatch.unmatched.length, 0);
assert.equal(
  liveProgressMatch.lineProgress.get(`outbound:${liveOutbound[0].sourceLineKey}`).fulfilled,
  60,
  "Multiple IFs for one item must add across unique event lines."
);
assert.equal(
  liveProgressMatch.lineProgress.get(`receiving:${liveReceiving[0].sourceLineKey}`).received,
  40
);

const conflictingLinked = normalizePoToLinkedTransactionRows([
  { ...linked[0], sourceLineKey: "101", sourceLineAliases: undefined, quantity: 100 },
  { ...linked[0], sourceLineKey: "102", sourceLineAliases: undefined, quantity: 90 }
]);
assert.match(conflictingLinked[0].sourceIdentityIssue, /conflicting/i);

console.log("NetSuite reconciliation line normalization harness passed.");

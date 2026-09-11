import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  allocateScmReceiptRowsBySplitReference,
  extractScmSplitReferences,
  resolveScmReceiptSplitReference
} from "../../../src/scm-ir-split-reference.js";

const targets = [
  {
    targetOrderRef: "SN1398749",
    targetOrderRefAliases: ["sn1398749 (L1)"],
    targetKind: "po_split",
    requestedQty: 25
  },
  {
    targetOrderRef: "SN1399520",
    targetKind: "po_split",
    requestedQty: 22
  },
  {
    targetOrderRef: "POB03658",
    targetKind: "source_residual",
    requestedQty: 100,
    isParent: true
  }
];

test("IR memo parsing recognizes one normalized split reference without treating notes as a second reference", () => {
  assert.deepEqual(extractScmSplitReferences("  sn 1398749 (for pallet)  "), ["SN1398749"]);
  assert.deepEqual(extractScmSplitReferences("SN1398749 / sn1398749"), ["SN1398749"]);
  assert.deepEqual(extractScmSplitReferences("ordinary receiving memo"), []);
});

test("a receipt reference resolves to exactly one active target and rejects unknown or ambiguous evidence", () => {
  assert.deepEqual(
    resolveScmReceiptSplitReference({ transactionMemo: "SN1398749 (for pallet)", targets }),
    {
      status: "matched",
      reference: "SN1398749",
      targetIndex: 0,
      targetOrderRef: "SN1398749"
    }
  );
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "receiving", targets }).status, "absent");
  assert.equal(resolveScmReceiptSplitReference({ transactionMemo: "SN9999999", targets }).status, "unmatched");
  assert.equal(
    resolveScmReceiptSplitReference({ transactionMemo: "SN1398749 and SN1399520", targets }).status,
    "ambiguous"
  );
  assert.equal(resolveScmReceiptSplitReference({
    transactionMemo: "SN1398749",
    targets: [targets[0], { ...targets[1], targetOrderRefAliases: ["SN1398749"] }]
  }).status, "ambiguous");
});

test("referenced receipt rows allocate only to the named child and fail closed on excess or foreign references", () => {
  const allocated = allocateScmReceiptRowsBySplitReference({
    totalReceivedQty: 30,
    targets,
    receiptRows: [
      { transactionMemo: "SN1398749", transactionRef: "IR1", quantity: 20 },
      { transactionMemo: "SN1399520", transactionRef: "IR2", quantity: 10 }
    ]
  });
  assert.deepEqual(allocated.allocations, [20, 10, 0]);
  assert.equal(allocated.remainingTotalQty, 0);
  assert.equal(allocated.referenceOverflowQty, 0);
  assert.deepEqual(allocated.unexplainedReferences, []);

  const rejected = allocateScmReceiptRowsBySplitReference({
    totalReceivedQty: 30,
    targets,
    receiptRows: [
      { transactionMemo: "SN1398749", transactionRef: "IR3", quantity: 30 },
      { transactionMemo: "SN8888888", transactionRef: "IR4", quantity: 5 }
    ]
  });
  assert.deepEqual(rejected.allocations, [25, 0, 0]);
  assert.equal(rejected.referenceOverflowQty, 5);
  assert.equal(rejected.unexplainedReferences.length, 1);
  assert.match(rejected.unexplainedReferences[0].reason, /capacity/i);
});

test("IR rows without a split reference remain available to the existing destination allocator", () => {
  const result = allocateScmReceiptRowsBySplitReference({
    totalReceivedQty: 12,
    targets,
    receiptRows: [
      { transactionMemo: "receiving", transactionRef: "IR5", quantity: 7 },
      { transactionMemo: "", transactionRef: "IR6", quantity: 5 }
    ]
  });
  assert.deepEqual(result.allocations, [0, 0, 0]);
  assert.equal(result.remainingTotalQty, 12);
  assert.equal(result.remainingReceiptRows.length, 2);
  assert.equal(result.referencedRowCount, 0);
});

test("historical non-SN aliases are matched literally from older nested memo snapshots", () => {
  const historicalTargets = [{
    targetOrderRef: "SN1398749",
    targetOrderRefAliases: ["3022.019(914)"],
    targetKind: "po_split",
    requestedQty: 1200
  }];
  assert.equal(resolveScmReceiptSplitReference({
    transactionMemo: "Unload for 3022.019(914)",
    targets: historicalTargets
  }).status, "matched");
  assert.equal(resolveScmReceiptSplitReference({
    transactionMemo: "X3022.019(914)Y",
    targets: historicalTargets
  }).status, "absent");

  const allocated = allocateScmReceiptRowsBySplitReference({
    totalReceivedQty: "1,200",
    targets: historicalTargets,
    receiptRows: [{
      quantity: "1,200",
      snapshot: { raw: { transaction_memo: "3022.019(914)" } }
    }]
  });
  assert.deepEqual(allocated.allocations, [1200]);
  assert.equal(allocated.remainingTotalQty, 0);

  assert.deepEqual(allocateScmReceiptRowsBySplitReference({
    totalReceivedQty: -4,
    targets: null,
    receiptRows: null
  }).allocations, []);
});

test("NetSuite linked-transaction query projects the Item Receipt memo", () => {
  const source = fs.readFileSync(new URL("../../../src/netsuite.js", import.meta.url), "utf8");
  assert.match(source, /event_t\.memo\s+AS\s+transaction_memo/i);
  assert.match(source, /transactionMemo:\s*row\.transaction_memo/);
});

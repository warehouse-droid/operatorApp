import assert from "node:assert/strict";
import test from "node:test";

import {
  isOrderOpenAfterApproval,
  isPendingApprovalStatus,
  reconcilePendingApprovalOrders
} from "../../../src/pending-approval-reconciliation.js";

test("PA-1: only Pending Approval and Pending Supervisor Approval are in scope", () => {
  assert.equal(isPendingApprovalStatus({ status: "A", statusText: "Pending Approval" }), true);
  assert.equal(isPendingApprovalStatus({ status: "", statusText: "Purchase Order : Pending Supervisor Approval" }), true);
  assert.equal(isPendingApprovalStatus({ status: "B", statusText: "Pending Fulfillment" }), false);
  assert.equal(isPendingApprovalStatus({ status: "G", statusText: "Billed" }), false);
  assert.equal(isPendingApprovalStatus({ status: "H", statusText: "Closed" }), false);
  assert.equal(isPendingApprovalStatus({ status: "B", statusText: "Not Pending Approval" }), false);
  assert.equal(isPendingApprovalStatus({ status: "B", statusText: "Pending Approval - Closed" }), false);
});

test("PA-2: open-order classification is type-specific and terminal statuses fail closed", () => {
  assert.equal(isOrderOpenAfterApproval("sales_order", { status: "B", statusText: "Pending Fulfillment" }), true);
  assert.equal(isOrderOpenAfterApproval("sales_order", { status: "E", statusText: "Pending Billing/Partially Fulfilled" }), true);
  assert.equal(isOrderOpenAfterApproval("purchase_order", { status: "B", statusText: "Pending Receipt" }), true);
  assert.equal(isOrderOpenAfterApproval("transfer_order", { status: "B", statusText: "Pending Fulfillment" }), true);
  assert.equal(isOrderOpenAfterApproval("sales_order", { status: "H", statusText: "Closed" }), false);
  assert.equal(isOrderOpenAfterApproval("custom_order", { status: "B", statusText: "Pending Fulfillment" }), false);
  assert.equal(isOrderOpenAfterApproval("custom_order", { status: "C", statusText: "Pending Fulfillment" }), false);
});

test("PA-3: reconciliation fetches and updates only claimed Pending Approval rows", async () => {
  const applied = [];
  const fetches = [];
  const audits = [];
  const result = await reconcilePendingApprovalOrders({
    listCandidates: async () => ({
      sales_order: [
        { netsuiteId: 1, tranid: "SO1", status: "A", statusText: "Pending Approval" },
        { netsuiteId: 2, tranid: "SO2", status: "B", statusText: "Pending Fulfillment" }
      ],
      purchase_order: [
        { netsuiteId: 3, tranid: "PO3", status: "A", statusText: "Pending Supervisor Approval" }
      ],
      transfer_order: []
    }),
    fetchStatuses: async ({ orderType, ids }) => {
      fetches.push({ orderType, ids });
      if (orderType === "sales_order") {return [{ id: 1, status: "B", status_text: "Sales Order : Pending Fulfillment" }];}
      return [{ id: 3, status: "A", status_text: "Purchase Order : Pending Supervisor Approval" }];
    },
    applyIfStillPending: async (change) => {
      applied.push(change);
      return { ...change };
    },
    writeAudit: async (event) => audits.push(event)
  });

  assert.deepEqual(fetches, [
    { orderType: "sales_order", ids: [1] },
    { orderType: "purchase_order", ids: [3] }
  ]);
  assert.deepEqual(applied.map((row) => row.netsuiteId), [1, 3]);
  assert.equal(applied[0].netsuiteActive, true);
  assert.equal(applied[1].netsuiteActive, false);
  assert.equal(result.totals.claimed, 2);
  assert.equal(result.totals.updated, 2);
  assert.equal(result.totals.transitioned, 1);
  assert.equal(Object.hasOwn(result.totals, "distribution"), false);
  assert.equal(audits.at(-1).action, "netsuite.pending_approval_status_reconcile");
});

test("PA-4: missing NetSuite rows and concurrent local changes are not overwritten", async () => {
  const applied = [];
  const result = await reconcilePendingApprovalOrders({
    listCandidates: async () => ({
      sales_order: [
        { netsuiteId: 10, tranid: "SO10", status: "A", statusText: "Pending Approval" },
        { netsuiteId: 11, tranid: "SO11", status: "A", statusText: "Pending Approval" }
      ],
      purchase_order: [],
      transfer_order: []
    }),
    fetchStatuses: async () => [{ id: 10, status: "B", status_text: "Pending Fulfillment" }],
    applyIfStillPending: async (change) => {
      applied.push(change);
      return null;
    },
    writeAudit: async () => {}
  });
  assert.deepEqual(applied.map((row) => row.netsuiteId), [10]);
  assert.equal(result.totals.missing, 1);
  assert.equal(result.totals.concurrentSkipped, 1);
  assert.equal(result.totals.updated, 0);
});

test("PA-5: a failed order family is audited and does not prevent other families", async () => {
  const applied = [];
  const result = await reconcilePendingApprovalOrders({
    listCandidates: async () => ({
      sales_order: [{ netsuiteId: 1, tranid: "SO1", status: "A", statusText: "Pending Approval" }],
      purchase_order: [{ netsuiteId: 2, tranid: "PO2", status: "A", statusText: "Pending Supervisor Approval" }],
      transfer_order: []
    }),
    fetchStatuses: async ({ orderType }) => {
      if (orderType === "sales_order") {throw new Error("NetSuite temporarily unavailable");}
      return [{ id: 2, status: "A", status_text: "Pending Supervisor Approval" }];
    },
    applyIfStillPending: async (change) => {
      applied.push(change);
      return change;
    },
    writeAudit: async () => {}
  });
  assert.deepEqual(applied.map((row) => row.netsuiteId), [2]);
  assert.equal(result.salesOrders.failed, 1);
  assert.equal(result.purchaseOrders.updated, 1);
  assert.match(result.failures[0].error, /temporarily unavailable/i);
});

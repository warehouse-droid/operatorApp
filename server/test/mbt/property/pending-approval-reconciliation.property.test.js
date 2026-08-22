import assert from "node:assert/strict";
import test from "node:test";

import { isPendingApprovalStatus, reconcilePendingApprovalOrders } from "../../../src/pending-approval-reconciliation.js";

test("PA-P1: 320 mixed local statuses never fetch or mutate a non-Pending-Approval order", async () => {
  const statusCases = [
    ["A", "Pending Approval"],
    ["A", "Purchase Order : Pending Supervisor Approval"],
    ["B", "Pending Fulfillment"],
    ["E", "Pending Billing/Partially Fulfilled"],
    ["F", "Pending Billing"],
    ["G", "Billed"],
    ["H", "Closed"],
    ["C", "Cancelled"]
  ];
  const rows = Array.from({ length: 320 }, (_, index) => {
    const [status, statusText] = statusCases[index % statusCases.length];
    return { netsuiteId: index + 1, tranid: `SO${index + 1}`, status, statusText };
  });
  const expected = rows.filter(isPendingApprovalStatus).map((row) => row.netsuiteId);
  const fetched = [];
  const applied = [];
  await reconcilePendingApprovalOrders({
    listCandidates: async () => ({ sales_order: rows, purchase_order: [], transfer_order: [] }),
    fetchStatuses: async ({ ids }) => {
      fetched.push(...ids);
      return ids.map((id) => ({ id, status: "B", status_text: "Pending Fulfillment" }));
    },
    applyIfStillPending: async (change) => {
      applied.push(change.netsuiteId);
      return change;
    },
    writeAudit: async () => {}
  });
  assert.deepEqual(fetched, expected);
  assert.deepEqual(applied, expected);
});

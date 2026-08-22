import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  applyPendingApprovalStatusIfStillPending,
  listPendingApprovalCandidates
} from "../../../src/pending-approval-reconciliation-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

function identity(offset) {
  const suffix = Number.parseInt(crypto.randomBytes(4).toString("hex"), 16) % 500_000;
  return 9_970_000_000 + suffix + offset;
}

test("PA-R1: candidate query returns only locally Pending Approval SO/PO/TO rows", async () => {
  await inRollback(async () => {
    const soPending = identity(1);
    const soOpen = identity(2);
    const soFalsePositive = identity(5);
    const poPending = identity(3);
    const toPending = identity(4);
    await query(
      `INSERT INTO sales_orders (netsuite_id, tranid, status, status_text, netsuite_active, synced_at)
       VALUES ($1, 'M2M-SO-PENDING', 'A', 'Sales Order : Pending Approval', false, now()),
              ($2, 'M2M-SO-OPEN', 'B', 'Sales Order : Pending Fulfillment', true, now()),
              ($3, 'M2M-SO-NOT-PENDING', 'B', 'Not Pending Approval', true, now())`,
      [soPending, soOpen, soFalsePositive]
    );
    await query(
      `INSERT INTO purchase_orders (netsuite_id, tranid, status, status_text, netsuite_active, synced_at)
       VALUES ($1, 'M2M-PO-PENDING', 'A', 'Purchase Order : Pending Supervisor Approval', false, now())`,
      [poPending]
    );
    await query(
      `INSERT INTO transfer_orders (netsuite_id, tranid, status, status_text, netsuite_active, synced_at)
       VALUES ($1, 'M2M-TO-PENDING', 'A', 'Transfer Order : Pending Approval', false, now())`,
      [toPending]
    );

    const listed = await listPendingApprovalCandidates();
    assert.deepEqual(
      listed.sales_order.filter((row) => [soPending, soOpen, soFalsePositive].includes(Number(row.netsuiteId))).map((row) => Number(row.netsuiteId)),
      [soPending]
    );
    assert.deepEqual(
      listed.purchase_order.filter((row) => Number(row.netsuiteId) === poPending).map((row) => Number(row.netsuiteId)),
      [poPending]
    );
    assert.deepEqual(
      listed.transfer_order.filter((row) => Number(row.netsuiteId) === toPending).map((row) => Number(row.netsuiteId)),
      [toPending]
    );
  });
});

test("PA-R2: conditional update changes status classification only while the row is still Pending Approval", async () => {
  await inRollback(async () => {
    const orderId = identity(10);
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, status, status_text, netsuite_active, synced_at,
         dispatch_address, dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
         dispatch_load_name, operator_status, local_yard_order_status
       ) VALUES (
         $1, 'M2M-SO-UPDATE', 'A', 'Pending Approval', false, now() - interval '1 day',
         'Keep this address', true, '2026-08-15', 'TRUCK-1',
         'Load 7', 'packed', 'Packed'
       )`,
      [orderId]
    );
    const before = (await query(
      `SELECT dispatch_address, dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
              dispatch_load_name, operator_status, local_yard_order_status
         FROM sales_orders WHERE netsuite_id = $1`,
      [orderId]
    )).rows[0];

    const updated = await applyPendingApprovalStatusIfStillPending({
      orderType: "sales_order",
      netsuiteId: orderId,
      status: "B",
      statusText: "Sales Order : Pending Fulfillment",
      netsuiteActive: true
    });
    assert.equal(updated.netsuiteId, String(orderId));
    assert.equal(updated.status, "B");
    assert.equal(updated.statusText, "Sales Order : Pending Fulfillment");
    assert.equal(updated.netsuiteActive, true);
    const afterState = (await query(
      `SELECT dispatch_address, dispatch_planned, dispatch_plan_date, dispatch_truck_plate,
              dispatch_load_name, operator_status, local_yard_order_status
         FROM sales_orders WHERE netsuite_id = $1`,
      [orderId]
    )).rows[0];
    assert.deepEqual(afterState, before);

    const stale = await applyPendingApprovalStatusIfStillPending({
      orderType: "sales_order",
      netsuiteId: orderId,
      status: "H",
      statusText: "Sales Order : Closed",
      netsuiteActive: false
    });
    assert.equal(stale, null);
    const status = (await query(
      "SELECT status, status_text FROM sales_orders WHERE netsuite_id = $1",
      [orderId]
    )).rows[0];
    assert.deepEqual(status, { status: "B", status_text: "Sales Order : Pending Fulfillment" });
  });
});

test("PA-R3: invalid order families and identifiers fail closed before mutation", async () => {
  await assert.rejects(
    () => applyPendingApprovalStatusIfStillPending({
      orderType: "sales_orders; DROP TABLE sales_orders",
      netsuiteId: 1,
      status: "B",
      statusText: "Pending Fulfillment",
      netsuiteActive: true
    }),
    /order type/i
  );
  await assert.rejects(
    () => applyPendingApprovalStatusIfStillPending({
      orderType: "sales_order",
      netsuiteId: "not-a-number",
      status: "B",
      statusText: "Pending Fulfillment",
      netsuiteActive: true
    }),
    /numeric/i
  );
});

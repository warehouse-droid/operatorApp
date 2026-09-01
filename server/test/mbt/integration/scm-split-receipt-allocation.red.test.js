import assert from "node:assert/strict";
import test from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  reconcileScmOrderFamily,
  storeLinkedScmReconciliationTransactions
} from "../../../src/scm-reconciliation-repository.js";
import { listScmSchedule } from "../../../src/dispatch-repository.js";

test.after(async () => {
  await closeDb();
});

const seed = Number(String(Date.now()).slice(-7));
const actor = `split-receipt-${seed}`;

function linkedReceipt({
  sourceOrderId,
  sourceOrderRef,
  sourceLineKey,
  transactionId,
  transactionLineKey,
  itemId,
  itemName,
  quantity,
  locationId
}) {
  return {
    sourceOrderId,
    sourceOrderRef,
    sourceOrderLine: sourceLineKey,
    sourceLineKey: String(sourceLineKey),
    transactionId,
    transactionType: "ItemRcpt",
    transactionRef: `IR-${transactionId}`,
    status: "B",
    statusText: "Posted",
    transactionDate: "2026-08-27",
    lastModifiedAt: "2026-08-27T05:00:00.000Z",
    transactionLine: transactionLineKey,
    transactionLineKey: String(transactionLineKey),
    itemId,
    itemName,
    quantity,
    unit: "EA",
    locationId,
    location: `Yard ${locationId}`
  };
}

async function seedFamily({
  suffix,
  receiptLocationId,
  materialReceiptQty = 1569,
  palletReceiptQty = 15,
  scheduleStatus = "Planned"
}) {
  const parentId = 8_700_000_000 + seed + suffix;
  const parentRef = `PO-SPLIT-RECEIPT-${seed}-${suffix}`;
  const childId = -parentId;
  const childRef = suffix === 10 ? "3022019914" : `3022019914-WITNESS-${seed}-${suffix}`;
  const materialLineKey = 7_100_000_000 + seed + suffix;
  const palletLineKey = materialLineKey + 1;

  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, status, status_text,
       vendor_id, vendor, destination_location_id, destination_location,
       receipt_status, netsuite_active, synced_at
     ) VALUES
       ($1, $2, DATE '2026-08-27', 'B', 'Pending Receipt',
        5001, 'Split Vendor', 1, '3445', 'not_received', true, now()),
       ($3, $4, DATE '2026-08-27', 'B', 'Pending Receipt',
        5001, 'Split Vendor', 15, '12441', 'not_received', true, now())`,
    [parentId, parentRef, childId, childRef]
  );
  const lines = await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity,
       netsuite_received_qty, unit, location_id, location, netsuite_active,
       raw
     ) VALUES
       ($1, $2, 920001, 'Split material', 'SPLIT-MATERIAL', 1569,
        0, 'EA', 1, '3445', true, $7::jsonb),
       ($1, $3, 920002, 'PALLET', 'PALLET', 15,
        0, 'EA', 1, '3445', true, $8::jsonb),
       ($4, $5, 920001, 'Split material', 'SPLIT-MATERIAL', 1569,
        0, 'EA', 15, '12441', true, $9::jsonb),
       ($4, $6, 920002, 'PALLET', 'PALLET', 15,
        0, 'EA', 15, '12441', true, $10::jsonb)
     RETURNING id, purchase_order_id, line_id`,
    [
      parentId,
      materialLineKey,
      palletLineKey,
      childId,
      -materialLineKey,
      -palletLineKey,
      JSON.stringify({
        sourceLineAliases: [String(materialLineKey)],
        orderLine: String(materialLineKey),
        orderLineAliases: [String(materialLineKey)],
        identityStatus: "exact"
      }),
      JSON.stringify({
        sourceLineAliases: [String(palletLineKey)],
        orderLine: String(palletLineKey),
        orderLineAliases: [String(palletLineKey)],
        identityStatus: "exact"
      }),
      JSON.stringify({ identityStatus: "exact" }),
      JSON.stringify({ identityStatus: "exact" })
    ]
  );
  const lineId = (purchaseOrderId, lineKey) => Number(lines.rows.find((row) =>
    Number(row.purchase_order_id) === purchaseOrderId
    && Number(row.line_id) === lineKey
  ).id);
  const split = await query(
    `INSERT INTO dispatch_scm_po_splits (
       source_po_id, source_po_ref, split_po_id, split_po_ref,
       status, created_by
     ) VALUES ($1, $2, $3, $4, 'active', $5)
     RETURNING id`,
    [parentId, parentRef, childId, childRef, actor]
  );
  await query(
    `INSERT INTO dispatch_scm_po_split_lines (
       split_id, source_line_id, split_line_id, item_id, sku, item_name,
       sales_qty, requested_sales_qty, unit
     ) VALUES
       ($1, $2, $3, 920001, 'SPLIT-MATERIAL', 'Split material', 1569, 1569, 'EA'),
       ($1, $4, $5, 920002, 'PALLET', 'PALLET', 15, 15, 'EA')`,
    [
      Number(split.rows[0].id),
      lineId(parentId, materialLineKey),
      lineId(childId, -materialLineKey),
      lineId(parentId, palletLineKey),
      lineId(childId, -palletLineKey)
    ]
  );
  await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, source_table, source_id, order_ref, status, eta_date,
       created_by, updated_by
     ) VALUES ('PO', 'purchase_orders', $1, $2, $3,
               DATE '2026-08-27', $4, $4)`,
    [childId, childRef, scheduleStatus, actor]
  );
  const order = {
    kind: "PO",
    id: parentId,
    tranid: parentRef,
    destinationLocationId: 1,
    destinationLocation: "3445"
  };
  await storeLinkedScmReconciliationTransactions({
    order,
    source: "manual",
    transactions: [
      linkedReceipt({
        sourceOrderId: parentId,
        sourceOrderRef: parentRef,
        sourceLineKey: materialLineKey,
        transactionId: 6_100_000_000 + seed + suffix,
        transactionLineKey: 6_110_000_000 + seed + suffix,
        itemId: 920001,
        itemName: "Split material",
        quantity: materialReceiptQty,
        locationId: receiptLocationId
      }),
      linkedReceipt({
        sourceOrderId: parentId,
        sourceOrderRef: parentRef,
        sourceLineKey: palletLineKey,
        transactionId: 6_100_000_000 + seed + suffix,
        transactionLineKey: 6_120_000_000 + seed + suffix,
        itemId: 920002,
        itemName: "PALLET",
        quantity: palletReceiptQty,
        locationId: receiptLocationId
      })
    ].filter((transaction) => Number(transaction.quantity) > 0)
  });
  return { parentId, childRef };
}

test("split receipt calculation uses child destination and rejects only genuine wrong-yard quantity", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const valid = await seedFamily({ suffix: 10, receiptLocationId: 15 });
      const validResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: valid.parentId,
        source: "manual"
      });
      assert.equal(validResult.reconciliationStatus, "ok");
      assert.equal(validResult.applicationStatus, "Completed");
      assert.deepEqual(
        {
          ordered: validResult.targets[valid.childRef].ordered,
          received: validResult.targets[valid.childRef].received,
          remaining: validResult.targets[valid.childRef].remaining,
          status: validResult.targets[valid.childRef].applicationStatus
        },
        { ordered: 1584, received: 1584, remaining: 0, status: "Completed" }
      );
      assert.doesNotMatch(validResult.reason, /location|destination/i);

      const validSchedule = await query(
        `SELECT reconciliation_blocked
           FROM scm_transport_schedule
          WHERE order_kind = 'PO' AND order_ref = $1`,
        [valid.childRef]
      );
      assert.equal(validSchedule.rows[0].reconciliation_blocked, false);

      const wrong = await seedFamily({ suffix: 20, receiptLocationId: 2 });
      const wrongResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: wrong.parentId,
        source: "manual"
      });
      assert.equal(wrongResult.reconciliationStatus, "review");
      assert.match(wrongResult.reason, /location|destination|capacity/i);
      assert.equal(wrongResult.targets[wrong.childRef].applicationStatus, "Reconcile Review");
    });
  } finally {
    await rollback.rollback();
  }
});

test("inferred partial receipt cannot promote a planned child or regress a completed child", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const planned = await seedFamily({
        suffix: 30,
        receiptLocationId: 15,
        materialReceiptQty: 500,
        palletReceiptQty: 0,
        scheduleStatus: "Planned"
      });
      const plannedResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: planned.parentId,
        source: "manual"
      });
      assert.equal(plannedResult.targets[planned.childRef].received, 500);
      assert.deepEqual(plannedResult.targets[planned.childRef].allocationMethods, ["inferred"]);
      assert.equal(plannedResult.targets[planned.childRef].evidencedReceived, 0);
      assert.equal(plannedResult.targets[planned.childRef].applicationStatus, "Planned");

      const completed = await seedFamily({
        suffix: 40,
        receiptLocationId: 15,
        materialReceiptQty: 500,
        palletReceiptQty: 0,
        scheduleStatus: "Completed"
      });
      const completedResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: completed.parentId,
        source: "manual"
      });
      assert.equal(completedResult.targets[completed.childRef].received, 500);
      assert.equal(completedResult.targets[completed.childRef].applicationStatus, "Completed");
      assert.equal(completedResult.targets[completed.childRef].reconciliationStatus, "ok");

      const completedState = await query(
        `SELECT id, quantity_summary
           FROM scm_reconciliation_order_state
          WHERE order_kind = 'PO' AND source_order_netsuite_id = $1`,
        [completed.parentId]
      );
      const staleSummary = structuredClone(completedState.rows[0].quantity_summary);
      staleSummary.targets[completed.childRef].applicationStatus = "Partially Done";
      await query(
        `UPDATE scm_reconciliation_order_state
            SET application_status = 'Partially Done',
                quantity_summary = $2::jsonb,
                reconciled_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [completedState.rows[0].id, JSON.stringify(staleSummary)]
      );
      await query(
        `UPDATE scm_transport_schedule
            SET status = 'Completed',
                reconciliation_blocked = true,
                updated_at = now() - interval '1 hour'
          WHERE order_kind = 'PO' AND order_ref = $1`,
        [completed.childRef]
      );

      const replayedCompleted = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: completed.parentId,
        source: "manual"
      });
      assert.equal(replayedCompleted.targets[completed.childRef].applicationStatus, "Completed",
        "an older saved local Completed status must survive a newer inferred reconciliation target");

      await query(
        `UPDATE scm_transport_schedule
            SET reconciliation_blocked = true
          WHERE order_kind = 'PO' AND order_ref = $1`,
        [completed.childRef]
      );
      const projected = await listScmSchedule({
        search: completed.childRef,
        kind: "PO",
        status: ["Completed"],
        audience: "scm"
      });
      const projectedCompleted = projected.find((row) => row.orderRef === completed.childRef);
      assert.equal(projectedCompleted?.calculatedStatus, "Completed",
        "local Completed must remain the displayed status while review stays metadata");
    });
  } finally {
    await rollback.rollback();
  }
});

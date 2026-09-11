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
  locationId,
  transactionMemo = ""
}) {
  return {
    sourceOrderId,
    sourceOrderRef,
    sourceOrderLine: sourceLineKey,
    sourceLineKey: String(sourceLineKey),
    transactionId,
    transactionType: "ItemRcpt",
    transactionRef: `IR-${transactionId}`,
    transactionMemo,
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
  splitMaterialQty = 1569,
  scheduleStatus = "Planned",
  receiptMemo = "",
  separatePalletReceipt = false,
  isBlanket = false
}) {
  const parentId = 8_700_000_000 + seed + suffix;
  const parentRef = `PO-SPLIT-RECEIPT-${seed}-${suffix}`;
  const childId = -parentId;
  const childRef = suffix === 10 ? "3022019914" : `3022019914-WITNESS-${seed}-${suffix}`;
  const transactionMemo = receiptMemo === "$child" ? childRef : receiptMemo;
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
  if (isBlanket) {
    await query(
      "UPDATE purchase_orders SET is_blanket_po = true WHERE netsuite_id = $1",
      [parentId]
    );
  }
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
       ($4, $5, 920001, 'Split material', 'SPLIT-MATERIAL', $11,
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
      JSON.stringify({ identityStatus: "exact" }),
      splitMaterialQty
    ]
  );
  const lineId = (purchaseOrderId, lineKey) => Number(lines.rows.find((row) =>
    Number(row.purchase_order_id) === purchaseOrderId
    && Number(row.line_id) === lineKey
  ).id);
  const split = await query(
    `INSERT INTO dispatch_scm_po_splits (
       source_po_id, source_po_ref, split_po_id, split_po_ref,
       status, created_by, created_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, TIMESTAMPTZ '2026-08-26 00:00:00+00')
     RETURNING id`,
    [parentId, parentRef, childId, childRef, actor]
  );
  await query(
    `INSERT INTO dispatch_scm_po_split_lines (
       split_id, source_line_id, split_line_id, item_id, sku, item_name,
       sales_qty, requested_sales_qty, unit
     ) VALUES
       ($1, $2, $3, 920001, 'SPLIT-MATERIAL', 'Split material', $6, $6, 'EA'),
       ($1, $4, $5, 920002, 'PALLET', 'PALLET', 15, 15, 'EA')`,
    [
      Number(split.rows[0].id),
      lineId(parentId, materialLineKey),
      lineId(childId, -materialLineKey),
      lineId(parentId, palletLineKey),
      lineId(childId, -palletLineKey),
      splitMaterialQty
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
        locationId: receiptLocationId,
        transactionMemo
      }),
      linkedReceipt({
        sourceOrderId: parentId,
        sourceOrderRef: parentRef,
        sourceLineKey: palletLineKey,
        transactionId: 6_100_000_000 + seed + suffix + (separatePalletReceipt ? 100_000 : 0),
        transactionLineKey: 6_120_000_000 + seed + suffix,
        itemId: 920002,
        itemName: "PALLET",
        quantity: palletReceiptQty,
        locationId: receiptLocationId,
        transactionMemo
      })
    ].filter((transaction) => Number(transaction.quantity) > 0)
  });
  return { parentId, childRef };
}

test("completed split receipt calculation uses child destination and rejects only genuine wrong-yard quantity", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const valid = await seedFamily({
        suffix: 10,
        receiptLocationId: 15,
        scheduleStatus: "Completed"
      });
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

test("historical inferred receipt reopens an unfinished Partially Done child as Queued", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const planned = await seedFamily({
        suffix: 30,
        receiptLocationId: 1,
        materialReceiptQty: 500,
        palletReceiptQty: 0,
        splitMaterialQty: 500,
        scheduleStatus: "Partially Done"
      });
      const firstResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: planned.parentId,
        source: "manual"
      });
      assert.equal(firstResult.reconciliationStatus, "ok");
      assert.equal(firstResult.targets[planned.childRef].received, 0);
      assert.deepEqual(firstResult.targets[planned.childRef].allocationMethods, []);
      assert.equal(firstResult.targets[planned.childRef].evidencedReceived, 0);
      assert.equal(firstResult.targets[planned.childRef].applicationStatus, "Queued");

      const staleState = await query(
        `SELECT id, quantity_summary
           FROM scm_reconciliation_order_state
          WHERE order_kind = 'PO' AND source_order_netsuite_id = $1`,
        [planned.parentId]
      );
      const staleSummary = structuredClone(staleState.rows[0].quantity_summary);
      staleSummary.targets[planned.childRef] = {
        ...staleSummary.targets[planned.childRef],
        applicationStatus: "Completed",
        reconciliationStatus: "ok",
        received: 515,
        remaining: 0,
        allocationMethods: ["inferred"],
        exactAllocation: false,
        evidencedReceived: 0
      };
      await query(
        `UPDATE scm_reconciliation_order_state
            SET application_status = 'Completed',
                quantity_summary = $2::jsonb,
                reconciled_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [staleState.rows[0].id, JSON.stringify(staleSummary)]
      );

      const corrected = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: planned.parentId,
        source: "manual"
      });
      assert.equal(corrected.reconciliationStatus, "ok");
      assert.deepEqual(
        {
          ordered: corrected.targets[planned.childRef].ordered,
          received: corrected.targets[planned.childRef].received,
          remaining: corrected.targets[planned.childRef].remaining,
          status: corrected.targets[planned.childRef].applicationStatus
        },
        { ordered: 515, received: 0, remaining: 515, status: "Queued" }
      );

      const projectedQueued = await listScmSchedule({
        search: planned.childRef,
        kind: "PO",
        audience: "scm"
      });
      const queuedChild = projectedQueued.find((row) => row.orderRef === planned.childRef);
      assert.equal(queuedChild?.status, "Partially Done",
        "the raw operational observation remains available for audit");
      assert.equal(queuedChild?.calculatedStatus, "Queued",
        "the SCM-facing effective status must correct the stale inferred progress");

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
      const staleCompletedSummary = structuredClone(completedState.rows[0].quantity_summary);
      staleCompletedSummary.targets[completed.childRef].applicationStatus = "Partially Done";
      await query(
        `UPDATE scm_reconciliation_order_state
            SET application_status = 'Partially Done',
                quantity_summary = $2::jsonb,
                reconciled_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [completedState.rows[0].id, JSON.stringify(staleCompletedSummary)]
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
        "an authoritative local Completed status must survive inferred redistribution");

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
        "authoritative Completed must remain displayed while review stays metadata");
    });
  } finally {
    await rollback.rollback();
  }
});

test("IR memo reference overrides a wrong yard, supports a separate pallet IR, and preserves HOLD authority", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const referenced = await seedFamily({
        suffix: 60,
        receiptLocationId: 1,
        scheduleStatus: "Hold",
        receiptMemo: "$child",
        separatePalletReceipt: true
      });
      const before = await query(
        `SELECT po.destination_location_id, po.destination_location, schedule.status
           FROM purchase_orders po
           JOIN scm_transport_schedule schedule
             ON schedule.order_kind = 'PO'
            AND lower(schedule.order_ref) = lower($2)
          WHERE po.netsuite_id = $1`,
        [-referenced.parentId, referenced.childRef]
      );

      const result = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: referenced.parentId,
        source: "manual"
      });
      assert.equal(result.reconciliationStatus, "ok");
      assert.equal(result.targets[referenced.childRef].received, 1584);
      assert.deepEqual(result.targets[referenced.childRef].allocationMethods, ["exact"]);
      assert.equal(result.targets[referenced.childRef].applicationStatus, "Hold");
      assert.doesNotMatch(result.reason, /location|destination|reference|capacity/i);

      const after = await query(
        `SELECT po.destination_location_id, po.destination_location,
                schedule.status, schedule.reconciliation_blocked
           FROM purchase_orders po
           JOIN scm_transport_schedule schedule
             ON schedule.order_kind = 'PO'
            AND lower(schedule.order_ref) = lower($2)
          WHERE po.netsuite_id = $1`,
        [-referenced.parentId, referenced.childRef]
      );
      assert.deepEqual(after.rows[0], {
        ...before.rows[0],
        reconciliation_blocked: false
      });

      const stored = await query(
        `SELECT transaction_memo
           FROM scm_reconciliation_transaction_snapshots
          WHERE source_order_kind = 'PO'
            AND source_order_netsuite_id = $1
          ORDER BY netsuite_transaction_id`,
        [referenced.parentId]
      );
      assert.deepEqual(stored.rows.map((row) => row.transaction_memo), [
        referenced.childRef,
        referenced.childRef
      ]);
    });
  } finally {
    await rollback.rollback();
  }
});

test("BWS blanket IR without a child memo may use one matching destination and preserves HOLD authority", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const blanket = await seedFamily({
        suffix: 65,
        receiptLocationId: 15,
        scheduleStatus: "Hold",
        receiptMemo: "BWS Uxbridge blanket receipt",
        isBlanket: true
      });
      const result = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: blanket.parentId,
        source: "manual"
      });
      assert.equal(result.reconciliationStatus, "ok");
      assert.equal(result.targets[blanket.childRef].received, 1584);
      assert.equal(result.targets[blanket.childRef].applicationStatus, "Hold");
      assert.deepEqual(result.targets[blanket.childRef].allocationMethods, ["inferred"]);
      assert.doesNotMatch(result.reason, /location|destination|reference|capacity/i);
    });
  } finally {
    await rollback.rollback();
  }
});

test("a later PO refresh and new HOLD split do not recycle an old referenced receipt into review", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const original = await seedFamily({
        suffix: 67,
        receiptLocationId: 1,
        materialReceiptQty: 1000,
        palletReceiptQty: 0,
        splitMaterialQty: 1000,
        scheduleStatus: "Hold",
        receiptMemo: "$child"
      });
      const first = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: original.parentId,
        source: "manual"
      });
      assert.equal(first.reconciliationStatus, "ok");
      assert.equal(first.targets[original.childRef].received, 1000);

      const sourceLine = await query(
        `SELECT id, line_id
           FROM purchase_order_lines
          WHERE purchase_order_id = $1
            AND item_id = 920001`,
        [original.parentId]
      );
      const secondChildId = -original.parentId - 1;
      const secondChildRef = `SN${1_500_000 + (seed % 1_000_000)}`;
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, status, status_text,
           vendor_id, vendor, destination_location_id, destination_location,
           receipt_status, initial_scm_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, DATE '2026-09-08', 'B', 'Pending Receipt',
           5001, 'Split Vendor', 28, '150', 'not_received', 'Hold', true, now()
         )`,
        [secondChildId, secondChildRef]
      );
      const childLine = await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, quantity,
           netsuite_received_qty, unit, location_id, location, netsuite_active, raw
         ) VALUES (
           $1, $2, 920001, 'Split material', 'SPLIT-MATERIAL', 569,
           0, 'EA', 28, '150', true, $3::jsonb
         ) RETURNING id`,
        [
          secondChildId,
          -Number(sourceLine.rows[0].line_id) - 1,
          JSON.stringify({ identityStatus: "exact" })
        ]
      );
      const secondSplit = await query(
        `INSERT INTO dispatch_scm_po_splits (
           source_po_id, source_po_ref, split_po_id, split_po_ref,
           status, created_by, created_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, now())
         RETURNING id`,
        [original.parentId, `PO-SPLIT-RECEIPT-${seed}-67`, secondChildId, secondChildRef, actor]
      );
      await query(
        `INSERT INTO dispatch_scm_po_split_lines (
           split_id, source_line_id, split_line_id, item_id, sku, item_name,
           sales_qty, requested_sales_qty, unit
         ) VALUES ($1, $2, $3, 920001, 'SPLIT-MATERIAL', 'Split material', 569, 569, 'EA')`,
        [Number(secondSplit.rows[0].id), Number(sourceLine.rows[0].id), Number(childLine.rows[0].id)]
      );
      await query(
        `INSERT INTO scm_transport_schedule (
           order_kind, source_table, source_id, order_ref, status,
           created_by, updated_by
         ) VALUES ('PO', 'purchase_orders', $1, $2, 'Hold', $3, $3)`,
        [secondChildId, secondChildRef, actor]
      );
      await query(
        `UPDATE purchase_orders
            SET memo = 'Later NetSuite PO refresh',
                status_updated_at = now(),
                synced_at = now()
          WHERE netsuite_id = $1`,
        [original.parentId]
      );

      const replayed = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: original.parentId,
        source: "manual"
      });
      assert.equal(replayed.reconciliationStatus, "ok");
      assert.equal(replayed.targets[original.childRef].received, 1000);
      assert.equal(replayed.targets[original.childRef].applicationStatus, "Hold");
      assert.equal(replayed.targets[secondChildRef].received, 0);
      assert.equal(replayed.targets[secondChildRef].applicationStatus, "Hold");
      assert.doesNotMatch(replayed.reason, /location|destination|reference|capacity/i);
    });
  } finally {
    await rollback.rollback();
  }
});

test("unknown and multi-child IR memo references remain blocked instead of falling back to another yard target", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const unknown = await seedFamily({
        suffix: 70,
        receiptLocationId: 15,
        receiptMemo: "SN9999999"
      });
      const unknownResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: unknown.parentId,
        source: "manual"
      });
      assert.equal(unknownResult.reconciliationStatus, "review");
      assert.match(unknownResult.reason, /IR.*reference|reference.*IR/i);
      assert.equal(unknownResult.targets[unknown.childRef].received, 0);

      const ambiguous = await seedFamily({
        suffix: 80,
        receiptLocationId: 15,
        receiptMemo: "SN1111111 / SN2222222"
      });
      const ambiguousResult = await reconcileScmOrderFamily({
        kind: "PO",
        sourceOrderId: ambiguous.parentId,
        source: "manual"
      });
      assert.equal(ambiguousResult.reconciliationStatus, "review");
      assert.match(ambiguousResult.reason, /ambiguous|multiple|reference/i);
      assert.equal(ambiguousResult.targets[ambiguous.childRef].received, 0);
    });
  } finally {
    await rollback.rollback();
  }
});

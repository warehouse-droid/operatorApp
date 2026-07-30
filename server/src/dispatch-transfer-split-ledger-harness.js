import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  applyConfirmedDispatchPlanToDelivery,
  deactivateUnplannedDispatchSplitOrders
} from "./delivery-repository.js";

const rollback = await beginRollbackContext();
const seed = Number(String(Date.now()).slice(-7));
const parentId = 9960000000 + seed;
const parentRef = `HARNESS-TO-${seed}`;
const splitRef = `${parentRef}-S1`;
const rowOnlySplitRef = `${parentRef}-S2`;
const invalidSplitRef = `${parentRef}-S9`;
const firstLineKey = 780000 + (seed % 100000);
const secondLineKey = firstLineKey + 1;
const planDate = "2098-12-28";
const sharedSku = `HARNESS-TO-SKU-${seed}`;

async function ensureTransferSplitLedgerSchema() {
  const existing = await query(
    `SELECT to_regclass('public.dispatch_scm_to_splits') AS header,
            to_regclass('public.dispatch_scm_to_split_lines') AS lines`
  );
  if (existing.rows[0]?.header && existing.rows[0]?.lines) return;

  const migration = await readFile(
    new URL("../migrations/074_po_to_reconciliation.sql", import.meta.url),
    "utf8"
  );
  assert(
    migration.includes("CREATE TABLE IF NOT EXISTS dispatch_scm_to_splits"),
    "migration 074 TO ledger schema block should be present"
  );
  await query(migration);
}

function splitPlan({
  orderRef = splitRef,
  lineRowId,
  lineId,
  pieces = 4,
  includeOnlySku = false
} = {}) {
  const item = {
    itemId: 990002,
    sku: sharedSku,
    pieces,
    toPcs: 1
  };
  if (!includeOnlySku) {
    if (lineRowId !== undefined) item.lineRowId = lineRowId;
    if (lineId !== undefined) item.lineId = lineId;
  }
  return {
    id: `transfer-split-ledger-${seed}`,
    planDate,
    status: "confirmed",
    orders: [{
      id: orderRef,
      type: "TO",
      originalOrderId: parentRef,
      items: [item]
    }],
    trucks: []
  };
}

try {
  await rollback.run(async () => {
    await ensureTransferSplitLedgerSchema();
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         outbound_operator_status, receiving_status, local_yard_order_status,
         fulfillment_status, netsuite_active
       ) VALUES (
         $1, $2, current_date, 'B', 'Pending Fulfillment',
         15, '12441', 1, '3445',
         'open', 'not_received', 'Open',
         'not_fulfilled', true
       )`,
      [parentId, parentRef]
    );
    const sourceLines = await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, piece_qty, to_pcs, location_id, location,
         confirmed, netsuite_active
       ) VALUES
         ('outbound', $1, $2, 990001, 'Same SKU first line', $4,
          100, 'PC', 100, 1, 1, '3445', false, true),
         ('outbound', $1, $3, 990002, 'Same SKU selected line', $4,
          80, 'PC', 80, 1, 1, '3445', false, true),
         ('outbound', $1, NULL, 990003, 'Row identity only line', $4,
          60, 'PC', 60, 1, 1, '3445', false, true)
       RETURNING id, line_id`,
      [parentId, firstLineKey, secondLineKey, sharedSku]
    );
    const firstSource = sourceLines.rows.find((line) => Number(line.line_id) === firstLineKey);
    const selectedSource = sourceLines.rows.find((line) => Number(line.line_id) === secondLineKey);
    const rowOnlySource = sourceLines.rows.find((line) => line.line_id == null);
    assert(firstSource && selectedSource && rowOnlySource, "source TO test lines should be created");

    await assert.rejects(
      applyConfirmedDispatchPlanToDelivery(splitPlan({
        orderRef: invalidSplitRef,
        pieces: 3,
        includeOnlySku: true
      })),
      /Selected TO line \(missing\) was not found/,
      "SKU/item-only matching must not materialize a TO split line"
    );
    const invalidChild = await query(
      `SELECT netsuite_id FROM transfer_orders WHERE tranid = $1`,
      [invalidSplitRef]
    );
    assert.equal(invalidChild.rowCount, 0, "failed exact matching should roll back the synthetic child");

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      orderRef: rowOnlySplitRef,
      lineRowId: rowOnlySource.id,
      pieces: 2
    }));
    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      orderRef: rowOnlySplitRef,
      lineRowId: rowOnlySource.id,
      pieces: 3
    }));
    const rowOnlyLedger = await query(
      `SELECT line.source_line_id, line.netsuite_source_line_key,
              line.piece_qty, line.requested_piece_qty
         FROM dispatch_scm_to_splits split
         JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
        WHERE split.split_to_ref = $1`,
      [rowOnlySplitRef]
    );
    assert.equal(rowOnlyLedger.rowCount, 1, "row-only line rematerialization must remain unique");
    assert.equal(String(rowOnlyLedger.rows[0].source_line_id), String(rowOnlySource.id));
    assert.equal(rowOnlyLedger.rows[0].netsuite_source_line_key, null);
    assert.equal(Number(rowOnlyLedger.rows[0].piece_qty), 3);
    assert.equal(Number(rowOnlyLedger.rows[0].requested_piece_qty), 3);
    await query(
      `UPDATE transfer_orders
          SET dispatch_planned = true,
              dispatch_plan_date = $2::date
        WHERE tranid = $1`,
      [rowOnlySplitRef, planDate]
    );
    await applyConfirmedDispatchPlanToDelivery({
      id: `transfer-row-only-omission-${seed}`,
      planDate,
      status: "confirmed",
      orders: [],
      trucks: []
    });
    const omittedWithoutProgress = await query(
      `SELECT child.netsuite_active, split.status, split.cancelled_at,
              COUNT(line.id)::int AS ledger_line_count,
              BOOL_AND(split_child.netsuite_active = false) AS child_lines_inactive
         FROM transfer_orders child
         JOIN dispatch_scm_to_splits split ON split.split_to_id = child.netsuite_id
         LEFT JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
         LEFT JOIN transfer_order_lines split_child
           ON split_child.line_stage = line.split_line_stage
          AND split_child.id = line.split_line_id
        WHERE child.tranid = $1
        GROUP BY child.netsuite_id, split.id`,
      [rowOnlySplitRef]
    );
    assert.equal(omittedWithoutProgress.rows[0].netsuite_active, false);
    assert.equal(omittedWithoutProgress.rows[0].status, "cancelled");
    assert(omittedWithoutProgress.rows[0].cancelled_at);
    assert.equal(omittedWithoutProgress.rows[0].ledger_line_count, 1);
    assert.equal(omittedWithoutProgress.rows[0].child_lines_inactive, true);

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      lineRowId: selectedSource.id,
      lineId: secondLineKey,
      pieces: 4
    }));

    const initial = await query(
      `SELECT split.id AS ledger_id,
              split.source_to_id,
              split.split_to_id,
              split.status,
              split.cancelled_at,
              line.source_line_id,
              line.split_line_id,
              line.netsuite_source_line_key,
              line.item_id,
              line.piece_qty,
              line.sales_qty,
              line.requested_piece_qty,
              line.requested_sales_qty
         FROM dispatch_scm_to_splits split
         JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
        WHERE split.split_to_ref = $1`,
      [splitRef]
    );
    assert.equal(initial.rowCount, 1, "materialization should create one exact TO split ledger line");
    assert.equal(Number(initial.rows[0].source_to_id), parentId, "ledger parent must be the positive NetSuite TO");
    assert(Number(initial.rows[0].split_to_id) < 0, "ledger child must be the negative local split TO");
    assert.equal(initial.rows[0].status, "active");
    assert.equal(initial.rows[0].cancelled_at, null);
    assert.equal(String(initial.rows[0].source_line_id), String(selectedSource.id));
    assert.notEqual(String(initial.rows[0].source_line_id), String(firstSource.id), "same SKU must not select its sibling");
    assert.equal(String(initial.rows[0].netsuite_source_line_key), String(secondLineKey));
    assert.equal(Number(initial.rows[0].item_id), 990002);
    assert.equal(Number(initial.rows[0].piece_qty), 4);
    assert.equal(Number(initial.rows[0].sales_qty), 4);
    assert.equal(Number(initial.rows[0].requested_piece_qty), 4);
    assert.equal(Number(initial.rows[0].requested_sales_qty), 4);
    const initialLedgerId = initial.rows[0].ledger_id;
    const initialSplitLineId = initial.rows[0].split_line_id;

    await assert.rejects(
      applyConfirmedDispatchPlanToDelivery({
        id: `transfer-empty-split-${seed}`,
        planDate,
        status: "confirmed",
        orders: [{
          id: splitRef,
          type: "TO",
          originalOrderId: parentRef,
          items: []
        }],
        trucks: []
      }),
      /must include at least one item/i,
      "An empty active TO split must fail instead of deleting its materialized lines."
    );
    const preservedAfterEmptySplit = await query(
      `SELECT split.id AS ledger_id,
              line.split_line_id,
              line.piece_qty,
              line.sales_qty,
              child.netsuite_active
         FROM dispatch_scm_to_splits split
         JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
         JOIN transfer_order_lines child
           ON child.line_stage = line.split_line_stage
          AND child.id = line.split_line_id
        WHERE split.split_to_ref = $1`,
      [splitRef]
    );
    assert.equal(preservedAfterEmptySplit.rowCount, 1);
    assert.equal(String(preservedAfterEmptySplit.rows[0].ledger_id), String(initialLedgerId));
    assert.equal(String(preservedAfterEmptySplit.rows[0].split_line_id), String(initialSplitLineId));
    assert.equal(Number(preservedAfterEmptySplit.rows[0].piece_qty), 4);
    assert.equal(Number(preservedAfterEmptySplit.rows[0].sales_qty), 4);
    assert.equal(preservedAfterEmptySplit.rows[0].netsuite_active, true);

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      lineRowId: Number(selectedSource.id) + 999999,
      lineId: secondLineKey,
      pieces: 6
    }));
    const rematerialized = await query(
      `SELECT split.id AS ledger_id,
              split.status,
              split.cancelled_at,
              line.source_line_id,
              line.split_line_id,
              line.piece_qty,
              line.sales_qty,
              line.requested_piece_qty,
              line.requested_sales_qty
         FROM dispatch_scm_to_splits split
         JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
        WHERE split.split_to_ref = $1`,
      [splitRef]
    );
    assert.equal(rematerialized.rowCount, 1, "rematerialization must not duplicate ledger lines");
    assert.equal(String(rematerialized.rows[0].ledger_id), String(initialLedgerId));
    assert.equal(String(rematerialized.rows[0].split_line_id), String(initialSplitLineId));
    assert.equal(String(rematerialized.rows[0].source_line_id), String(selectedSource.id));
    assert.equal(Number(rematerialized.rows[0].piece_qty), 6);
    assert.equal(Number(rematerialized.rows[0].sales_qty), 6);
    assert.equal(Number(rematerialized.rows[0].requested_piece_qty), 6);
    assert.equal(Number(rematerialized.rows[0].requested_sales_qty), 6);

    const deactivated = await deactivateUnplannedDispatchSplitOrders({
      originalOrderId: parentRef,
      orderType: "TO",
      splitOrderIds: [splitRef]
    });
    assert.deepEqual(deactivated.deactivated, [splitRef]);
    const cancelled = await query(
      `SELECT split.status, split.cancelled_at,
              COUNT(line.id)::int AS ledger_line_count,
              BOOL_AND(child.netsuite_active = false) AS child_lines_inactive
         FROM dispatch_scm_to_splits split
         LEFT JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
         LEFT JOIN transfer_order_lines child
           ON child.line_stage = line.split_line_stage
          AND child.id = line.split_line_id
        WHERE split.split_to_ref = $1
        GROUP BY split.id`,
      [splitRef]
    );
    assert.equal(cancelled.rows[0].status, "cancelled");
    assert(cancelled.rows[0].cancelled_at, "deactivated TO ledger should record cancellation time");
    assert.equal(cancelled.rows[0].ledger_line_count, 1, "cancelled TO ledger must retain its exact line history");
    assert.equal(cancelled.rows[0].child_lines_inactive, true, "cancelled TO child lines should be inactive");

    await applyConfirmedDispatchPlanToDelivery(splitPlan({
      lineRowId: selectedSource.id,
      lineId: secondLineKey,
      pieces: 5
    }));
    const restored = await query(
      `SELECT split.status, split.cancelled_at, line.source_line_id, line.piece_qty
         FROM dispatch_scm_to_splits split
         JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
        WHERE split.split_to_ref = $1`,
      [splitRef]
    );
    assert.equal(restored.rowCount, 1);
    assert.equal(restored.rows[0].status, "active", "rematerialization should reactivate the ledger");
    assert.equal(restored.rows[0].cancelled_at, null, "reactivation should clear cancelled_at");
    assert.equal(String(restored.rows[0].source_line_id), String(selectedSource.id));
    assert.equal(Number(restored.rows[0].piece_qty), 5);

    const reconciliationOrderState = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref
       ) VALUES ('TO', $1, $2)
       RETURNING id`,
      [parentId, parentRef]
    );
    const reconciliationLineState = await query(
      `INSERT INTO scm_reconciliation_order_line_state (
         order_state_id, netsuite_line_key, local_line_id, local_line_stage
       ) VALUES ($1, $2, $3, 'outbound')
       RETURNING id`,
      [reconciliationOrderState.rows[0].id, String(secondLineKey), selectedSource.id]
    );
    const reconciliationAllocation = await query(
      `INSERT INTO scm_reconciliation_allocations (
         allocation_key, order_line_state_id, progress_kind, target_kind,
         to_split_line_id, target_order_ref, quantity, allocation_method
       )
       SELECT $1, $2, 'received', 'to_split',
              line.id, split.split_to_ref, 1, 'exact'
         FROM dispatch_scm_to_splits split
         JOIN dispatch_scm_to_split_lines line ON line.split_id = split.id
        WHERE split.split_to_ref = $3
       RETURNING id`,
      [
        `harness-to-allocation-${seed}`,
        reconciliationLineState.rows[0].id,
        splitRef
      ]
    );
    await assert.rejects(
      deactivateUnplannedDispatchSplitOrders({
        originalOrderId: parentRef,
        orderType: "TO",
        splitOrderIds: [splitRef]
      }),
      /Unsplit blocked/,
      "active reconciled progress must prevent TO split deactivation"
    );
    await query(
      `UPDATE scm_reconciliation_allocations
          SET active = false
        WHERE id = $1`,
      [reconciliationAllocation.rows[0].id]
    );

    await query(
      `UPDATE transfer_order_lines
          SET fulfilled_piece_qty = 1
        WHERE id = (
          SELECT line.split_line_id
            FROM dispatch_scm_to_split_lines line
            JOIN dispatch_scm_to_splits split ON split.id = line.split_id
           WHERE split.split_to_ref = $1
        )`,
      [splitRef]
    );
    await query(
      `UPDATE transfer_orders
          SET dispatch_planned = true,
              dispatch_plan_date = $2::date,
              dispatch_truck_plate = 'HARNESS'
        WHERE tranid = $1`,
      [splitRef, planDate]
    );
    await applyConfirmedDispatchPlanToDelivery({
      id: `transfer-split-omission-${seed}`,
      planDate,
      status: "confirmed",
      orders: [],
      trucks: []
    });
    const omittedWithProgress = await query(
      `SELECT child.netsuite_active, split.status, split.cancelled_at
         FROM transfer_orders child
         JOIN dispatch_scm_to_splits split ON split.split_to_id = child.netsuite_id
        WHERE child.tranid = $1`,
      [splitRef]
    );
    assert.equal(
      omittedWithProgress.rows[0].netsuite_active,
      true,
      "plan omission must not deactivate a TO split with fulfillment evidence"
    );
    assert.equal(omittedWithProgress.rows[0].status, "active");
    assert.equal(omittedWithProgress.rows[0].cancelled_at, null);

    await assert.rejects(
      deactivateUnplannedDispatchSplitOrders({
        originalOrderId: parentRef,
        orderType: "TO",
        splitOrderIds: [splitRef]
      }),
      /Unsplit blocked/,
      "fulfilled progress must prevent TO split deactivation"
    );
    const protectedLedger = await query(
      `SELECT status, cancelled_at
         FROM dispatch_scm_to_splits
        WHERE split_to_ref = $1`,
      [splitRef]
    );
    assert.equal(protectedLedger.rows[0].status, "active");
    assert.equal(protectedLedger.rows[0].cancelled_at, null);
  });
  console.log("dispatch transfer split ledger harness passed");
} finally {
  await rollback.rollback();
  await closeDb();
}

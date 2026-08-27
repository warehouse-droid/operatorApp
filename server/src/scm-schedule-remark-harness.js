import assert from "node:assert/strict";

import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  listScmPurchaseOrders,
  listScmSchedule,
  updateScmScheduleEntry
} from "./dispatch-repository.js";

const rollback = await beginRollbackContext();
const seed = Number(String(Date.now()).slice(-8));
const toId = -(9800000000 + seed);
const sourcePoId = -(9700000000 + seed);
const splitPoId = sourcePoId - 1;
const toRef = `TO-REMARK-${seed}`;
const sourcePoRef = `PO-REMARK-${seed}`;
const splitPoRef = `${sourcePoRef}-L1`;

function exactRevision(row = {}) {
  return row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || "");
}

try {
  await rollback.run(async () => {
    const column = await query(
      `SELECT data_type, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'scm_transport_schedule'
          AND column_name = 'remark_override'`
    );
    assert.equal(column.rowCount, 1, "Migration 184 must add the single shared schedule remark column.");

    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text, memo,
         from_location_id, from_location, to_location_id, to_location,
         fulfillment_status, receiving_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-08-27', 'B', 'Transfer Order : Pending Fulfillment', $3,
         1, '3445', 28, '2967', 'not_fulfilled', 'not_received', true, now()
       )`,
      [toId, toRef, "NetSuite transfer memo"]
    );
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, pallet_qty,
         to_plt, loaded_qty, netsuite_received_qty, item_weight, netsuite_active, raw
       ) VALUES (
         'outbound', $1, 10, 800001, 'Remark harness material', 'REMARK-MATERIAL',
         10, 'EA', 1, '3445', 1, 10, 0, 0, 5, true, '{}'::jsonb
       )`,
      [toId]
    );

    let toRows = await listScmSchedule({ kind: "TO", exactRef: toRef });
    assert.equal(toRows.length, 1);
    assert.equal(toRows[0].remark, "NetSuite transfer memo");
    assert.equal(toRows[0].remarkSource, "netsuite");
    assert.equal(toRows[0].remarkOverride, "");

    const localTo = await updateScmScheduleEntry({
      orderKind: "TO",
      orderRef: toRef,
      patch: { remarkOverride: "  Call receiving before arrival  " },
      updatedBy: "scm-remark-harness",
      expectedUpdatedAt: null
    });
    assert.equal(localTo.remark_override, "Call receiving before arrival");
    toRows = await listScmSchedule({ kind: "TO", exactRef: toRef });
    assert.equal(toRows[0].remark, "Call receiving before arrival");
    assert.equal(toRows[0].remarkSource, "local");
    assert.equal(toRows[0].netSuiteMemo, "NetSuite transfer memo");

    await assert.rejects(
      updateScmScheduleEntry({
        orderKind: "TO",
        orderRef: toRef,
        patch: { remarkOverride: "Stale overwrite" },
        updatedBy: "scm-remark-stale-harness",
        expectedUpdatedAt: null
      }),
      (error) => error?.status === 409 && error?.code === "SCM_SCHEDULE_STALE"
    );

    await query(`UPDATE transfer_orders SET memo = 'Latest NetSuite memo' WHERE netsuite_id = $1`, [toId]);
    const clearedTo = await updateScmScheduleEntry({
      orderKind: "TO",
      orderRef: toRef,
      patch: { remarkOverride: " \n " },
      updatedBy: "scm-remark-harness",
      expectedUpdatedAt: exactRevision(localTo)
    });
    assert.equal(clearedTo.remark_override, null);
    toRows = await listScmSchedule({ kind: "TO", exactRef: toRef });
    assert.equal(toRows[0].remark, "Latest NetSuite memo");
    assert.equal(toRows[0].remarkSource, "netsuite");

    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         destination_location_id, destination_location, source_location_id,
         source_location, receipt_status, initial_scm_status, netsuite_active, synced_at
       ) VALUES
         ($1,$2,current_date,900001,'Remark Vendor','pendingReceipt','Purchase Order : Pending Receipt',
          1,'3445',1,'Vendor Yard','not_received','Queued',true,now()),
         ($3,$4,current_date,900001,'Remark Vendor','pendingReceipt','Purchase Order : Pending Receipt',
          1,'3445',1,'Vendor Yard','not_received','Queued',true,now())`,
      [sourcePoId, sourcePoRef, splitPoId, splitPoRef]
    );
    await query(
      `INSERT INTO dispatch_scm_po_splits (
         source_po_id, source_po_ref, split_po_id, split_po_ref, status,
         created_by, revision, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', 'scm-remark-harness', 7, now())`,
      [sourcePoId, sourcePoRef, splitPoId, splitPoRef]
    );
    await query(
      `INSERT INTO purchase_order_lines (
         id, purchase_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, pallet_qty,
         to_plt, received_pallet_qty, netsuite_received_qty,
         netsuite_received_baseline_qty, item_weight, netsuite_active, synced_at, raw
       ) VALUES
         ($1,$2,10,810001,'Source remark item','SOURCE-REMARK-ITEM',10,'EA',1,'3445',1,10,0,0,0,5,true,now(),'{}'::jsonb),
         ($3,$4,10,810001,'Split remark item','SPLIT-REMARK-ITEM',10,'EA',1,'3445',1,10,0,0,0,5,true,now(),'{}'::jsonb)`,
      [sourcePoId - 100, sourcePoId, splitPoId - 100, splitPoId]
    );
    const planned = await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, method,
         pickup_point, dropoff_point, status, notes, updated_by
       ) VALUES (
         'PO', 'purchase_orders', $1, $2, 'MBT',
         'Vendor Yard', '3445', 'Planned', 'Truck A Load 1', 'scm-remark-harness'
       ) RETURNING *`,
      [splitPoId, splitPoRef]
    );
    const plannedBefore = planned.rows[0];
    const remarkedSplit = await updateScmScheduleEntry({
      orderKind: "PO",
      orderRef: splitPoRef,
      patch: { remarkOverride: "Driver must call vendor" },
      updatedBy: "scm-remark-harness",
      expectedUpdatedAt: exactRevision(plannedBefore)
    });
    assert.equal(remarkedSplit.remark_override, "Driver must call vendor");
    assert.equal(remarkedSplit.status, "Planned");
    assert.equal(remarkedSplit.pickup_point, "Vendor Yard");
    assert.equal(remarkedSplit.dropoff_point, "3445");
    assert.equal(remarkedSplit.notes, "Truck A Load 1");

    const splitRevision = await query(
      `SELECT revision FROM dispatch_scm_po_splits WHERE lower(split_po_ref) = lower($1)`,
      [splitPoRef]
    );
    assert.equal(Number(splitRevision.rows[0].revision), 7, "A remark must not advance the split operational revision.");

    const splitScreenOrders = await listScmPurchaseOrders({ search: splitPoRef });
    const splitScreenOrder = splitScreenOrders.find((order) => order.id === splitPoRef);
    assert(splitScreenOrder, "PO Split must continue returning the active split child.");
    assert.equal(splitScreenOrder.scm.remarkOverride, "Driver must call vendor",
      "PO Split and PO / TO Schedule must read the same local remark column.");

    await assert.rejects(
      updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: splitPoRef,
        patch: { remarkOverride: "Unsafe mixed write", status: "Hold" },
        updatedBy: "scm-remark-harness",
        expectedUpdatedAt: exactRevision(remarkedSplit),
        expectedSplitRevision: 7
      }),
      (error) => error?.status === 409 && error?.code === "SCM_PO_SPLIT_OPERATIONAL"
    );

    const unchanged = await query(
      `SELECT status, pickup_point, dropoff_point, notes, remark_override
         FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [splitPoRef]
    );
    assert.deepEqual(unchanged.rows[0], {
      status: "Planned",
      pickup_point: "Vendor Yard",
      dropoff_point: "3445",
      notes: "Truck A Load 1",
      remark_override: "Driver must call vendor"
    });
  });

  console.log("SCM schedule shared remark rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}

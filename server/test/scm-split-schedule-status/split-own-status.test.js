// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../src/db.js";
import { createScmPurchaseOrderSplit, listScmSchedule } from "../../src/dispatch-repository.js";
import { enrichScmScheduleWithReconciliation } from "../../src/scm-reconciliation-repository.js";

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

// SN1404201 shape (2026-11-05): POB04164 is on Hold and was last reconciled
// on 2026-10-31. Split SN1404201 was created on 2026-11-04 as Queued and then
// directly linked to a planned SO group, so PO Split showed Direct ship while
// PO/TO Schedule borrowed the parent's Hold.
async function seedHeldSourceWithStaleSnapshot() {
  const token = crypto.randomUUID().replaceAll("-", "");
  const baseId = 8_700_000_000_000 + (Number.parseInt(token.slice(0, 10), 16) * 20);
  const fixture = {
    sourcePoId: baseId + 1,
    lineId: baseId + 2,
    itemId: baseId + 3,
    salesOrderId: baseId + 4,
    sourcePoRef: `PO-SPLIT-OWN-${token.slice(0, 10)}`,
    splitRef: `SN-SPLIT-OWN-${token.slice(0, 10)}`,
    salesOrderRef: `SO-SPLIT-OWN-${token.slice(0, 10)}`
  };
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id,
       source_location, dispatch_vendor_yard, receipt_status,
       initial_scm_status, netsuite_active, synced_at
     ) VALUES (
       $1::bigint, $2, current_date, $1::bigint + 10, 'Split own status vendor',
       'B', 'Purchase Order : Pending Receipt',
       1, '3445', 1, '3445', 'Split own status yard', 'not_received',
       'Hold', true, now()
     )`,
    [fixture.sourcePoId, fixture.sourcePoRef]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       id, purchase_order_id, line_id, item_id, item_name, sku, item_type, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, received_pallet_qty,
       received_layer_qty, received_section_qty, received_piece_qty,
       netsuite_received_qty, netsuite_received_baseline_qty, item_weight,
       netsuite_active, synced_at, raw
     ) VALUES (
       $2::bigint, $1::bigint, 10, $3::bigint, 'Split own status item', 'SPLIT-OWN-SKU', 'InvtPart', 100, 'EA',
       1, '3445', 10, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 25,
       true, now(), '{}'::jsonb
     )`,
    [fixture.sourcePoId, fixture.lineId, fixture.itemId]
  );
  await query(
    `INSERT INTO scm_transport_schedule (order_kind, order_ref, method, status, updated_by, created_at, updated_at)
     VALUES ('PO', $1, 'MBT', 'Hold', 'split-own-status-test', '2026-10-29', '2026-10-29')`,
    [fixture.sourcePoRef]
  );
  const targets = {
    [fixture.sourcePoRef]: {
      orderRef: fixture.sourcePoRef,
      targetKind: "source_residual",
      ordered: 100,
      received: 0,
      remaining: 100,
      hidden: false,
      applicationStatus: "Hold",
      reconciliationStatus: "ok"
    }
  };
  const state = await query(
    `INSERT INTO scm_reconciliation_order_state (
       order_kind, source_order_netsuite_id, source_order_ref,
       netsuite_status_code, netsuite_status_text, application_status,
       reconciliation_status, ordered_qty, received_qty, remaining_qty,
       exact_allocation, quantity_summary, reconciled_at
     ) VALUES (
       'PO', $1, $2, 'B', 'Purchase Order : Pending Receipt', 'Queued',
       'current', 100, 0, 100, true, $3::jsonb, '2026-10-31T19:19:29Z'
     ) RETURNING id`,
    [
      fixture.sourcePoId,
      fixture.sourcePoRef,
      JSON.stringify({ family: { ordered: 100, received: 0, remaining: 100 }, targets })
    ]
  );
  return { ...fixture, stateId: Number(state.rows[0].id), targets };
}

async function createDirectLinkedSplit(fixture) {
  const created = await createScmPurchaseOrderSplit({
    sourcePoRef: fixture.sourcePoRef,
    newPoRef: fixture.splitRef,
    destinationLocationId: 15,
    status: "Queued",
    lines: [{ lineRowId: fixture.lineId, pallets: 4 }],
    createdBy: "split-own-status-test"
  });
  const splitPoId = Number(created.split.splitPoId);
  const splitLine = await query(
    `SELECT id, quantity FROM purchase_order_lines
      WHERE purchase_order_id = $1 AND netsuite_active = true
      ORDER BY id LIMIT 1`,
    [splitPoId]
  );
  assert.equal(splitLine.rows.length, 1, "the split must own a PO line");
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, customer, status, status_text,
       outbound_location_id, outbound_location, fulfillment_status, netsuite_active
     ) VALUES ($1, $2, 'Split own status customer', 'B', 'Pending Fulfillment', 15, '12441', 'open', true)`,
    [fixture.salesOrderId, fixture.salesOrderRef]
  );
  const salesLine = await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, sku, quantity, pallet_qty, to_plt, unit, netsuite_active
     ) VALUES ($1, 1, $2, 'Split own status item', 'SPLIT-OWN-SKU', 40, 4, 10, 'EA', true) RETURNING id`,
    [fixture.salesOrderId, fixture.itemId]
  );
  await query(
    `INSERT INTO dispatch_so_po_allocations (
       sales_order_id, sales_order_ref, sales_line_id, po_order_id, po_order_ref, po_line_id,
       item_id, allocated_sales_qty, allocated_pallet_qty, dispatch_target_ref, dispatch_target_line_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 40, 4, $2, $8)`,
    [
      fixture.salesOrderId,
      fixture.salesOrderRef,
      salesLine.rows[0].id,
      splitPoId,
      fixture.splitRef,
      splitLine.rows[0].id,
      fixture.itemId,
      `${fixture.salesOrderRef}::${fixture.salesOrderRef}::${salesLine.rows[0].id}`
    ]
  );
  return { splitPoId };
}

async function scheduleRow(ref) {
  const [row] = await listScmSchedule({ exactRef: ref, kind: "PO", audience: "scm" });
  assert.ok(row, `${ref} must be listed on PO/TO Schedule`);
  return row;
}

test("a direct-linked split newer than its held parent's snapshot shows Direct ship on PO/TO Schedule", async () => {
  await inRollback(async () => {
    const fixture = await seedHeldSourceWithStaleSnapshot();
    await createDirectLinkedSplit(fixture);

    const split = await scheduleRow(fixture.splitRef);
    const source = await scheduleRow(fixture.sourcePoRef);
    assert.equal(split.isScmSplit, true);
    assert.equal(split.sourceRef, fixture.sourcePoRef);
    assert.equal(split.directShipLinked, true);
    assert.equal(split.calculatedStatus, "Direct ship", "the schedule query projects the direct link");
    const [projection] = await listScmSchedule({
      kind: "PO",
      view: "blanket",
      exactRefs: [fixture.splitRef],
      statusProjectionOnly: true,
      audience: "scm"
    });
    assert.equal(projection?.calculatedStatus, "Direct ship", "PO Split shows Direct ship");

    const enriched = await enrichScmScheduleWithReconciliation([split, source]);
    const displayedSplit = enriched.find((row) => row.orderRef === fixture.splitRef);
    const displayedSource = enriched.find((row) => row.orderRef === fixture.sourcePoRef);
    assert.equal(displayedSplit?.calculatedStatus, "Direct ship",
      "PO/TO Schedule must not show the parent's Hold over the split's own status");
    assert.equal(displayedSplit?.calculatedStatus, projection?.calculatedStatus,
      "PO/TO Schedule and PO Split must agree");
    assert.equal(displayedSplit?.reconciliationStatus, "unreconciled",
      "a split the family snapshot does not know yet is not reconciled");
    assert.equal(displayedSource?.calculatedStatus, "Hold", "the parent keeps its own Hold");
  });
});

test("a split's own reconciliation target still decides its status once the family is reconciled", async () => {
  await inRollback(async () => {
    const fixture = await seedHeldSourceWithStaleSnapshot();
    const { splitPoId } = await createDirectLinkedSplit(fixture);
    const withSplitTarget = (applicationStatus) => JSON.stringify({
      family: { ordered: 100, received: 0, remaining: 100 },
      targets: {
        ...fixture.targets,
        [fixture.splitRef]: {
          orderRef: fixture.splitRef,
          orderId: splitPoId,
          targetKind: "po_split",
          ordered: 40,
          received: applicationStatus === "Completed" ? 40 : 0,
          remaining: applicationStatus === "Completed" ? 0 : 40,
          hidden: false,
          applicationStatus,
          reconciliationStatus: "ok",
          preserveOperationalStatus: true
        }
      }
    });

    await query(
      `UPDATE scm_reconciliation_order_state
          SET quantity_summary = $2::jsonb, reconciled_at = now()
        WHERE id = $1`,
      [fixture.stateId, withSplitTarget("Queued")]
    );
    let [displayed] = await enrichScmScheduleWithReconciliation([await scheduleRow(fixture.splitRef)]);
    assert.equal(displayed?.calculatedStatus, "Direct ship");
    assert.equal(displayed?.reconciliationStatus, "ok", "the split's own target reconciles it");

    await query(
      `UPDATE scm_reconciliation_order_state
          SET quantity_summary = $2::jsonb, reconciled_at = now()
        WHERE id = $1`,
      [fixture.stateId, withSplitTarget("Completed")]
    );
    [displayed] = await enrichScmScheduleWithReconciliation([await scheduleRow(fixture.splitRef)]);
    assert.equal(displayed?.calculatedStatus, "Completed",
      "reconciled completion of the split's own target still wins");
  });
});

test("rows that are not PO splits keep the family fallback by source reference", async () => {
  await inRollback(async () => {
    const fixture = await seedHeldSourceWithStaleSnapshot();
    const [displayed] = await enrichScmScheduleWithReconciliation([{
      orderKind: "PO",
      orderRef: `${fixture.sourcePoRef}-ALIAS`,
      sourceRef: fixture.sourcePoRef,
      isScmSplit: false,
      status: "Queued",
      calculatedStatus: "Queued",
      scheduleId: 0
    }]);
    assert.equal(displayed?.calculatedStatus, "Hold");
    assert.equal(displayed?.reconciliationStatus, "ok");
  });
});

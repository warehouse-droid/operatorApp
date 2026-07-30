import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import { listScmSchedule } from "./dispatch-repository.js";

const rollback = await beginRollbackContext();
const seed = Number(String(Date.now()).slice(-8));
const transferOrderId = -(9900000000 + seed);
const transferOrderRef = `TO-SCHEDULE-CONTENT-${seed}`;

function occurrenceCount(value, pattern) {
  return (String(value || "").match(pattern) || []).length;
}

try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         fulfillment_status, receiving_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-07-30', 'B', 'Transfer Order : Pending Fulfillment',
         NULL, NULL, 28, '2967',
         'not_fulfilled', 'not_received', true, now()
       )`,
      [transferOrderId, transferOrderRef]
    );

    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location,
         pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs, loaded_qty, netsuite_received_qty,
         item_weight, netsuite_active, raw
       ) VALUES
         ('outbound', $1, 101, 8472, 'Harness Material A', 'HARNESS-MATERIAL-A',
          98, 'SQFT', 1, '3445', 1, 0, 0, 0, 98, 12.25, 0, 0, 0, 0, 2, true,
          '{"logicalLineIdentity":"transfer-anchor:101"}'::jsonb),
         ('receiving', $1, 103, 8472, 'Harness Material A', 'HARNESS-MATERIAL-A',
          98, 'SQFT', 28, '2967', 1, 0, 0, 0, 98, 12.25, 0, 0, 0, 0, 2, true,
          '{"logicalLineIdentity":"transfer-anchor:101"}'::jsonb),
         ('outbound', $1, 104, 8471, 'Harness Material B', 'HARNESS-MATERIAL-B',
          588, 'SQFT', 1, '3445', 6, 0, 0, 0, 98, 12.25, 0, 0, 0, 0, 3, true,
          '{"logicalLineIdentity":"transfer-anchor:104"}'::jsonb),
         ('receiving', $1, 106, 8471, 'Harness Material B', 'HARNESS-MATERIAL-B',
          588, 'SQFT', 28, '2967', 6, 0, 0, 0, 98, 12.25, 0, 0, 0, 0, 3, true,
          '{"logicalLineIdentity":"transfer-anchor:104"}'::jsonb),
         ('outbound', $1, 107, 1784, 'PALLET', 'PALLET',
          7, 'EACH', 1, '3445', 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 40, true,
          '{"logicalLineIdentity":"transfer-anchor:107"}'::jsonb),
         ('receiving', $1, 109, 1784, 'PALLET', 'PALLET',
          7, 'EACH', 28, '2967', 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 40, true,
          '{"logicalLineIdentity":"transfer-anchor:107"}'::jsonb)`,
      [transferOrderId]
    );

    const rows = await listScmSchedule({
      search: transferOrderRef,
      kind: "TO"
    });
    const schedule = rows.find((row) => row.orderRef === transferOrderRef);
    assert(schedule, "The transfer order must appear in PO/TO Schedule.");
    assert.equal(schedule.pickupPoint, "3445", "A missing TO header source must use the one unambiguous outbound line location.");
    assert.equal(schedule.dropoffPoint, "2967", "The TO destination must remain the receiving yard.");
    assert.equal(
      occurrenceCount(schedule.content, /HARNESS-MATERIAL-A 1 PLT/g),
      1,
      "The receiving mirror must not duplicate material A."
    );
    assert.equal(
      occurrenceCount(schedule.content, /HARNESS-MATERIAL-B 6 PLT/g),
      1,
      "The receiving mirror must not duplicate material B."
    );
    assert.equal(
      occurrenceCount(schedule.content, /PALLET 7 EACH/g),
      1,
      "The receiving mirror must not duplicate the official PALLET line."
    );
    assert.equal(schedule.totalPalletQty, 7, "Only outbound logical material pallets count toward the total.");
    assert.equal(schedule.weightLbs, 2240, "Transfer weight must count each logical line once.");

    const exactRows = await listScmSchedule({
      kind: "TO",
      exactRef: transferOrderRef
    });
    assert.equal(exactRows.length, 1, "Targeted schedule hydration must return only the saved TO row.");
    assert.equal(exactRows[0].orderRef, transferOrderRef);
  });
  console.log("SCM TO schedule content deduplication rollback harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}

import assert from "node:assert/strict";

import { beginRollbackContext, closeDb, query } from "./db.js";
import { listScmSchedule } from "./dispatch-repository.js";

const rollback = await beginRollbackContext();
const suffix = Date.now().toString(36).toUpperCase();
const transferOrderId = -(Number(String(Date.now()).slice(-9)) + 8_800_000_000);
const transferOrderRef = `TO-FILTER-${suffix}`;

try {
  await rollback.run(async () => {
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text, memo,
         from_location_id, from_location, to_location_id, to_location,
         fulfillment_status, receiving_status, netsuite_active, synced_at
       ) VALUES (
         $1, $2, DATE '2026-08-14', 'B', 'Transfer Order : Pending Fulfillment', 'NetSuite filter memo',
         1, 'Filter Origin', 28, '3445',
         'not_fulfilled', 'not_received', true, TIMESTAMPTZ '2026-08-14 12:00:00+00'
       )`,
      [transferOrderId, transferOrderRef]
    );
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, transfer_order_id, line_id, item_id, item_name, sku,
         quantity, unit, location_id, location, pallet_qty,
         to_plt, loaded_qty, netsuite_received_qty, item_weight, netsuite_active, raw
       ) VALUES (
         'outbound', $1, 10, 880001, 'Filter Cement', 'FILTER-CEMENT',
         10, 'EA', 1, 'Filter Origin', 1,
         10, 0, 0, 5, true, '{}'::jsonb
       )`,
      [transferOrderId]
    );
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, source_table, source_id, order_ref, display_ref, method,
         pickup_point, dropoff_point, brand, content, remark_override,
         weight_lbs, packing_slip_ref, status, eta_date, eta_time, driver,
         created_by, created_at, updated_by, updated_at
       ) VALUES (
         'TO', 'transfer_orders', $1, $2, $3, 'MBT',
         'Filter Origin', '3445', 'Filter Brand', 'Filter Cement 1 PLT', 'Call Alex before arrival',
         1234, 'PACK-FILTER-123', 'Queued', DATE '2026-08-20', '09:30', 'Alex Driver',
         'column-filter-harness', TIMESTAMPTZ '2026-08-15 12:00:00+00',
         'column-filter-harness', TIMESTAMPTZ '2026-08-15 12:00:00+00'
       )`,
      [transferOrderId, transferOrderRef, `${transferOrderRef}-DISPLAY`]
    );

    const filters = {
      view: "dispatch",
      kind: "TO",
      status: ["Queued"],
      queuedFrom: "2026-08-15",
      queuedTo: "2026-08-15",
      pickup: "origin",
      yard: "3445",
      brand: ["Filter Brand"],
      contentSearch: "cement",
      remarkSearch: "call alex",
      orderSearch: `${transferOrderRef}-display`,
      weightMin: "1200",
      weightMax: "1300",
      packingSearch: "filter-123",
      from: "2026-08-20",
      to: "2026-08-20",
      driverSearch: "alex",
      slaMin: "5",
      slaMax: "5"
    };
    const matching = await listScmSchedule(filters);
    assert.equal(matching.length, 1, "The row must satisfy every data-column filter conjunctively.");
    assert.equal(matching[0].orderRef, transferOrderRef);
    assert.equal(matching[0].slaDays, 5);

    for (const [field, value] of Object.entries({
      queuedFrom: "2026-08-16",
      queuedTo: "2026-08-14",
      pickup: "different origin",
      contentSearch: "steel",
      remarkSearch: "no appointment",
      orderSearch: "TO-NOT-THIS-ORDER",
      weightMin: "1235",
      weightMax: "1233",
      packingSearch: "PACK-OTHER",
      driverSearch: "Different Driver",
      slaMin: "6",
      slaMax: "4"
    })) {
      const excluded = await listScmSchedule({ ...filters, [field]: value });
      assert.equal(excluded.length, 0, `${field} did not exclude a non-matching row.`);
    }

    for (const [offset, method, dropoff] of [[1, "Vendor", "12441 + 2967"], [2, "Customer Pickup", "150"]]) {
      const id = transferOrderId - offset;
      const ref = `${transferOrderRef}-${offset}`;
      await query(`INSERT INTO transfer_orders (
        netsuite_id, tranid, trandate, status, status_text, from_location_id, from_location,
        to_location_id, to_location, fulfillment_status, receiving_status, netsuite_active
      ) VALUES ($1, $2, DATE '2026-08-14', 'B', 'Transfer Order : Pending Fulfillment',
        1, 'Filter Origin', 28, $3, 'not_fulfilled', 'not_received', true)`, [id, ref, dropoff]);
      await query(`INSERT INTO transfer_order_lines (
        line_stage, transfer_order_id, line_id, item_id, item_name, sku, quantity, unit,
        location_id, location, pallet_qty, to_plt, loaded_qty, netsuite_received_qty, item_weight, netsuite_active, raw
      ) VALUES ('outbound', $1, 10, 880001, 'Filter Cement', 'FILTER-CEMENT', 10, 'EA',
        1, 'Filter Origin', 1, 10, 0, 0, 5, true, '{}'::jsonb)`, [id]);
      await query(`INSERT INTO scm_transport_schedule (
        order_kind, source_table, source_id, order_ref, method, pickup_point, dropoff_point, status
      ) VALUES ('TO', 'transfer_orders', $1, $2, $3, 'Filter Origin', $4, 'Queued')`, [id, ref, method, dropoff]);
    }
    for (const [offset, special] of [[10, true], [11, false]]) {
      const id = transferOrderId - offset;
      const ref = `${transferOrderRef}-PO-${offset}`;
      await query(`INSERT INTO purchase_orders (
        netsuite_id, tranid, trandate, vendor, status, status_text, destination_location_id,
        destination_location, dispatch_vendor_yard, receipt_status, initial_scm_status, netsuite_active
      ) VALUES ($1, $2, DATE '2026-08-14', 'Filter Vendor', 'pendingReceipt',
        'Purchase Order : Pending Receipt', 1, '3445', 'Filter Origin', 'not_received', 'Queued', true)`, [id, ref]);
      await query(`INSERT INTO purchase_order_lines (
        purchase_order_id, line_id, item_id, item_name, sku, quantity, unit, location_id, location,
        pallet_qty, to_plt, netsuite_received_qty, netsuite_received_baseline_qty, item_weight, netsuite_active, raw
      ) VALUES ($1, 10, 880001, 'Filter Cement', 'FILTER-CEMENT', 10, 'EA', 1, '3445',
        1, 10, 0, 0, 5, true, '{}'::jsonb)`, [id]);
      await query(`INSERT INTO scm_transport_schedule (
        order_kind, source_table, source_id, order_ref, method, pickup_point, dropoff_point, status, is_special_order
      ) VALUES ('PO', 'purchase_orders', $1, $2, 'Vendor', 'Filter Origin', '12441 + 150', 'Queued', $3)`, [id, ref, special]);
    }
    const multiFilters = {
      orderSearch: transferOrderRef, view: "scm working", kind: ["TO", "sp.o"],
      method: ["MBT", "Vendor"], yard: ["3445", "150"]
    };
    const multiRows = await listScmSchedule(multiFilters);
    assert.deepEqual(new Set(multiRows.map((row) => row.orderRef)), new Set([transferOrderRef, `${transferOrderRef}-PO-10`]),
      "Each selected value must be ORed inside its column; the columns must be ANDed.");
    const methodsAndYards = await listScmSchedule({ ...multiFilters, kind: ["TO"], yard: ["3445", "2967"] });
    assert.deepEqual(new Set(methodsAndYards.map((row) => row.orderRef)), new Set([transferOrderRef, `${transferOrderRef}-1`]),
      "A combined destination must match any selected yard.");
    const clearedFilters = await listScmSchedule({ ...multiFilters, kind: [], method: [], yard: [] });
    assert.equal(clearedFilters.length, 5, "Empty multi-select arrays must restore all fixture rows.");
    const dispatch = await listScmSchedule({ ...multiFilters, view: "dispatch", kind: ["TO"], method: ["Vendor"] });
    assert.deepEqual(dispatch.map((row) => row.orderRef), [transferOrderRef], "Dispatch must retain its MBT view despite hidden method selections.");
  });

  console.log("PO/TO Schedule all-column repository filter integration harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}

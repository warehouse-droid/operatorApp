import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  listScmSchedule,
  updateScmScheduleEntry
} from "../../../src/dispatch-repository.js";

after(closeDb);

const USE_NETSUITE_ADDRESS = "__USE_NETSUITE_ADDRESS__";

async function seedNetSuiteAddressPurchaseOrder() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const numericSuffix = Number.parseInt(suffix.slice(0, 7), 16);
  const orderId = 9_560_000_000_000 + numericSuffix;
  const vendorId = String(9_561_000_000_000 + numericSuffix);
  const orderRef = `POB-NS-ADDRESS-${suffix}`;
  const vendor = `Castle Building Centres Group Ltd.#${suffix}`;
  const vendorAddress = `${numericSuffix % 9999} Test Vendor Road, Ontario`;

  await query(
    `INSERT INTO dispatch_vendor_mappings (
       netsuite_vendor_id, netsuite_vendor_name, local_vendor, active,
       last_po_ref, last_seen_at, updated_by
     ) VALUES ($1, $2, $3, true, $4, now(), 'netsuite-address-regression')`,
    [vendorId, vendor, USE_NETSUITE_ADDRESS, orderRef]
  );
  await query(
    `WITH inserted_order AS (
       INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, vendor_address,
         status, status_text, foreign_total,
         destination_location_id, destination_location,
         source_location_id, source_location, dispatch_vendor_yard,
         dispatch_address, receipt_status, initial_scm_status,
         netsuite_active, synced_at
       ) VALUES (
         $1, $2, current_date, $3, $4, $5,
         'pendingReceipt', 'Purchase Order : Pending Receipt', 100,
         1, '3445', 0, $4, $4,
         $5, 'not_received', 'Queued', true, now()
       )
       RETURNING netsuite_id
     )
     INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       location_id, location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs,
       received_pallet_qty, received_layer_qty, received_section_qty,
       received_piece_qty, netsuite_received_qty, netsuite_received_baseline_qty,
       netsuite_active, synced_at, raw
     )
     SELECT netsuite_id, $6, $7, $8, $8, 10, 'EA',
            1, '3445', 1, 0, 0, 0,
            10, 0, 0, 1,
            0, 0, 0, 0, 0, 0,
            true, now(), '{}'::jsonb
       FROM inserted_order`,
    [orderId, orderRef, vendorId, vendor, vendorAddress, orderId + 1, orderId + 2, `${orderRef}-ITEM`]
  );
  await query(
    `INSERT INTO scm_transport_schedule (
       order_kind, order_ref, method, pickup_point, status, created_by, updated_by
     ) VALUES ('PO', $1, 'MBT', NULL, 'Partially Done', 'test', 'test')`,
    [orderRef]
  );
  return { orderRef, vendor, vendorAddress };
}

function invalidPickupError(error) {
  assert.equal(error?.status, 400);
  assert.equal(error?.code, "SCM_PO_PICKUP_YARD_INVALID");
  return true;
}

test("POB03560 shape: Vendor method accepts its canonical NetSuite-address pickup only", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await seedNetSuiteAddressPurchaseOrder();
      const [loaded] = await listScmSchedule({ exactRef: fixture.orderRef });
      assert.ok(loaded, "the production-shaped PO must be visible in PO/TO Schedule");
      assert.equal(loaded.pickupPoint, fixture.vendor);
      const originalPo = await query(
        `SELECT tranid, dispatch_ref
           FROM purchase_orders
          WHERE tranid = $1`,
        [fixture.orderRef]
      );

      const saved = await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: fixture.orderRef,
        patch: {
          isSpecialOrder: loaded.isSpecialOrder,
          method: "Vendor",
          pickupPoint: loaded.pickupPoint,
          dropoffPoint: loaded.dropoffPoint,
          packingSlipRef: loaded.packingSlipRef,
          remarkOverride: loaded.remarkOverride
        },
        updatedBy: "netsuite-address-regression",
        expectedUpdatedAt: loaded.updatedAt
      });
      assert.equal(saved.method, "Vendor");
      assert.equal(saved.status, "Partially Done",
        "changing the transport method must not recalculate operational progress");
      assert.equal(saved.pickup_point, null,
        "an old full-row payload must not turn the derived label into a route override");
      const savedPo = await query(
        `SELECT tranid, dispatch_ref
           FROM purchase_orders
          WHERE tranid = $1`,
        [fixture.orderRef]
      );
      assert.deepEqual(savedPo.rows, originalPo.rows,
        "unchanged full-row reference fields must not rename the PO");

      const [refreshed] = await listScmSchedule({ exactRef: fixture.orderRef });
      assert.deepEqual(refreshed.pickupOptions, [],
        "a NetSuite-address fallback must not be misrepresented as a configured local yard");
      assert.equal(refreshed.pickupPoint, fixture.vendor);

      await assert.rejects(
        updateScmScheduleEntry({
          orderKind: "PO",
          orderRef: fixture.orderRef,
          patch: { method: "MBT", pickupPoint: "Unrelated Yard" },
          updatedBy: "netsuite-address-regression",
          expectedUpdatedAt: saved.updated_at
        }),
        invalidPickupError
      );
      const unchanged = await query(
        `SELECT method, pickup_point, status
           FROM scm_transport_schedule
          WHERE order_kind = 'PO' AND order_ref = $1`,
        [fixture.orderRef]
      );
      assert.deepEqual(unchanged.rows[0], {
        method: "Vendor",
        pickup_point: null,
        status: "Partially Done"
      }, "a rejected pickup must roll back the entire schedule save");

      const configuredVendor = `Configured Castle ${crypto.randomUUID().slice(0, 8)}`;
      const configuredYard = `Configured Yard ${crypto.randomUUID().slice(0, 8)}`;
      await query(
        `INSERT INTO dispatch_local_vendors (name, active, updated_by)
         VALUES ($1, true, 'netsuite-address-regression')`,
        [configuredVendor]
      );
      await query(
        `INSERT INTO dispatch_vendor_yards (
           vendor, yard, day_label, window_start, window_end, address, active
         ) VALUES ($1, $2, 'Mon-Fri', '08:00', '17:00', $3, true)`,
        [configuredVendor, configuredYard, fixture.vendorAddress]
      );
      await query(
        `UPDATE dispatch_vendor_mappings
            SET local_vendor = $2, updated_at = now()
          WHERE netsuite_vendor_name = $1`,
        [fixture.vendor, configuredVendor]
      );
      await query(
        `INSERT INTO dispatch_vendor_mappings (
           netsuite_vendor_id, netsuite_vendor_name, local_vendor, active,
           last_po_ref, last_seen_at, updated_by
         ) VALUES ('', $1, $2, true, $3, now(), 'netsuite-address-regression')`,
        [fixture.vendor, USE_NETSUITE_ADDRESS, fixture.orderRef]
      );
      const [mapped] = await listScmSchedule({ exactRef: fixture.orderRef });
      assert.deepEqual(mapped.pickupOptions, [configuredYard]);
      await assert.rejects(
        updateScmScheduleEntry({
          orderKind: "PO",
          orderRef: fixture.orderRef,
          patch: { method: "MBT", pickupPoint: fixture.vendor },
          updatedBy: "netsuite-address-regression",
          expectedUpdatedAt: mapped.updatedAt
        }),
        invalidPickupError
      );
      const mappedSave = await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: fixture.orderRef,
        patch: { method: "MBT", pickupPoint: configuredYard },
        updatedBy: "netsuite-address-regression",
        expectedUpdatedAt: mapped.updatedAt
      });
      assert.equal(mappedSave.method, "MBT");
      assert.equal(mappedSave.status, "Partially Done");
      assert.equal(mappedSave.pickup_point, configuredYard,
        "the compatibility rule must not bypass a real configured-yard selection");
    });
  } finally {
    await rollback.rollback();
  }
});

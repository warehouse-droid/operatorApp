// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { query } from "../../../src/db.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;
let orderRef;
let orderId;
let editLease;
const planDate = "2038-11-18";
const sessionId = "po-delivery-address-override";
const pickupAddress = "100 Vendor Pickup Road, Toronto, ON";
const refreshedPickupAddress = "200 Refreshed Vendor Road, Toronto, ON";
const deliveryOverride = "777 Customer Drop Road, Mississauga, ON";
const canonicalDeliveryAddress = "3445 Kennedy Road, Toronto, ON";

before(async () => {
  fixture = await createDispatchV2Fixture();
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  orderRef = `PO-DROP-${suffix}`;
  orderId = Number(`97${Date.now().toString().slice(-10)}`);

  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
       source_location, destination_location_id, destination_location,
       dispatch_vendor_yard, dispatch_address, receipt_status,
       initial_scm_status, netsuite_active, synced_at
     ) VALUES (
       $1, $2, $3::date, $4, 'PO delivery override vendor', 'B',
       'Purchase Order : Pending Receipt', 'Vendor Yard', 1, '3445',
       'Vendor Yard', $5, 'not_received', 'Queued', true, now()
     )`,
    [orderId, orderRef, planDate, orderId + 1, pickupAddress]
  );
  await query(
    `INSERT INTO purchase_order_lines (
       purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
       item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, location_id, location,
       netsuite_received_qty, netsuite_received_baseline_qty,
       netsuite_active, synced_at, raw
     ) VALUES (
       $1, $2, $3, 'PO delivery override item', $4, 10, 'EA',
       5, 1, 0, 0, 0,
       10, 0, 0, 1, 1, '3445',
       0, 0, true, now(), '{}'::jsonb
     )`,
    [orderId, orderId + 2, orderId + 3, `${orderRef}-ITEM`]
  );
  editLease = await fixture.acquireLease({ planDate, sessionId });
});

after(async () => {
  await fixture?.close();
});

async function saveDeliveryAddress(address) {
  return fixture.request(`/api/dispatch/orders/${encodeURIComponent(orderRef)}/details?response=targeted`, {
    method: "PUT",
    body: {
      planDate,
      sessionId,
      editLeaseToken: editLease,
      type: "PO",
      sourceTable: "purchase_orders",
      address,
      pickupAddress: "",
      expectedDeliveryDate: planDate,
      windowStart: "0700",
      windowEnd: "1200",
      audit: { sessionId }
    }
  });
}

test("Dispatch can override and clear a PO delivery address without changing its vendor pickup", async () => {
  const saved = await saveDeliveryAddress(deliveryOverride);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));

  const persisted = await query(
    `SELECT dispatch_address, dispatch_delivery_address
       FROM purchase_orders
      WHERE netsuite_id = $1`,
    [orderId]
  );
  assert.equal(persisted.rows[0]?.dispatch_address, pickupAddress);
  assert.equal(persisted.rows[0]?.dispatch_delivery_address, deliveryOverride);

  const order = saved.payload.order;
  assert.ok(order, "The PO-specific targeted response must return the refreshed order.");
  assert.equal(order.sourceAddress, pickupAddress);
  assert.equal(order.defaultSourceAddress, pickupAddress);
  assert.equal(order.pickupAddressOverride, "");
  assert.equal(order.deliveryAddressOverride, deliveryOverride);
  assert.equal(order.defaultDestinationAddress, canonicalDeliveryAddress);
  assert.equal(order.address, deliveryOverride);
  assert.equal(order.destinationAddress, deliveryOverride);
  assert.equal(order.dropoffs?.length, 1);
  assert.equal(order.dropoffs[0]?.defaultAddress, canonicalDeliveryAddress);
  assert.equal(order.dropoffs[0]?.address, deliveryOverride);

  await query(
    `UPDATE purchase_orders
        SET dispatch_address = $2,
            dispatch_parse_source = 'netsuite-refresh',
            synced_at = now()
      WHERE netsuite_id = $1`,
    [orderId, refreshedPickupAddress]
  );
  const refreshed = await fixture.request(`/api/dispatch/v2/order-feed/${encodeURIComponent(orderRef)}`);
  assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.payload));
  assert.equal(refreshed.payload.order?.sourceAddress, refreshedPickupAddress);
  assert.equal(refreshed.payload.order?.deliveryAddressOverride, deliveryOverride);
  assert.equal(refreshed.payload.order?.address, deliveryOverride);

  const cleared = await saveDeliveryAddress("");
  assert.equal(cleared.response.status, 200, JSON.stringify(cleared.payload));
  const clearedPersisted = await query(
    `SELECT dispatch_address, dispatch_delivery_address
       FROM purchase_orders
      WHERE netsuite_id = $1`,
    [orderId]
  );
  assert.equal(clearedPersisted.rows[0]?.dispatch_address, refreshedPickupAddress);
  assert.equal(clearedPersisted.rows[0]?.dispatch_delivery_address, "");
  assert.equal(cleared.payload.order?.sourceAddress, refreshedPickupAddress);
  assert.equal(cleared.payload.order?.deliveryAddressOverride, "");
  assert.equal(cleared.payload.order?.address, canonicalDeliveryAddress);
  assert.equal(cleared.payload.order?.destinationAddress, canonicalDeliveryAddress);
  assert.equal(cleared.payload.order?.dropoffs?.[0]?.address, canonicalDeliveryAddress);
});

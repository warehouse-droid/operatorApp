import assert from "node:assert/strict";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";

after(closeDb);

test("Dispatch keeps the newest valid DB order inside the existing cap and search still finds older orders", async () => {
  await withTransaction(async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const base = 8_995_000_000_000 + Number(suffix.slice(-9)) * 10;
    const newestRef = `RECENT-SO-${suffix}`;
    const olderRef = `OLDER-SO-${suffix}`;

    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer, status, status_text,
         outbound_location_id, outbound_location, sales_order_type,
         fulfillment_status, operator_status, local_yard_order_status,
         dispatch_address, expected_delivery_date, netsuite_active, synced_at
       ) VALUES
         ($1, $2, '9998-08-20'::date, 'Newest Dispatch Candidate', 'B',
          'Sales Order : Pending Fulfillment', 1, '3445', 'Delivery',
          'open', 'open', 'Open', '20 Newest Road, Toronto, ON', current_date, true, now()),
         ($3, $4, '9998-08-19'::date, 'Older Dispatch Candidate', 'B',
          'Sales Order : Pending Fulfillment', 1, '3445', 'Delivery',
          'open', 'open', 'Open', '19 Older Road, Toronto, ON', current_date, true, now())`,
      [base + 1, newestRef, base + 9, olderRef]
    );
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, sku,
         item_type, item_type_text, quantity, unit,
         pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs,
         netsuite_active, location_id, location, synced_at
       ) VALUES
         ($1, 1, $3, 'Recency Test Item', 'RECENCY-TEST',
          'InvtPart', 'Inventory Item', 100, 'EA',
          1, 0, 0, 0, 100, 0, 0, 0, true, 1, '3445', now()),
         ($2, 1, $3, 'Recency Test Item', 'RECENCY-TEST',
          'InvtPart', 'Inventory Item', 100, 'EA',
          1, 0, 0, 0, 100, 0, 0, 0, true, 1, '3445', now())`,
      [base + 1, base + 9, base + 20]
    );

    const capped = await listDispatchOrders({ type: "SO", perTypeLimit: 1 });
    assert.deepEqual(
      capped.filter((order) => [newestRef, olderRef].includes(order.id)).map((order) => order.id),
      [newestRef],
      "The newer transaction date must win even though the older fixture has the larger NetSuite ID."
    );

    const searched = await listDispatchOrders({
      type: "SO",
      perTypeLimit: 1,
      search: olderRef
    });
    assert.ok(searched.some((order) => order.id === olderRef));
  }, { rollback: true });
});

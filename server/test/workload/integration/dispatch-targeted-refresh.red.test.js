// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  enqueueDispatchOrderCatalogRefresh,
  getDispatchOrderCatalogOrder
} from "../../../src/dispatch-order-catalog-repository.js";
import { listDispatchOrders } from "../../../src/dispatch-repository.js";
import { dispatchOrderCatalogTick } from "../../../src/server.js";

after(closeDb);

test("WL-32 numeric webhook identities resolve one indexed Dispatch order under one second", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const targetId = 8_990_099_809;
      const targetRef = "WL-SOM04784";
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer, status, status_text,
           outbound_location_id, outbound_location, sales_order_type,
           fulfillment_status, operator_status, local_yard_order_status,
           dispatch_address, netsuite_active
         ) VALUES ($1, $2, current_date, 'Targeted refresh', 'B',
           'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
           'not_fulfilled', 'open', 'Open', 'Targeted test address', true)`,
        [targetId, targetRef]
      );
      await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, sku, item_type,
           item_type_text, quantity, unit, piece_qty, to_pcs, netsuite_active
         ) VALUES ($1, $2, 8990099809, 'Targeted item', 'WL-TARGET-SKU',
           'InvtPart', 'Inventory Item', 189, 'EA', 189, 1, true)`,
        [targetId, targetId + 1]
      );

      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer, status, status_text,
           outbound_location_id, outbound_location, sales_order_type,
           fulfillment_status, operator_status, local_yard_order_status,
           netsuite_active
         )
         SELECT 8991000000 + seed,
                'WL-DISTRACTOR-' || seed::text,
                current_date,
                'Unrelated order ' || seed::text,
                'B', 'Sales Order : Pending Fulfillment',
                15, '12441', 'Delivery', 'not_fulfilled', 'open', 'Open', true
           FROM generate_series(1, 10000) seed`
      );

      const startedAt = performance.now();
      const orders = await listDispatchOrders({
        type: "SO",
        search: String(targetId),
        exactOrderRefs: [String(targetId)],
        includeScmLinkedSearchRefs: true
      });
      const elapsedMs = performance.now() - startedAt;

      assert.deepEqual(orders.map((order) => order.id), [targetRef]);
      assert.equal(String(orders[0].netsuiteId), String(targetId));
      assert.ok(elapsedMs < 1000, `Numeric targeted refresh took ${elapsedMs.toFixed(1)} ms.`);
    });
  } finally {
    await rollback.rollback();
  }
});

test("WL-33 numeric PO webhook identities resolve the searchable PO without a full scan", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const targetId = 8_990_099_810;
      const targetRef = "WL-PO04784";
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
           source_location, destination_location_id, destination_location,
           dispatch_vendor_yard, dispatch_address, receipt_status,
           initial_scm_status, netsuite_active, synced_at
         ) VALUES (
           $1, $2, current_date, $3, 'Targeted PO vendor', 'B',
           'Purchase Order : Pending Receipt', 'Vendor Yard', 1, '3445',
           'Vendor Yard', '100 PO Test Road', 'not_received',
           'Queued', true, now()
         )`,
        [targetId, targetRef, targetId + 1]
      );
      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
           item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs, location_id, location,
           netsuite_received_qty, netsuite_received_baseline_qty,
           netsuite_active, synced_at, raw
         ) VALUES (
           $1, $2, $3, 'Targeted PO item', 'WL-PO-TARGET-SKU', 50, 'EA',
           5, 5, 0, 0, 0,
           10, 0, 0, 1, 1, '3445',
           0, 0, true, now(), '{}'::jsonb
         )`,
        [targetId, targetId + 2, targetId + 3]
      );
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor, status, status_text,
           source_location, destination_location_id, destination_location,
           receipt_status, initial_scm_status, netsuite_active, synced_at
         )
         SELECT 8993000000 + seed,
                'WL-PO-DISTRACTOR-' || seed::text,
                current_date,
                'Unrelated PO ' || seed::text,
                'B', 'Purchase Order : Pending Receipt',
                'Vendor Yard', 1, '3445', 'not_received', 'Queued', true, now()
           FROM generate_series(1, 10000) seed`
      );

      const startedAt = performance.now();
      const orders = await listDispatchOrders({
        type: "PO",
        search: String(targetId),
        exactOrderRefs: [String(targetId)],
        includeScmLinkedSearchRefs: true
      });
      const elapsedMs = performance.now() - startedAt;

      assert.deepEqual(orders.map((order) => order.id), [targetRef]);
      assert.equal(String(orders[0].netsuiteId), String(targetId));
      assert.ok(elapsedMs < 1000, `Numeric PO targeted refresh took ${elapsedMs.toFixed(1)} ms.`);
    });
  } finally {
    await rollback.rollback();
  }
});

test("WL-34 numeric TO webhook identities resolve the searchable TO without a full scan", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const targetId = 8_990_099_811;
      const targetRef = "WL-TO04784";
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, trandate, status, status_text,
           from_location_id, from_location, to_location_id, to_location,
           outbound_operator_status, local_yard_order_status,
           fulfillment_status, receiving_status, dispatch_planned,
           netsuite_active, synced_at
         ) VALUES (
           $1, $2, current_date, 'B', 'Transfer Order : Pending Fulfillment',
           1, '3445', 15, '12441', 'open', 'Open',
           'not_fulfilled', 'pending', false, true, now()
         )`,
        [targetId, targetRef]
      );
      await query(
        `INSERT INTO transfer_order_lines (
           transfer_order_id, line_id, line_stage, item_id, item_name, sku,
           item_type, item_type_text, quantity, unit,
           pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs,
           netsuite_received_qty, netsuite_active, location_id, location
         ) VALUES (
           $1, $2, 'outbound', $3, 'Targeted TO item', 'WL-TO-TARGET-SKU',
           'InvtPart', 'Inventory Item', 70, 'EA',
           7, 0, 0, 0,
           10, 0, 0, 1,
           0, true, 1, '3445'
         )`,
        [targetId, targetId + 1, targetId + 2]
      );
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, trandate, status, status_text,
           from_location_id, from_location, to_location_id, to_location,
           outbound_operator_status, local_yard_order_status,
           fulfillment_status, receiving_status, dispatch_planned,
           netsuite_active, synced_at
         )
         SELECT 8994000000 + seed,
                'WL-TO-DISTRACTOR-' || seed::text,
                current_date,
                'B', 'Transfer Order : Pending Fulfillment',
                1, '3445', 15, '12441', 'open', 'Open',
                'not_fulfilled', 'pending', false, true, now()
           FROM generate_series(1, 10000) seed`
      );

      const startedAt = performance.now();
      const orders = await listDispatchOrders({
        type: "TO",
        search: String(targetId),
        exactOrderRefs: [String(targetId)],
        includeScmLinkedSearchRefs: true
      });
      const elapsedMs = performance.now() - startedAt;

      assert.deepEqual(orders.map((order) => order.id), [targetRef]);
      assert.equal(String(orders[0].netsuiteId), String(targetId));
      assert.ok(elapsedMs < 1000, `Numeric TO targeted refresh took ${elapsedMs.toFixed(1)} ms.`);
    });
  } finally {
    await rollback.rollback();
  }
});

test("WL-35 a numeric webhook refresh reaches the catalog through the complete targeted pipeline", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const targetId = 8_990_099_812;
      const targetRef = "WL-CATALOG-SOM04784";
      await query("DELETE FROM dispatch_order_catalog_refresh_outbox");
      await query("DELETE FROM dispatch_order_catalog_entries WHERE lower(order_ref) = lower($1)", [targetRef]);
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer, status, status_text,
           outbound_location_id, outbound_location, sales_order_type,
           fulfillment_status, operator_status, local_yard_order_status,
           dispatch_address, netsuite_active
         ) VALUES ($1, $2, current_date, 'Catalog refresh target', 'B',
           'Sales Order : Pending Fulfillment', 15, '12441', 'Delivery',
           'not_fulfilled', 'open', 'Open', 'Catalog test address', true)`,
        [targetId, targetRef]
      );
      await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, sku, item_type,
           item_type_text, quantity, unit, piece_qty, to_pcs, netsuite_active
         ) VALUES ($1, $2, $3, 'Catalog target item', 'WL-CATALOG-SKU',
           'InvtPart', 'Inventory Item', 10, 'EA', 10, 1, true)`,
        [targetId, targetId + 1, targetId + 2]
      );
      await enqueueDispatchOrderCatalogRefresh({
        orderRef: String(targetId),
        orderType: "SALES_ORDER",
        source: "workload-numeric-catalog-test"
      });

      const previousMode = config.dispatch.plannerOrderPoolMode;
      config.dispatch.plannerOrderPoolMode = "on";
      const startedAt = performance.now();
      let tick;
      try {
        tick = await dispatchOrderCatalogTick();
      } finally {
        config.dispatch.plannerOrderPoolMode = previousMode;
      }
      const elapsedMs = performance.now() - startedAt;
      const catalogOrder = await getDispatchOrderCatalogOrder(targetRef);

      assert.deepEqual(tick, { skipped: false, claimed: 1, completed: 1, failed: 0 });
      assert.equal(catalogOrder?.id, targetRef);
      assert.equal(String(catalogOrder?.netsuiteId), String(targetId));
      assert.ok(elapsedMs < 1000, `Complete numeric catalog refresh took ${elapsedMs.toFixed(1)} ms.`);
    });
  } finally {
    await rollback.rollback();
  }
});

test("WL-36 positive PO/TO webhook identities refresh eligible local split-family members", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query("DELETE FROM dispatch_order_catalog_refresh_outbox");
      const poSourceId = 8_990_099_820;
      const poSplitId = -8_990_099_820;
      const poSourceRef = "WL-PO-SOURCE";
      const poSplitRef = "WL-PO-SPLIT";
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, trandate, vendor, status, status_text,
           source_location, destination_location_id, destination_location,
           receipt_status, initial_scm_status, netsuite_active, synced_at
         ) VALUES
           ($1, $2, current_date, 'Split source vendor', 'B',
            'Purchase Order : Pending Receipt', 'Vendor Yard', 1, '3445',
            'not_received', 'Hold', true, now()),
           ($3, $4, current_date, 'Split source vendor', 'B',
            'Purchase Order : Pending Receipt', 'Vendor Yard', 1, '3445',
            'not_received', 'Queued', true, now())`,
        [poSourceId, poSourceRef, poSplitId, poSplitRef]
      );
      await query(
        `INSERT INTO dispatch_scm_po_splits (
           source_po_id, source_po_ref, split_po_id, split_po_ref, status, created_by
         ) VALUES ($1, $2, $3, $4, 'active', 'workload-split-family')`,
        [poSourceId, poSourceRef, poSplitId, poSplitRef]
      );
      await query(
        `INSERT INTO purchase_order_lines (
           purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
           pallet_qty, piece_qty, to_plt, to_pcs, location_id, location,
           netsuite_received_qty, netsuite_received_baseline_qty,
           netsuite_active, synced_at, raw
         ) VALUES (
           $1, $2, $3, 'Split PO item', 'WL-PO-SPLIT-SKU', 20, 'EA',
           2, 0, 10, 1, 1, '3445', 0, 0, true, now(), '{}'::jsonb
         )`,
        [poSplitId, poSourceId + 1, poSourceId + 2]
      );

      const toSourceId = 8_990_099_821;
      const toSplitId = -8_990_099_821;
      const toSourceRef = "WL-TO-SOURCE";
      const toSplitRef = "WL-TO-SPLIT";
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, trandate, status, status_text,
           from_location_id, from_location, to_location_id, to_location,
           outbound_operator_status, local_yard_order_status,
           fulfillment_status, receiving_status, dispatch_planned,
           netsuite_active, synced_at
         ) VALUES
           ($1, $2, current_date, 'B', 'Transfer Order : Pending Fulfillment',
            1, '3445', 15, '12441', 'open', 'Open',
            'not_fulfilled', 'pending', false, false, now()),
           ($3, $4, current_date, 'B', 'Transfer Order : Pending Fulfillment',
            1, '3445', 15, '12441', 'open', 'Open',
            'not_fulfilled', 'pending', false, true, now())`,
        [toSourceId, toSourceRef, toSplitId, toSplitRef]
      );
      await query(
        `INSERT INTO dispatch_scm_to_splits (
           source_to_id, source_to_ref, split_to_id, split_to_ref, status, created_by
         ) VALUES ($1, $2, $3, $4, 'active', 'workload-split-family')`,
        [toSourceId, toSourceRef, toSplitId, toSplitRef]
      );
      await query(
        `INSERT INTO transfer_order_lines (
           transfer_order_id, line_id, line_stage, item_id, item_name, sku,
           item_type, item_type_text, quantity, unit,
           pallet_qty, piece_qty, to_plt, to_pcs,
           netsuite_received_qty, netsuite_active, location_id, location
         ) VALUES (
           $1, $2, 'outbound', $3, 'Split TO item', 'WL-TO-SPLIT-SKU',
           'InvtPart', 'Inventory Item', 30, 'EA',
           3, 0, 10, 1, 0, true, 1, '3445'
         )`,
        [toSplitId, toSourceId + 1, toSourceId + 2]
      );

      const poOrders = await listDispatchOrders({
        type: "PO",
        search: String(poSourceId),
        exactOrderRefs: [String(poSourceId)],
        includeScmLinkedSearchRefs: true
      });
      const toOrders = await listDispatchOrders({
        type: "TO",
        search: String(toSourceId),
        exactOrderRefs: [String(toSourceId)],
        includeScmLinkedSearchRefs: true
      });

      assert.deepEqual(poOrders.map((order) => order.id), [poSplitRef]);
      assert.deepEqual(toOrders.map((order) => order.id), [toSplitRef]);

      await enqueueDispatchOrderCatalogRefresh({
        orderRef: String(poSourceId),
        orderType: "PURCHASE_ORDER",
        source: "workload-split-family"
      });
      await enqueueDispatchOrderCatalogRefresh({
        orderRef: String(toSourceId),
        orderType: "TRANSFER_ORDER",
        source: "workload-split-family"
      });
      const previousMode = config.dispatch.plannerOrderPoolMode;
      config.dispatch.plannerOrderPoolMode = "on";
      let tick;
      try {
        tick = await dispatchOrderCatalogTick();
      } finally {
        config.dispatch.plannerOrderPoolMode = previousMode;
      }
      const [catalogPo, catalogTo] = await Promise.all([
        getDispatchOrderCatalogOrder(poSplitRef),
        getDispatchOrderCatalogOrder(toSplitRef)
      ]);
      assert.deepEqual(tick, { skipped: false, claimed: 2, completed: 2, failed: 0 });
      assert.equal(catalogPo?.id, poSplitRef);
      assert.equal(catalogTo?.id, toSplitRef);
    });
  } finally {
    await rollback.rollback();
  }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  createScmPurchaseOrderSplit,
  listDispatchOrders,
  listScmSchedule,
  updateScmPurchaseOrderSplitDestination,
  updateScmScheduleEntry
} from "../../../src/dispatch-repository.js";
import {
  buildItemReceiptPayload,
  getReceivingOrder,
  listReceivingOrders,
  listReceivingVendors,
  searchReceivingItems
} from "../../../src/receiving-repository.js";

after(closeDb);

async function insertPurchaseOrder({ orderId, orderRef, dispatchRef, scheduleDropoff = "" }) {
  await query(
    `INSERT INTO purchase_orders (
       netsuite_id, tranid, dispatch_ref, trandate, vendor_id, vendor, status, status_text,
       destination_location_id, destination_location, source_location_id, source_location,
       dispatch_vendor_yard, receipt_status, initial_scm_status, netsuite_active, synced_at
     ) VALUES (
       $1, $2, $3, current_date, $4, 'SN1391496 regression vendor', 'pendingReceipt',
       'Purchase Order : Pending Receipt', 15, '12441', 1, '3445',
       'Regression vendor yard', 'not_received', 'Queued', true, now()
     )`,
    [orderId, orderRef, dispatchRef, orderId + 1]
  );
  const locations = [
    { id: 15, yard: "12441", suffix: "A" },
    { id: 1, yard: "3445", suffix: "B" },
    { id: 1, yard: "3445", suffix: "C" }
  ];
  for (const [index, location] of locations.entries()) {
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, sku, quantity, unit,
         item_weight, pallet_qty, layer_qty, section_qty, piece_qty,
         to_plt, to_lyr, to_sec, to_pcs, location_id, location,
         netsuite_received_qty, netsuite_received_baseline_qty,
         netsuite_active, synced_at, raw
       ) VALUES (
         $1, $2, $3, $4, $4, 10, 'EA', 5, 1, 0, 0, 0,
         10, 0, 0, 1, $5, $6, 0, 0, true, now(), $7::jsonb
       )`,
      [
        orderId,
        orderId + 100 + index,
        orderId + 200 + index,
        `${dispatchRef}-ITEM-${location.suffix}`,
        location.id,
        location.yard,
        JSON.stringify({ retainedNetSuiteLocationId: location.id, retainedNetSuiteLocation: location.yard })
      ]
    );
  }
  if (scheduleDropoff) {
    await query(
      `INSERT INTO scm_transport_schedule (
         order_kind, order_ref, method, pickup_point, dropoff_point, status, created_by, updated_by
       ) VALUES ('PO', $1, 'MBT', 'Regression vendor yard', $2, 'Queued', 'test', 'test')`,
      [dispatchRef, scheduleDropoff]
    );
  }
}

test("SN1391496: a saved PO destination overrides every active NetSuite line for Dispatch", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const orderId = 9_139_149_600_000 + Number.parseInt(suffix.slice(0, 6), 16);
      const orderRef = `POB-SN1391496-${suffix}`;
      const dispatchRef = `SN1391496-${suffix}`;
      await insertPurchaseOrder({ orderId, orderRef, dispatchRef, scheduleDropoff: "12441" });

      const orders = await listDispatchOrders({
        type: "PO",
        includeHiddenScm: true,
        search: dispatchRef
      });
      const order = orders.find((candidate) => candidate.id === dispatchRef);
      assert.ok(order, "the retained production-shape PO must remain in the Dispatch order pool");
      assert.equal(Number(order.destinationLocationId), 15);
      assert.equal(order.destinationYard, "12441");
      assert.deepEqual(order.dropoffs.map((dropoff) => [dropoff.destinationLocationId, dropoff.destinationYard]), [
        [15, "12441"]
      ], "the explicit PO override must produce one 12441 Dispatch stop instead of a stale 3445 stop");
      assert.ok(order.items.length === 3 && order.items.every((line) =>
        Number(line.destinationLocationId) === 15 && line.destinationYard === "12441"
      ), "the order-wide override must be projected onto every operational PO line");

      const retained = await query(
        `SELECT location_id, location, raw
           FROM purchase_order_lines
          WHERE purchase_order_id = $1
          ORDER BY line_id`,
        [orderId]
      );
      assert.deepEqual(retained.rows.map((line) => Number(line.location_id)), [15, 1, 1],
        "the local routing override must not rewrite retained NetSuite line evidence");
      assert.deepEqual(retained.rows.map((line) => Number(line.raw.retainedNetSuiteLocationId)), [15, 1, 1]);

      const schedule = await listScmSchedule({ exactRef: dispatchRef });
      const row = schedule.find((candidate) => candidate.orderRef === dispatchRef);
      assert.equal(row?.dropoffPoint, "12441");
      assert.equal(row?.scheduleDropoffPoint, "12441",
        "the UI must distinguish the saved order-wide override from the derived NetSuite destination");

      const receivingOrder = await getReceivingOrder(orderId);
      assert.ok(receivingOrder?.lines.every((line) => Number(line.location_id) === 15),
        "Receiving must use the same order-wide destination for every operational line");
      assert.deepEqual(receivingOrder?.lines.map((line) => Number(line.netsuite_location_id)), [15, 1, 1],
        "Receiving must retain the original NetSuite locations alongside its effective routing");
      const itemReceipt = buildItemReceiptPayload(receivingOrder, [receivingOrder.lines[1]]);
      assert.equal(itemReceipt.item.items.find((line) => line.itemReceive)?.location, 15,
        "a receipt created under the explicit override must target the selected yard");
      const receivingAt12441 = await listReceivingOrders({
        orderType: "purchase_order",
        destinationLocationId: 15,
        search: dispatchRef
      });
      const receivingAt3445 = await listReceivingOrders({
        orderType: "purchase_order",
        destinationLocationId: 1,
        search: dispatchRef
      });
      assert.ok(receivingAt12441.some((candidate) => candidate.netsuite_id === String(orderId)
        || Number(candidate.netsuite_id) === orderId));
      assert.equal(receivingAt3445.length, 0,
        "the same PO must not remain selectable at its overridden-away destination");
      const vendorsAt12441 = await listReceivingVendors({ destinationLocationId: 15 });
      const vendorsAt3445 = await listReceivingVendors({ destinationLocationId: 1 });
      assert.ok(vendorsAt12441.some((candidate) => candidate.vendor === "SN1391496 regression vendor"));
      assert.equal(vendorsAt3445.some((candidate) => candidate.vendor === "SN1391496 regression vendor"), false);
      const itemsAt12441 = await searchReceivingItems({
        orderType: "purchase_order",
        destinationLocationId: 15,
        search: `${dispatchRef}-ITEM`
      });
      const itemsAt3445 = await searchReceivingItems({
        orderType: "purchase_order",
        destinationLocationId: 1,
        search: `${dispatchRef}-ITEM`
      });
      assert.equal(itemsAt12441.length, 3);
      assert.equal(itemsAt3445.length, 0);

      await updateScmScheduleEntry({
        orderKind: "PO",
        orderRef: dispatchRef,
        patch: { dropoffPoint: "" },
        updatedBy: "destination-override-regression",
        expectedUpdatedAt: row?.updatedAt
      });
      const resetOrders = await listDispatchOrders({
        type: "PO",
        includeHiddenScm: true,
        search: dispatchRef
      });
      const reset = resetOrders.find((candidate) => candidate.id === dispatchRef);
      assert.deepEqual(
        reset?.dropoffs.map((dropoff) => Number(dropoff.destinationLocationId)).sort((a, b) => a - b),
        [1, 15],
        "clearing the override must safely restore the retained NetSuite multi-drop routing"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("a PO without a saved destination override retains its true multi-drop line routing", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const orderId = 9_239_149_600_000 + Number.parseInt(suffix.slice(0, 6), 16);
      const orderRef = `POB-MULTI-DROP-${suffix}`;
      const dispatchRef = `SN-MULTI-DROP-${suffix}`;
      await insertPurchaseOrder({ orderId, orderRef, dispatchRef });

      const orders = await listDispatchOrders({
        type: "PO",
        includeHiddenScm: true,
        search: dispatchRef
      });
      const order = orders.find((candidate) => candidate.id === dispatchRef);
      assert.ok(order);
      assert.deepEqual(
        order.dropoffs.map((dropoff) => Number(dropoff.destinationLocationId)).sort((a, b) => a - b),
        [1, 15],
        "retained line destinations must remain authoritative until a user saves an order-wide override"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("the PO Split destination action updates its local child lines and PO/TO Schedule together", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const orderId = 9_339_149_600_000 + Number.parseInt(suffix.slice(0, 6), 16);
      const orderRef = `POB-SPLIT-DEST-${suffix}`;
      const dispatchRef = `SN-SPLIT-SOURCE-${suffix}`;
      const splitRef = `SN-SPLIT-CHILD-${suffix}`;
      await insertPurchaseOrder({ orderId, orderRef, dispatchRef });
      const sourceLine = await query(
        `SELECT id
           FROM purchase_order_lines
          WHERE purchase_order_id = $1
          ORDER BY line_id
          LIMIT 1`,
        [orderId]
      );
      const created = await createScmPurchaseOrderSplit({
        sourcePoRef: dispatchRef,
        newPoRef: splitRef,
        destinationLocationId: 1,
        lines: [{ lineRowId: Number(sourceLine.rows[0].id), pallets: 1 }],
        createdBy: "destination-override-regression"
      });
      const createdSchedule = await listScmSchedule({ exactRef: splitRef });
      const createdScheduleRow = createdSchedule.find((candidate) => candidate.orderRef === splitRef);

      const updated = await updateScmPurchaseOrderSplitDestination({
        splitPoRef: splitRef,
        destinationLocationId: 15,
        updatedBy: "destination-override-regression",
        expectedUpdatedAt: createdScheduleRow?.updatedAt || null
      });
      assert.equal(updated.destinationLocationId, 15);
      assert.equal(updated.destinationLocation, "12441");

      const persisted = await query(
        `SELECT po.destination_location_id, po.destination_location,
                array_agg(DISTINCT line.location_id ORDER BY line.location_id) AS line_location_ids,
                schedule.dropoff_point
           FROM purchase_orders po
           JOIN purchase_order_lines line
             ON line.purchase_order_id = po.netsuite_id
            AND line.netsuite_active = true
           LEFT JOIN scm_transport_schedule schedule
             ON schedule.order_kind = 'PO'
            AND lower(schedule.order_ref) = lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid))
          WHERE po.netsuite_id = $1
          GROUP BY po.netsuite_id, schedule.dropoff_point`,
        [created.split.splitPoId]
      );
      assert.equal(Number(persisted.rows[0]?.destination_location_id), 15);
      assert.equal(persisted.rows[0]?.destination_location, "12441");
      assert.deepEqual(persisted.rows[0]?.line_location_ids.map(Number), [15]);
      assert.equal(persisted.rows[0]?.dropoff_point, "12441",
        "PO Split and PO/TO Schedule must retain one destination source of truth");
      await assert.rejects(
        updateScmPurchaseOrderSplitDestination({
          splitPoRef: splitRef,
          destinationLocationId: 1,
          updatedBy: "stale-destination-override-regression",
          expectedUpdatedAt: createdScheduleRow?.updatedAt || null
        }),
        (error) => error?.code === "SCM_SCHEDULE_STALE",
        "a stale PO Split browser must not overwrite a newer destination"
      );
      const afterStaleAttempt = await query(
        `SELECT destination_location_id
           FROM purchase_orders
          WHERE netsuite_id = $1`,
        [created.split.splitPoId]
      );
      assert.equal(Number(afterStaleAttempt.rows[0]?.destination_location_id), 15);
    });
  } finally {
    await rollback.rollback();
  }
});

test("two first-time split destination overrides have one revision winner", async () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const orderId = 9_539_149_600_000 + Number.parseInt(suffix.slice(0, 6), 16);
  const orderRef = `POB-SPLIT-RACE-${suffix}`;
  const dispatchRef = `SN-SPLIT-RACE-SOURCE-${suffix}`;
  const splitRef = `SN-SPLIT-RACE-CHILD-${suffix}`;
  let splitPoId = null;
  try {
    await insertPurchaseOrder({ orderId, orderRef, dispatchRef });
    const sourceLine = await query(
      `SELECT id
         FROM purchase_order_lines
        WHERE purchase_order_id = $1
        ORDER BY line_id
        LIMIT 1`,
      [orderId]
    );
    const created = await createScmPurchaseOrderSplit({
      sourcePoRef: dispatchRef,
      newPoRef: splitRef,
      destinationLocationId: 1,
      lines: [{ lineRowId: Number(sourceLine.rows[0].id), pallets: 1 }],
      createdBy: "destination-override-race"
    });
    splitPoId = created.split.splitPoId;
    await query(
      `DELETE FROM scm_transport_schedule
        WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
      [splitRef]
    );

    const results = await Promise.allSettled([
      updateScmPurchaseOrderSplitDestination({
        splitPoRef: splitRef,
        destinationLocationId: 15,
        updatedBy: "destination-override-race-a",
        expectedUpdatedAt: null
      }),
      updateScmPurchaseOrderSplitDestination({
        splitPoRef: splitRef,
        destinationLocationId: 28,
        updatedBy: "destination-override-race-b",
        expectedUpdatedAt: null
      })
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const stale = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1, "only one absent-row destination revision may commit");
    assert.equal(stale.length, 1);
    assert.equal(stale[0].reason?.code, "SCM_SCHEDULE_STALE");

    const persisted = await query(
      `SELECT po.destination_location_id, schedule.dropoff_point
         FROM purchase_orders po
         JOIN scm_transport_schedule schedule
           ON schedule.order_kind = 'PO'
          AND lower(schedule.order_ref) = lower(COALESCE(NULLIF(po.dispatch_ref, ''), po.tranid))
        WHERE po.netsuite_id = $1`,
      [splitPoId]
    );
    assert.equal(Number(persisted.rows[0]?.destination_location_id), winners[0].value.destinationLocationId);
    assert.equal(persisted.rows[0]?.dropoff_point, winners[0].value.destinationLocation);
  } finally {
    // Destination changes now create append-only split audit evidence with a
    // RESTRICT foreign key. This concurrency fixture uses randomized refs and
    // intentionally remains in the disposable integration database, which is
    // torn down after the gauntlet.
  }
});

test("unsupported PO destination overrides fail closed before changing the saved route", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const orderId = 9_439_149_600_000 + Number.parseInt(suffix.slice(0, 6), 16);
      const orderRef = `POB-INVALID-DEST-${suffix}`;
      const dispatchRef = `SN-INVALID-DEST-${suffix}`;
      await insertPurchaseOrder({ orderId, orderRef, dispatchRef, scheduleDropoff: "12441" });
      const schedule = await listScmSchedule({ exactRef: dispatchRef });
      const row = schedule.find((candidate) => candidate.orderRef === dispatchRef);

      await assert.rejects(
        updateScmScheduleEntry({
          orderKind: "PO",
          orderRef: dispatchRef,
          patch: { dropoffPoint: "Unknown destination" },
          updatedBy: "destination-override-regression",
          expectedUpdatedAt: row?.updatedAt
        }),
        (error) => error?.code === "SCM_PO_DESTINATION_INVALID"
      );
      const retained = await query(
        `SELECT dropoff_point
           FROM scm_transport_schedule
          WHERE order_kind = 'PO' AND lower(order_ref) = lower($1)`,
        [dispatchRef]
      );
      assert.equal(retained.rows[0]?.dropoff_point, "12441");
    });
  } finally {
    await rollback.rollback();
  }
});

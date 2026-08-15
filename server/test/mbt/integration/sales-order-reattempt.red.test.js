// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query, withTransaction } from "../../../src/db.js";
import { dispatchOrderFromCustomOrder, listDispatchCustomOrders } from "../../../src/dispatch-custom-order-repository.js";
import { getDeliveryOrder, listDeliveryOrders } from "../../../src/delivery-repository.js";
import { listMbbsBillingCandidates } from "../../../src/mbt/mbbs-billing-candidate-service.js";
import { authorizeSalesOrderReload } from "../../../src/sales-order-reload.js";
import {
  createReloadCycle,
  findLocalSalesOrderIdentity,
  findReloadCycleByRequestId,
  getSalesOrderReattemptAuthorizationPreview,
  listActiveReloadOrders,
  lockReloadAuthorizationSnapshot,
  recordReloadLoadAttempt,
  updateReloadCycleStatus,
  updateReloadPackedQuantity
} from "../../../src/sales-order-reload-repository.js";

after(closeDb);

function jsonSnapshot(sql, params = []) {
  return query(`SELECT COALESCE(jsonb_agg(to_jsonb(source) ORDER BY source.sort_key), '[]'::jsonb) AS value FROM (${sql}) source`, params)
    .then((result) => result.rows[0].value);
}

test("completed grouped SO creates a selected, planned, non-billable re-attempt without mutating original evidence", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = Number(String(Date.now()).slice(-7));
      const orderId = 9_400_000_000 + suffix;
      const oldItemId = 8_300_000 + suffix;
      const currentItemId = oldItemId + 1;
      const secondItemId = oldItemId + 2;
      const firstNetSuiteLineId = 4_700_000 + suffix;
      const secondNetSuiteLineId = firstNetSuiteLineId + 1;
      const orderRef = `SOM-REAT-${suffix}`;
      const groupRef = `GROUP-REAT-${suffix}`;
      const operatorId = `reattempt-control-${suffix}`;
      const requestId = crypto.randomUUID();
      const loadRequestId = crypto.randomUUID();
      const planDate = "2095-08-14";

      await query(
        `INSERT INTO operators (
           id, username, display_name, password_hash, password_salt, role, roles, yard_location_ids
         ) VALUES ($1, $1, 'Re-attempt Control', 'hash', 'salt', 'yard_manager',
                   ARRAY['yard_manager']::text[], ARRAY[15]::integer[])`,
        [operatorId]
      );
      await query(
        `INSERT INTO inventory_items (
           item_id, item_name, display_name, item_description, item_type, item_type_text,
           stock_unit, raw, to_plt, to_lyr, to_sec, to_pcs, item_weight, synced_at
         ) VALUES
           ($1, 'HISTORICAL-CG', 'Historical CG', 'Historical 16 pallet colour', 'InvtPart',
            'Inventory Item', 'SQFT', '{}'::jsonb, 91.88, 10.21, 0, 0, 32.02, now()),
           ($2, 'CURRENT-GN', 'Current GN', 'Current replacement colour', 'InvtPart',
            'Inventory Item', 'SQFT', '{}'::jsonb, 91.88, 10.21, 0, 0, 32.02, now()),
           ($3, 'SECOND-DC', 'Second DC', 'Three pallet delivered line', 'InvtPart',
            'Inventory Item', 'SQFT', '{}'::jsonb, 98, 12.25, 0, 0, 32.00208, now())`,
        [oldItemId, currentItemId, secondItemId]
      );
      await query(
        `INSERT INTO inventory_balances (
           item_id, location_id, location, quantity_on_hand, quantity_available, synced_at
         ) VALUES
           ($1, 15, '12441', 5000, 4900, now()),
           ($2, 15, '12441', 6000, 5900, now()),
           ($3, 15, '12441', 7000, 6900, now())`,
        [oldItemId, currentItemId, secondItemId]
      );
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, trandate, customer, status, status_text,
           outbound_location_id, outbound_location, sales_order_type,
           operator_status, local_yard_order_status, fulfillment_status,
           netsuite_active, dispatch_address, dispatch_planned
         ) VALUES (
           $1, $2, CURRENT_DATE, 'Re-attempt Customer', 'B', 'Sales Order : Pending Fulfillment',
           15, '12441', 'Delivery', 'loaded', 'Loaded', 'not_fulfilled', true,
           '77 Clarence St, Woodbridge, ON L4L 1L4', true
         )`,
        [orderId, orderRef]
      );
      const lines = await query(
        `INSERT INTO sales_order_lines (
           sales_order_id, line_id, item_id, item_name, sku, item_description,
           item_type, quantity, unit, location_id, location,
           pallet_qty, layer_qty, section_qty, piece_qty,
           to_plt, to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom,
           item_weight, netsuite_active, confirmed
         ) VALUES
           ($1, $2, $3, 'CURRENT-GN', 'CURRENT-GN', 'Current replacement colour',
            'InvtPart', 1470.08, 'SQFT', 15, '12441', 16, 0, 0, 0,
            91.88, 10.21, 0, 0, 1470.08, 'SQFT', 32.02, true, false),
           ($1, $4, $5, 'SECOND-DC', 'SECOND-DC', 'Three pallet delivered line',
            'InvtPart', 294, 'SQFT', 15, '12441', 3, 0, 0, 0,
            98, 12.25, 0, 0, 294, 'SQFT', 32.00208, true, false)
         RETURNING id, line_id`,
        [orderId, firstNetSuiteLineId, currentItemId, secondNetSuiteLineId, secondItemId]
      );
      const firstLineId = Number(lines.rows.find((line) => Number(line.line_id) === firstNetSuiteLineId)?.id);
      const sourceLoad = await query(
        `INSERT INTO operator_load_records (
           load_type, order_family, order_id, order_ref, operator_id,
           photo_data_url, photo_data_urls, line_snapshot, response
         ) VALUES (
           'sales_order_delivery_load', 'sales_order', $1, $2, $3,
           'data:image/jpeg;base64,b3JpZ2luYWw=', '["data:image/jpeg;base64,b3JpZ2luYWw="]'::jsonb,
           $4::jsonb, '{"localYardOrderStatus":"Loaded"}'::jsonb
         ) RETURNING id`,
        [orderId, orderRef, operatorId, JSON.stringify([{
          lineId: String(firstNetSuiteLineId),
          itemId: String(oldItemId),
          itemName: "HISTORICAL-CG",
          description: "Historical 16 pallet colour",
          quantity: 1470.08,
          unit: "SQFT",
          loadedQty: 1470.08,
          loadedUom: "SQFT",
          packedPallets: 0,
          packedLayers: 0,
          packedSections: 0,
          packedPieces: 0
        }, {
          lineId: String(secondNetSuiteLineId),
          itemId: String(secondItemId),
          itemName: "SECOND-DC",
          description: "Three pallet delivered line",
          quantity: 294,
          unit: "SQFT",
          loadedQty: 294,
          loadedUom: "SQFT",
          packedPallets: 0,
          packedLayers: 0,
          packedSections: 0,
          packedPieces: 0
        }])]
      );
      const originalPlan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note)
         VALUES (CURRENT_DATE, 'confirmed', 'Original immutable group')
         RETURNING id`
      );
      await query(
        `INSERT INTO dispatch_delivery_groups (
           group_ref, plan_id, plan_date, order_type, truck_plate, load_name, active
         ) VALUES ($1, $2, CURRENT_DATE, 'sales_order', 'ORIGINAL-TRUCK', 'Original Load', true)`,
        [groupRef, originalPlan.rows[0].id]
      );
      await query(
        `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
         VALUES ($1, $2, 0)`,
        [groupRef, orderRef]
      );
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_id, plan_date, driver_login, truck_plate, load_id, load_name,
           stop_id, stop_type, order_refs, photo_data_urls, status, started_at, completed_at
         ) VALUES (
           $1, $2, CURRENT_DATE, 'original-driver', 'ORIGINAL-TRUCK', 'ORIGINAL-LOAD', 'Original Load',
           'ORIGINAL-DROP', 'dropoff', $3::jsonb, '[]'::jsonb, 'complete', now() - interval '1 hour', now()
         )`,
        [`ORIGINAL-JOB-${suffix}`, originalPlan.rows[0].id, JSON.stringify([orderRef])]
      );

      const protectedBefore = await jsonSnapshot(
        `SELECT '1-order' AS sort_key, to_jsonb(o) AS row FROM sales_orders o WHERE o.netsuite_id = $1
         UNION ALL
         SELECT '2-line-' || l.id, to_jsonb(l) FROM sales_order_lines l WHERE l.sales_order_id = $1
         UNION ALL
         SELECT '3-group', to_jsonb(g) FROM dispatch_delivery_groups g WHERE g.group_ref = $2
         UNION ALL
         SELECT '4-member-' || m.position, to_jsonb(m) FROM dispatch_delivery_group_members m WHERE m.group_ref = $2
         UNION ALL
         SELECT '5-driver-' || r.id, to_jsonb(r) FROM driver_job_records r WHERE r.order_refs @> $3::jsonb
         UNION ALL
         SELECT '6-balance-' || b.item_id, to_jsonb(b) FROM inventory_balances b WHERE b.item_id = ANY($4::bigint[])`,
        [orderId, groupRef, JSON.stringify([orderRef]), [oldItemId, currentItemId, secondItemId]]
      );

      const preview = await getSalesOrderReattemptAuthorizationPreview(orderId);
      assert.equal(preview.sourceLoadRecordId, Number(sourceLoad.rows[0].id));
      assert.equal(preview.completedDropoff, true);
      assert.equal(preview.lines[0].historicalSku, "HISTORICAL-CG");
      assert.equal(preview.lines[0].currentSku, "CURRENT-GN");
      assert.equal(preview.lines[0].historicalPalletQty, 16);
      assert.equal(preview.lines[0].skuMismatch, true);

      const dependencies = {
        findCycleByRequestId: findReloadCycleByRequestId,
        findLocalOrderIdentity: findLocalSalesOrderIdentity,
        assertActorYardAccess: async () => {},
        refreshOrder: async () => {},
        withTransaction,
        lockAuthorizationSnapshot: lockReloadAuthorizationSnapshot,
        createCycle: createReloadCycle,
        writeAudit: async () => {}
      };
      const input = {
        orderId,
        requestId,
        sourceLoadRecordId: preview.sourceLoadRecordId,
        lineSelections: [{
          lineKey: preview.lines[0].lineKey,
          palletQty: 16,
          reason: "Historical colour must be delivered again"
        }, {
          lineKey: preview.lines[1].lineKey,
          palletQty: 0,
          reason: ""
        }],
        actor: { id: operatorId }
      };
      const cycle = await authorizeSalesOrderReload(input, dependencies);
      const replay = await authorizeSalesOrderReload(input, dependencies);
      assert.equal(replay.id, cycle.id);
      assert.equal(cycle.workflowKind, "sales_order_reattempt");
      assert.equal(cycle.sourceLoadRecordId, preview.sourceLoadRecordId);
      assert.equal(cycle.reattemptOrderRef, `${orderRef}-R1`);
      assert.equal(cycle.reattemptOrder?.orderKind, "sales_order_reattempt");
      assert.equal(cycle.reattemptOrder?.billingDisposition, "linked_parent_no_charge");
      assert.equal(cycle.lines.length, 2);
      assert.equal(cycle.lines[0].targetPalletQty, 16);
      assert.equal(cycle.lines[0].historicalSku, "HISTORICAL-CG");
      assert.equal(cycle.lines[0].currentSku, "CURRENT-GN");
      assert.equal(cycle.lines[1].selectedForReattempt, false);
      assert.equal(cycle.lines[1].alreadyDeliveredPalletQty, 3);

      const persistedPair = await query(
        `SELECT cycle.id AS cycle_id, child.id AS child_id, child.ref_number,
                child.order_kind, child.parent_order_ref, child.billing_disposition,
                child.pallet_qty, child.weight_lbs, child.line_snapshot
           FROM operator_reload_cycles cycle
           JOIN dispatch_custom_orders child ON child.id = cycle.reattempt_order_id
          WHERE cycle.id = $1`,
        [cycle.id]
      );
      assert.equal(persistedPair.rowCount, 1);
      assert.equal(persistedPair.rows[0].ref_number, `${orderRef}-R1`);
      assert.equal(persistedPair.rows[0].order_kind, "sales_order_reattempt");
      assert.equal(persistedPair.rows[0].parent_order_ref, orderRef);
      assert.equal(persistedPair.rows[0].billing_disposition, "linked_parent_no_charge");
      assert.equal(Number(persistedPair.rows[0].pallet_qty), 16);
      assert.equal(Number(persistedPair.rows[0].weight_lbs), 47_071.9616);
      assert.equal(persistedPair.rows[0].line_snapshot[0].sku, "HISTORICAL-CG");

      assert.deepEqual(await listActiveReloadOrders({ locationId: 15 }), [], "Unplanned re-attempt must not reach Operator.");
      await assert.rejects(
        updateReloadPackedQuantity({
          orderId,
          lineId: firstLineId,
          values: { pallets: 1 },
          operatorId,
          absolute: true
        }),
        (error) => error?.code === "REATTEMPT_PLAN_REQUIRED",
        "Direct API activity must also remain blocked until Dispatch plans the child."
      );
      const [storedChild] = await listDispatchCustomOrders({ search: `${orderRef}-R1`, includeCompleted: true });
      const plannerOrder = dispatchOrderFromCustomOrder(storedChild);
      assert.equal(plannerOrder.salesOrderReattempt, true);
      assert.equal(plannerOrder.parentOrderRef, orderRef);
      assert.equal(plannerOrder.items[0].sku, "HISTORICAL-CG");
      assert.equal(plannerOrder.items[0].pallets, 16);
      assert.equal(plannerOrder.pallets, 16);
      assert.equal(plannerOrder.weight, 47_071.9616);
      assert.equal(plannerOrder.sourceYard, "12441");
      assert.equal(plannerOrder.destinationAddress, "77 Clarence St, Woodbridge, ON L4L 1L4");

      const childPlan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note)
         VALUES ($1::date, 'confirmed', 'Re-attempt child plan')
         RETURNING id`
        , [planDate]
      );
      await query(
        `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
         VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb)`,
        [childPlan.rows[0].id, JSON.stringify([plannerOrder]), JSON.stringify([{
          id: "REAT-T1",
          plate: "REAT-TRUCK",
          loads: [{
            id: "REAT-L1",
            name: "Re-attempt Load 1",
            stops: [{
              id: "REAT-PICK",
              loadId: "REAT-L1",
              type: "pick",
              orderId: `${orderRef}-R1`,
              location: "12441"
            }, {
              id: "REAT-DROP",
              loadId: "REAT-L1",
              type: "drop",
              orderId: `${orderRef}-R1`,
              location: "77 Clarence St, Woodbridge, ON L4L 1L4"
            }]
          }]
        }])]
      );

      const operatorOrders = await listDeliveryOrders({
        locationId: 15,
        status: "active",
        orderType: "sales_order",
        planDate,
        truckPlate: "REAT-TRUCK"
      });
      assert.equal(operatorOrders.length, 1);
      assert.equal(operatorOrders[0].tranid, `${orderRef}-R1`);
      assert.equal(operatorOrders[0].original_order_ref, orderRef);
      assert.equal(operatorOrders[0].dispatch_plan_date, planDate);
      assert.equal(operatorOrders[0].dispatch_truck_plate, "REAT-TRUCK");
      assert.equal(operatorOrders[0].dispatch_load_name, "Re-attempt Load 1");
      assert.equal(operatorOrders[0].lines.length, 1);
      assert.equal(operatorOrders[0].lines[0].sku, "HISTORICAL-CG");

      const detail = await getDeliveryOrder(orderId);
      assert.equal(detail?.tranid, `${orderRef}-R1`);
      assert.equal(detail?.reload_cycle?.id, cycle.id);
      assert.equal(detail?.lines.length, 1);

      await updateReloadPackedQuantity({
        orderId,
        lineId: firstLineId,
        values: { pallets: 16 },
        operatorId,
        absolute: true
      });
      await updateReloadCycleStatus({ orderId, status: "packed", operatorId });
      const loaded = await recordReloadLoadAttempt(orderId, operatorId, {
        requestId: loadRequestId,
        photoDataUrls: [
          "data:image/jpeg;base64,cmVhdHRlbXB0LTE=",
          "data:image/jpeg;base64,cmVhdHRlbXB0LTI="
        ]
      });
      assert.equal(loaded.completed, true);
      assert.equal(loaded.attemptLines.length, 1);
      assert.equal(loaded.attemptLines[0].sku, "HISTORICAL-CG");
      assert.equal(loaded.attemptLines[0].packedPallets, 16);

      await query(
        `UPDATE dispatch_custom_orders
            SET status = 'completed', completed_at = now(), updated_by = 'driver', updated_at = now()
          WHERE id = $1`,
        [cycle.reattemptOrderId]
      );
      const billing = await listMbbsBillingCandidates({
        actor: { operatorId, roles: ["admin"] },
        search: `${orderRef}-R1`,
        limit: 100
      });
      assert.equal(
        billing.items.some((candidate) => [
          ...(candidate.references || []),
          ...(candidate.memberReferences || [])
        ].some((reference) => String(reference.rootReference || "").toUpperCase() === `${orderRef}-R1`.toUpperCase())),
        false,
        "The linked re-attempt child must be excluded from every MBBS candidate source."
      );

      const protectedAfter = await jsonSnapshot(
        `SELECT '1-order' AS sort_key, to_jsonb(o) AS row FROM sales_orders o WHERE o.netsuite_id = $1
         UNION ALL
         SELECT '2-line-' || l.id, to_jsonb(l) FROM sales_order_lines l WHERE l.sales_order_id = $1
         UNION ALL
         SELECT '3-group', to_jsonb(g) FROM dispatch_delivery_groups g WHERE g.group_ref = $2
         UNION ALL
         SELECT '4-member-' || m.position, to_jsonb(m) FROM dispatch_delivery_group_members m WHERE m.group_ref = $2
         UNION ALL
         SELECT '5-driver-' || r.id, to_jsonb(r) FROM driver_job_records r WHERE r.order_refs @> $3::jsonb
         UNION ALL
         SELECT '6-balance-' || b.item_id, to_jsonb(b) FROM inventory_balances b WHERE b.item_id = ANY($4::bigint[])`,
        [orderId, groupRef, JSON.stringify([orderRef]), [oldItemId, currentItemId, secondItemId]]
      );
      assert.deepEqual(protectedAfter, protectedBefore);
    });
  } finally {
    await rollback.rollback();
  }
});

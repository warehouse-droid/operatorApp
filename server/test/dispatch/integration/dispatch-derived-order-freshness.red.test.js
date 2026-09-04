import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { cancelLocalCoOrder, listDispatchOrders, upsertLocalCoOrder } from "../../../src/dispatch-repository.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan,
  syncDispatchGlobalOrderTransitCo
} from "../../../src/dispatch-delivery-group-repository.js";
import {
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  removeDispatchOrderCatalogOrder,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import { getDispatchV2Bootstrap } from "../../../src/dispatch-planner-v2-repository.js";

after(closeDb);

const yardId = new Map([
  ["3445", 1],
  ["12441", 15],
  ["2967", 28],
  ["150", 26]
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function simulateNetSuiteSalesOrderSync({ netsuiteId, lineId, ref, yard, status = "B", statusText = "Sales Order : Pending Fulfillment" }) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       fulfillment_status, outbound_location_id, outbound_location,
       sales_order_type, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active, synced_at
     ) VALUES (
       $1, $2, DATE '2096-06-01', $3, $4, $5,
       'not_fulfilled', $6, $7,
       'Delivery', 'open', 'Open',
       '1 Freshness Test Road', true, now()
     )
     ON CONFLICT (netsuite_id) DO UPDATE
       SET status = EXCLUDED.status,
           status_text = EXCLUDED.status_text,
           outbound_location_id = EXCLUDED.outbound_location_id,
           outbound_location = EXCLUDED.outbound_location,
           synced_at = now()`,
    [netsuiteId, ref, `${ref} customer`, status, statusText, yardId.get(yard), yard]
  );
  await query(
    `INSERT INTO sales_order_lines (
       id, sales_order_id, line_id, item_id, item_name, sku,
       quantity, unit, item_weight, pallet_qty, netsuite_active, synced_at
     ) VALUES ($1, $2, 1, $3, $4, $5, 10, 'EA', 2, 1, true, now())
     ON CONFLICT (id) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           netsuite_active = true,
           synced_at = now()`,
    [lineId, netsuiteId, lineId + 10, `${ref} item`, `${ref}-ITEM`]
  );
  const current = (await listDispatchOrders({ type: "SO", exactOrderRefs: [ref] }))
    .find((order) => order.id === ref);
  assert.ok(current, `The simulated NetSuite mirror must expose ${ref}.`);
  await upsertDispatchOrderCatalog({
    orders: [current],
    source: "simulated-netsuite-webhook"
  });
  return current;
}

async function storePlanSnapshot({ planId, revision, orders }) {
  await query("UPDATE dispatch_plans SET revision = $2, updated_at = now() WHERE id = $1", [planId, revision]);
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
     VALUES ($1, $2::jsonb, '[]'::jsonb, '{}'::jsonb, now())
     ON CONFLICT (plan_id) DO UPDATE
       SET orders = EXCLUDED.orders,
           trucks = EXCLUDED.trucks,
           summary = EXCLUDED.summary,
           saved_at = now()`,
    [planId, JSON.stringify(orders)]
  );
}

function groupOrder(groupRef, members) {
  const pickupLocations = [...new Set(members.flatMap((member) => member.pickupLocations || []))];
  return {
    ...members[0],
    id: groupRef,
    customer: `${members.length} orders grouped`,
    sourceYard: pickupLocations[0] || "",
    pickupLocations,
    childOrders: members.map((member) => member.id),
    childOrderDetails: members.map(clone),
    items: members.flatMap((member) => member.items || []),
    pallets: members.reduce((sum, member) => sum + Number(member.pallets || 0), 0),
    salesQty: members.reduce((sum, member) => sum + Number(member.salesQty || 0), 0),
    planOwned: true
  };
}

test("NetSuite refresh converges split, group, CO, pool, and bootstrap without rewriting the saved snapshot", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
      const numeric = Number.parseInt(suffix.slice(0, 8), 16);
      const firstRef = `SO-FRESH-${suffix}-1`;
      const secondRef = `SO-FRESH-${suffix}-2`;
      const splitRef = `${firstRef}-S1`;
      const groupRef = `GO-FRESH-${suffix}`;
      const coRef = `CO-${groupRef}`;
      const firstId = 7_100_000_000 + numeric;
      const secondId = firstId + 1;
      const firstLineId = 8_100_000_000 + numeric;
      const secondLineId = firstLineId + 1;
      let first = await simulateNetSuiteSalesOrderSync({
        netsuiteId: firstId,
        lineId: firstLineId,
        ref: firstRef,
        yard: "2967"
      });
      const second = await simulateNetSuiteSalesOrderSync({
        netsuiteId: secondId,
        lineId: secondLineId,
        ref: secondRef,
        yard: "3445"
      });
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2096-06-01', 'draft', $1, 1)
         RETURNING id`,
        [`derived freshness ${suffix}`]
      );
      const planId = String(planRow.rows[0].id);

      const split = {
        ...clone(first),
        id: splitRef,
        originalOrderId: firstRef,
        salesQty: 4,
        items: first.items.map((item) => ({ ...item, quantity: 4 }))
      };
      await storePlanSnapshot({ planId, revision: 1, orders: [split] });
      await syncDispatchDeliveryGroupsFromPlan({
        id: planId,
        planDate: "2096-06-01",
        revision: 1,
        orders: [split],
        trucks: []
      });
      const frozenSplitSnapshot = clone((await query(
        "SELECT orders FROM dispatch_plan_snapshots WHERE plan_id = $1",
        [planId]
      )).rows[0].orders);

      first = await simulateNetSuiteSalesOrderSync({
        netsuiteId: firstId,
        lineId: firstLineId,
        ref: firstRef,
        yard: "12441",
        statusText: "Sales Order : Partially Fulfilled"
      });
      const refreshedSplit = await getDispatchOrderCatalogOrder(splitRef);
      assert.equal(refreshedSplit.sourceYard, "12441");
      assert.deepEqual(refreshedSplit.pickupLocations, ["12441"]);
      assert.equal(refreshedSplit.netsuiteStatusText, "Sales Order : Partially Fulfilled");
      assert.equal(refreshedSplit.salesQty, 4, "Source refresh must preserve the split allocation.");

      const splitBootstrap = await getDispatchV2Bootstrap({ planId, date: "2096-06-01" });
      const liveSplit = splitBootstrap.plan.assignedOrderSnapshots.find((order) => order.id === splitRef);
      assert.equal(liveSplit?.sourceYard, "12441", "Bootstrap must overlay the current global split definition.");
      assert.deepEqual(
        (await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id = $1", [planId])).rows[0].orders,
        frozenSplitSnapshot,
        "Live reconciliation must not rewrite the persisted snapshot."
      );

      await deactivateDispatchGlobalOrderDefinitions([splitRef]);
      await upsertDispatchOrderCatalog({ orders: [split], source: "delayed-stale-split-refresh" });
      assert.equal(await getDispatchOrderCatalogOrder(splitRef), null);
      assert.equal((await listDispatchOrderPool({ type: "SO", search: splitRef, limit: 20 })).orders.length, 0);
      assert.equal(
        (await query("SELECT count(*)::int AS count FROM dispatch_order_catalog_entries WHERE lower(order_ref) = lower($1)", [splitRef]))
          .rows[0].count,
        0,
        "A delayed catalog refresh must not persist a retired split shadow."
      );

      const group = groupOrder(groupRef, [first, second]);
      await storePlanSnapshot({ planId, revision: 2, orders: [group] });
      await syncDispatchDeliveryGroupsFromPlan({
        id: planId,
        planDate: "2096-06-01",
        revision: 2,
        orders: [group],
        trucks: []
      });
      const frozenGroupSnapshot = clone((await query(
        "SELECT orders FROM dispatch_plan_snapshots WHERE plan_id = $1",
        [planId]
      )).rows[0].orders);

      first = await simulateNetSuiteSalesOrderSync({
        netsuiteId: firstId,
        lineId: firstLineId,
        ref: firstRef,
        yard: "150"
      });
      let refreshedGroup = await getDispatchOrderCatalogOrder(groupRef);
      assert.deepEqual(refreshedGroup.pickupLocations, ["150", "3445"]);
      assert.equal(refreshedGroup.childOrderDetails.find((child) => child.id === firstRef)?.sourceYard, "150");
      assert.equal(
        (await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 })).orders[0]?.sourceYard,
        "150"
      );
      const groupBootstrap = await getDispatchV2Bootstrap({ planId, date: "2096-06-01" });
      assert.deepEqual(
        groupBootstrap.plan.assignedOrderSnapshots.find((order) => order.id === groupRef)?.pickupLocations,
        ["150", "3445"]
      );
      assert.deepEqual(
        (await query("SELECT orders FROM dispatch_plan_snapshots WHERE plan_id = $1", [planId])).rows[0].orders,
        frozenGroupSnapshot
      );

      let co = await upsertLocalCoOrder({
        sourceOrderRef: groupRef,
        fromYard: "150",
        toYard: "12441",
        order: refreshedGroup,
        requestedBy: "derived-freshness-test"
      });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: groupRef, co });
      refreshedGroup = await getDispatchOrderCatalogOrder(groupRef);
      assert.equal(refreshedGroup.sourceYard, "12441");
      assert.deepEqual(refreshedGroup.transitOriginalPickupLocations, ["150", "3445"]);

      first = await simulateNetSuiteSalesOrderSync({
        netsuiteId: firstId,
        lineId: firstLineId,
        ref: firstRef,
        yard: "2967"
      });
      refreshedGroup = await getDispatchOrderCatalogOrder(groupRef);
      assert.equal(refreshedGroup.sourceYard, "12441", "An active CO remains the live route authority.");
      assert.deepEqual(
        refreshedGroup.transitOriginalPickupLocations,
        ["2967", "3445"],
        "The recoverable base route must still advance with NetSuite."
      );

      const cancelled = await cancelLocalCoOrder(coRef, { requestedBy: "derived-freshness-test" });
      assert.equal(cancelled.status, "cancelled");
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: groupRef, co: cancelled, cancelled: true });
      await removeDispatchOrderCatalogOrder(coRef);
      refreshedGroup = await getDispatchOrderCatalogOrder(groupRef);
      assert.equal(refreshedGroup.transitCo ?? null, null);
      assert.deepEqual(refreshedGroup.pickupLocations, ["2967", "3445"]);
      assert.equal(refreshedGroup.sourceYard, "2967");

      co = await upsertLocalCoOrder({
        sourceOrderRef: groupRef,
        fromYard: "2967",
        toYard: "150",
        order: refreshedGroup,
        requestedBy: "derived-freshness-test",
        reactivateCancelled: true
      });
      assert.equal(co.status, "pending_load");
      assert.equal(co.from_location, "2967");
      assert.equal(co.to_location, "150");
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: groupRef, co });
      const coCards = await listDispatchOrders({ type: "CO", exactOrderRefs: [coRef] });
      await upsertDispatchOrderCatalog({ orders: coCards, source: "co-reinitialized" });
      const reinitializedCo = (await listDispatchOrderPool({ type: "CO", search: coRef, limit: 20 })).orders[0];
      assert.equal(reinitializedCo.sourceYard, "2967");
      assert.equal(reinitializedCo.destinationYard, "150");
      assert.equal((await getDispatchOrderCatalogOrder(groupRef)).sourceYard, "150");

      const cancelledAgain = await cancelLocalCoOrder(coRef, { requestedBy: "derived-freshness-test" });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: groupRef, co: cancelledAgain, cancelled: true });
      await removeDispatchOrderCatalogOrder(coRef);
      await deactivateDispatchGlobalOrderDefinitions([groupRef]);
      await upsertDispatchOrderCatalog({ orders: [group], source: "delayed-stale-group-refresh" });
      assert.equal(await getDispatchOrderCatalogOrder(groupRef), null);
      assert.equal((await listDispatchOrderPool({ type: "SO", search: groupRef, limit: 20 })).orders.length, 0);
      assert.equal(
        (await query("SELECT count(*)::int AS count FROM dispatch_order_catalog_entries WHERE lower(order_ref) = lower($1)", [groupRef]))
          .rows[0].count,
        0,
        "A delayed catalog refresh must not persist a retired group shadow."
      );
      await deactivateDispatchGlobalOrderDefinitions([groupRef]);
      assert.equal(
        (await query("SELECT count(*)::int AS count FROM dispatch_order_catalog_entries WHERE lower(order_ref) = lower($1)", [groupRef]))
          .rows[0].count,
        0,
        "Repeated retirement must clean a shadow inserted after the first ungroup."
      );
    });
  } finally {
    await rollback.rollback();
  }
});

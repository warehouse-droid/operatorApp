import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { cancelLocalCoOrder, listDispatchOrders, upsertLocalCoOrder } from "../../../src/dispatch-repository.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan,
  syncDispatchGlobalOrderTransitCo
} from "../../../src/dispatch-delivery-group-repository.js";
import {
  claimDispatchOrderCatalogRefreshes,
  completeDispatchOrderCatalogRefresh,
  enqueueDispatchOrderCatalogRefresh,
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  removeDispatchOrderCatalogOrder,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import { getDispatchV2Bootstrap } from "../../../src/dispatch-planner-v2-repository.js";
import { saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";

after(closeDb);

const FIRST_REF = "SOA07894";
const SECOND_REF = "SOA07895";
const GROUP_REF = "GOA-7894-7895";
const CO_REF = `CO-${GROUP_REF}`;
const SPLIT_REF = `${FIRST_REF}-S1`;
const PLAN_DATE = "2096-09-01";
const yardId = new Map([["3445", 1], ["12441", 15], ["2967", 28], ["150", 26]]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function orderView(order) {
  if (!order) {return null;}
  return {
    id: order.id,
    type: order.type,
    sourceYard: order.sourceYard || "",
    sourceLocationId: order.sourceLocationId ?? order.pickupLocationId ?? null,
    sourceAddress: order.sourceAddress || order.pickupAddress || "",
    pickupLocations: order.pickupLocations || [],
    destinationYard: order.destinationYard || "",
    destinationLocationId: order.destinationLocationId ?? null,
    destinationAddress: order.destinationAddress || order.address || "",
    eligible: order.eligible !== false,
    readOnly: order.readOnly === true,
    dispatchPlanned: order.dispatchPlanned === true,
    plannedOrderRef: order.plannedOrderRef || "",
    catalogHydrated: order.catalogHydrated !== false,
    originalOrderId: order.originalOrderId || "",
    childOrders: order.childOrders || [],
    childOrderDetails: (order.childOrderDetails || []).map((child) => ({
      id: child.id,
      sourceYard: child.sourceYard || "",
      pickupLocations: child.pickupLocations || []
    })),
    transitCo: order.transitCo ? {
      id: order.transitCo.id,
      fromYard: order.transitCo.fromYard,
      toYard: order.transitCo.toYard,
      status: order.transitCo.status || ""
    } : null,
    transitOriginalPickupLocations: order.transitOriginalPickupLocations || [],
    netsuiteStatusText: order.netsuiteStatusText || ""
  };
}

async function simulateNetSuiteEvent({ netsuiteId, lineId, ref, yard, statusText = "Sales Order : Pending Fulfillment" }) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, trandate, customer, status, status_text,
       fulfillment_status, outbound_location_id, outbound_location,
       sales_order_type, operator_status, local_yard_order_status,
       dispatch_address, netsuite_active, synced_at
     ) VALUES (
       $1, $2, DATE '2096-09-01', $3, 'B', $4,
       'not_fulfilled', $5, $6,
       'Delivery', 'open', 'Open',
       '7894 Replay Road', true, now()
     )
     ON CONFLICT (netsuite_id) DO UPDATE
       SET status_text = EXCLUDED.status_text,
           outbound_location_id = EXCLUDED.outbound_location_id,
           outbound_location = EXCLUDED.outbound_location,
           synced_at = now()`,
    [netsuiteId, ref, `${ref} replay customer`, statusText, yardId.get(yard), yard]
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
    [lineId, netsuiteId, lineId + 100, `${ref} replay item`, `${ref}-ITEM`]
  );
  const queued = await enqueueDispatchOrderCatalogRefresh({
    orderRef: ref,
    orderType: "SO",
    source: `replay-netsuite-event-${ref}`
  });
  const claimed = await claimDispatchOrderCatalogRefreshes({ limit: 25 });
  assert.equal(claimed.some((refresh) => String(refresh.id) === String(queued.id)), true,
    `The production refresh outbox must claim the ${ref} event.`);
  const current = (await listDispatchOrders({ type: "SO", exactOrderRefs: [ref] }))
    .find((order) => order.id === ref);
  assert.ok(current, `Simulated NetSuite event must expose ${ref}.`);
  await upsertDispatchOrderCatalog({ orders: [current], source: `replay-netsuite-${ref}` });
  await completeDispatchOrderCatalogRefresh(queued.id);
  return current;
}

async function storePlanSnapshot({ planId, revision, orders, trucks = [] }) {
  await query("UPDATE dispatch_plans SET revision = $2, updated_at = now() WHERE id = $1", [planId, revision]);
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
     VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, now())
     ON CONFLICT (plan_id) DO UPDATE
       SET orders = EXCLUDED.orders,
           trucks = EXCLUDED.trucks,
           summary = EXCLUDED.summary,
           saved_at = now()`,
    [planId, JSON.stringify(orders), JSON.stringify(trucks)]
  );
}

function groupOrder(first, second) {
  const pickupLocations = [...new Set([...(first.pickupLocations || []), ...(second.pickupLocations || [])])];
  return {
    ...clone(first),
    id: GROUP_REF,
    customer: "SOA07894 + SOA07895 replay group",
    sourceYard: pickupLocations[0],
    pickupLocations,
    childOrders: [FIRST_REF, SECOND_REF],
    childOrderDetails: [clone(first), clone(second)],
    items: [...(first.items || []), ...(second.items || [])],
    salesQty: Number(first.salesQty || 0) + Number(second.salesQty || 0),
    planOwned: true
  };
}

async function captureStage({ number, event, planId }) {
  // This replay runs inside one rollback transaction. Keep the reads ordered so
  // every backend/frontend witness comes from the same logical event boundary.
  const group = await getDispatchOrderCatalogOrder(GROUP_REF);
  const co = await getDispatchOrderCatalogOrder(CO_REF);
  const split = await getDispatchOrderCatalogOrder(SPLIT_REF);
  const bootstrap = await getDispatchV2Bootstrap({ planId, date: PLAN_DATE });
  const groupPool = await listDispatchOrderPool({ search: GROUP_REF, limit: 20 });
  const coPool = await listDispatchOrderPool({ search: CO_REF, limit: 20 });
  const firstPool = await listDispatchOrderPool({ search: FIRST_REF, limit: 20 });
  const secondPool = await listDispatchOrderPool({ search: SECOND_REF, limit: 20 });
  const splitPool = await listDispatchOrderPool({ search: SPLIT_REF, limit: 20 });
  const backend = await query(
      `SELECT jsonb_build_object(
         'sources', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'ref', source.tranid,
             'yard', source.outbound_location,
             'statusText', source.status_text
           ) ORDER BY source.tranid)
             FROM sales_orders source
            WHERE source.tranid = ANY($1::text[])
         ), '[]'::jsonb),
         'group', (
           SELECT jsonb_build_object(
             'active', active,
             'order', full_order
           ) FROM dispatch_global_order_groups
            WHERE lower(group_ref) = lower($2)
         ),
         'split', (
           SELECT jsonb_build_object(
             'active', active,
             'parentOrderRef', parent_order_ref,
             'order', full_order
           ) FROM dispatch_global_order_splits
            WHERE lower(split_ref) = lower($3)
         ),
         'co', (
           SELECT jsonb_build_object(
             'ref', co_ref,
             'sourceOrderRef', source_order_ref,
             'fromLocationId', from_location_id,
             'fromYard', from_location,
             'toLocationId', to_location_id,
             'toYard', to_location,
             'status', status
           ) FROM local_co_orders
            WHERE lower(co_ref) = lower($4)
         ),
         'catalogRefs', COALESCE((
           SELECT jsonb_agg(order_ref ORDER BY order_ref)
             FROM dispatch_order_catalog_entries
            WHERE lower(order_ref) = ANY($5::text[])
         ), '[]'::jsonb),
         'catalogEntries', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'ref', order_ref,
             'eligible', eligible,
             'source', source,
             'card', card
           ) ORDER BY order_ref)
             FROM dispatch_order_catalog_entries
            WHERE lower(order_ref) = ANY($5::text[])
         ), '[]'::jsonb),
         'groupMembers', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'ref', member_order_ref,
             'position', position,
             'hidesMember', hides_member
           ) ORDER BY position)
             FROM dispatch_global_order_group_members
            WHERE lower(group_ref) = lower($2)
         ), '[]'::jsonb),
         'refreshes', COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'orderRef', order_ref,
             'status', status,
             'source', source
           ) ORDER BY id)
             FROM dispatch_order_catalog_refresh_outbox
            WHERE lower(order_ref) = ANY($5::text[])
         ), '[]'::jsonb),
         'catalogState', (
           SELECT jsonb_build_object(
             'generation', generation,
             'catalogCount', catalog_count,
             'status', status
           ) FROM dispatch_order_catalog_state WHERE singleton = true
         ),
         'savedSnapshot', (
           SELECT orders FROM dispatch_plan_snapshots WHERE plan_id = $6
         )
       ) AS state`,
      [
        [FIRST_REF, SECOND_REF],
        GROUP_REF,
        SPLIT_REF,
        CO_REF,
        [FIRST_REF, SECOND_REF, GROUP_REF, CO_REF, SPLIT_REF].map((ref) => ref.toLowerCase()),
        planId
      ]
    );
  const searches = {
    [GROUP_REF]: groupPool.orders.map(orderView),
    [CO_REF]: coPool.orders.map(orderView),
    [FIRST_REF]: firstPool.orders.map(orderView),
    [SECOND_REF]: secondPool.orders.map(orderView),
    [SPLIT_REF]: splitPool.orders.map(orderView)
  };
  const allOrders = [...new Map(Object.values(searches).flat().map((order) => [order.id, order])).values()];
  const bootstrapOrders = bootstrap.plan?.assignedOrderSnapshots || [];
  return {
    number,
    event,
    backend: {
      ...backend.rows[0].state,
      group: backend.rows[0].state.group ? {
        active: backend.rows[0].state.group.active,
        order: orderView(backend.rows[0].state.group.order)
      } : null,
      split: backend.rows[0].state.split ? {
        active: backend.rows[0].state.split.active,
        parentOrderRef: backend.rows[0].state.split.parentOrderRef,
        order: orderView(backend.rows[0].state.split.order)
      } : null,
      savedSnapshot: (backend.rows[0].state.savedSnapshot || []).map(orderView)
    },
    frontend: {
      targeted: {
        group: orderView(group),
        co: orderView(co),
        split: orderView(split)
      },
      searches,
      allOrders,
      bootstrap: {
        exists: bootstrap.exists,
        plan: {
          id: bootstrap.plan?.id,
          planDate: bootstrap.plan?.planDate,
          revision: bootstrap.plan?.revision,
          assignedOrderSnapshots: bootstrapOrders.map(orderView),
          trucks: bootstrap.plan?.trucks || [],
          summary: bootstrap.plan?.summary || {}
        }
      }
    }
  };
}

function pickup(stage, target = "group") {
  return stage.frontend.targeted[target]?.pickupLocations || [];
}

function assertReplayStage(stage, expected) {
  assert.deepEqual(
    Object.fromEntries(stage.backend.sources.map((source) => [source.ref, source.yard])),
    expected.sources,
    `Stage ${stage.number}: mirrored NetSuite locations`
  );
  assert.equal(stage.backend.group?.active ?? null, expected.groupActive,
    `Stage ${stage.number}: durable group state`);
  assert.deepEqual(pickup(stage), expected.groupPickups || [],
    `Stage ${stage.number}: frontend group route`);
  assert.equal(Boolean(stage.frontend.targeted.group), expected.groupActive === true,
    `Stage ${stage.number}: targeted group visibility`);
  assert.equal(
    stage.frontend.searches[GROUP_REF].some((order) => order.id === GROUP_REF),
    expected.groupActive === true,
    `Stage ${stage.number}: group pool visibility`
  );
  assert.equal(stage.backend.split?.active ?? null, expected.splitActive,
    `Stage ${stage.number}: durable split state`);
  assert.deepEqual(pickup(stage, "split"), expected.splitPickups || [],
    `Stage ${stage.number}: frontend split route`);
  assert.equal(Boolean(stage.frontend.targeted.split), expected.splitActive === true,
    `Stage ${stage.number}: targeted split visibility`);
  assert.equal(
    stage.frontend.searches[SPLIT_REF].some((order) => order.id === SPLIT_REF),
    expected.splitActive === true,
    `Stage ${stage.number}: split pool visibility`
  );
  assert.equal(stage.backend.co?.status ?? null, expected.coStatus,
    `Stage ${stage.number}: durable CO status`);
  assert.equal(Boolean(stage.frontend.targeted.co), expected.coStatus === "pending_load",
    `Stage ${stage.number}: targeted CO visibility`);
  assert.equal(
    stage.frontend.searches[CO_REF].some((order) => order.id === CO_REF),
    expected.coStatus === "pending_load",
    `Stage ${stage.number}: CO pool visibility`
  );
  if (expected.coRoute) {
    assert.deepEqual(
      [stage.backend.co.fromYard, stage.backend.co.toYard],
      expected.coRoute,
      `Stage ${stage.number}: durable CO route`
    );
    assert.deepEqual(
      [stage.frontend.targeted.co.sourceYard, stage.frontend.targeted.co.destinationYard],
      expected.coRoute,
      `Stage ${stage.number}: frontend CO route`
    );
    assert.equal(Number(stage.frontend.targeted.co.destinationLocationId), yardId.get(expected.coRoute[1]),
      `Stage ${stage.number}: frontend CO destination location ID`);
    assert.equal(Number(stage.backend.co.fromLocationId), yardId.get(expected.coRoute[0]),
      `Stage ${stage.number}: backend CO source location ID`);
    assert.equal(Number(stage.backend.co.toLocationId), yardId.get(expected.coRoute[1]),
      `Stage ${stage.number}: backend CO destination location ID`);
  }
  assert.deepEqual(
    stage.frontend.bootstrap.plan.assignedOrderSnapshots.map((order) => order.id),
    expected.bootstrapRefs,
    `Stage ${stage.number}: frontend bootstrap refs`
  );
  assert.equal(
    stage.backend.catalogRefs.includes(GROUP_REF),
    false,
    `Stage ${stage.number}: a global group must never have a catalog shadow`
  );
  assert.equal(
    stage.backend.catalogRefs.includes(SPLIT_REF),
    false,
    `Stage ${stage.number}: a global split must never have a catalog shadow`
  );
  assert.equal(
    stage.backend.catalogRefs.includes(CO_REF),
    expected.coStatus === "pending_load",
    `Stage ${stage.number}: cancelled CO catalog cleanup`
  );
  assert.equal(stage.backend.catalogEntries.every((entry) => entry.eligible === true), true,
    `Stage ${stage.number}: visible catalog records remain eligible`);
  assert.equal(stage.backend.refreshes.every((refresh) => refresh.status === "complete"), true,
    `Stage ${stage.number}: every simulated NetSuite event refresh completes`);
  assert.equal(Number(stage.backend.catalogState.catalogCount) >= stage.backend.catalogRefs.length, true,
    `Stage ${stage.number}: catalog state count cannot trail its rows`);
  if (expected.groupActive !== null) {
    assert.deepEqual(
      stage.backend.groupMembers.map((member) => member.ref),
      [FIRST_REF, SECOND_REF],
      `Stage ${stage.number}: canonical group members are neither lost nor duplicated`
    );
  }
  if (stage.frontend.targeted.group) {
    assert.equal(stage.frontend.targeted.group.eligible, true);
    assert.equal(stage.frontend.targeted.group.readOnly, false);
  }
}

test("exact SOA07894/SOA07895 event replay converges in backend state and frontend read models", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1",
    "The exact production-reference replay is permitted only in an isolated test database.");
  const rollback = await beginRollbackContext();
  const stages = [];
  try {
    await rollback.run(async () => {
      const collision = await query(
        `SELECT (
           (SELECT count(*) FROM sales_orders WHERE lower(tranid) = ANY($1::text[]))
           + (SELECT count(*) FROM dispatch_global_order_groups WHERE lower(group_ref) = lower($2))
           + (SELECT count(*) FROM local_co_orders WHERE lower(co_ref) = lower($3))
           + (SELECT count(*) FROM dispatch_plans WHERE plan_date = $4::date)
         )::int AS count`,
        [[FIRST_REF, SECOND_REF].map((ref) => ref.toLowerCase()), GROUP_REF, CO_REF, PLAN_DATE]
      );
      assert.equal(collision.rows[0].count, 0,
        "The isolated database must not already contain the exact replay identities.");
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ($1, 'draft', 'SOA07894/SOA07895 exact replay', 1)
         RETURNING id::text AS id`,
        [PLAN_DATE]
      );
      const planId = planRow.rows[0].id;
      let revision = 1;
      let first = await simulateNetSuiteEvent({ netsuiteId: 97_007_894, lineId: 98_007_894, ref: FIRST_REF, yard: "2967" });
      let second = await simulateNetSuiteEvent({ netsuiteId: 97_007_895, lineId: 98_007_895, ref: SECOND_REF, yard: "3445" });
      await storePlanSnapshot({ planId, revision, orders: [] });
      stages.push(await captureStage({ number: 1, event: "NetSuite initial sync: SOA07894=2967, SOA07895=3445", planId }));
      assert.deepEqual(stages.at(-1).frontend.searches[FIRST_REF].map((order) => order.id), [FIRST_REF]);
      assert.deepEqual(stages.at(-1).frontend.searches[SECOND_REF].map((order) => order.id), [SECOND_REF]);

      let group = groupOrder(first, second);
      await storePlanSnapshot({ planId, revision: revision += 1, orders: [group] });
      await syncDispatchDeliveryGroupsFromPlan({ id: planId, planDate: PLAN_DATE, revision, orders: [group], trucks: [] });
      stages.push(await captureStage({ number: 2, event: "Group GOA-7894-7895", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["2967", "3445"]);
      assert.deepEqual(stages.at(-1).frontend.searches[FIRST_REF].map((order) => order.id), [GROUP_REF]);

      second = await simulateNetSuiteEvent({ netsuiteId: 97_007_895, lineId: 98_007_895, ref: SECOND_REF, yard: "2967" });
      stages.push(await captureStage({ number: 3, event: "NetSuite location update: SOA07895 3445 -> 2967", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["2967"]);
      assert.equal(stages.at(-1).frontend.targeted.group.childOrderDetails.find((child) => child.id === SECOND_REF)?.sourceYard, "2967");
      assert.deepEqual(stages.at(-1).backend.savedSnapshot[0].pickupLocations, ["2967", "3445"], "Saved snapshot remains immutable.");

      let co = await upsertLocalCoOrder({
        sourceOrderRef: GROUP_REF,
        fromYard: "2967",
        toYard: "12441",
        order: stages.at(-1).frontend.targeted.group,
        requestedBy: "exact-event-replay"
      });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: GROUP_REF, co });
      await upsertDispatchOrderCatalog({
        orders: await listDispatchOrders({ type: "CO", exactOrderRefs: [CO_REF] }),
        source: "exact-replay-co-initialize"
      });
      stages.push(await captureStage({ number: 4, event: "Initialize CO 2967 -> 12441", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["12441"]);
      assert.equal(stages.at(-1).frontend.targeted.co.destinationYard, "12441");

      first = await simulateNetSuiteEvent({ netsuiteId: 97_007_894, lineId: 98_007_894, ref: FIRST_REF, yard: "150" });
      stages.push(await captureStage({ number: 5, event: "NetSuite location update while CO active: SOA07894 2967 -> 150", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["12441"]);
      assert.deepEqual(stages.at(-1).frontend.targeted.group.transitOriginalPickupLocations, ["150", "2967"]);

      co = await cancelLocalCoOrder(CO_REF, { requestedBy: "exact-event-replay" });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: GROUP_REF, co, cancelled: true });
      await removeDispatchOrderCatalogOrder(CO_REF);
      stages.push(await captureStage({ number: 6, event: "Cancel CO; restore newest NetSuite route", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["150", "2967"]);
      assert.equal(stages.at(-1).frontend.targeted.co, null);

      co = await upsertLocalCoOrder({
        sourceOrderRef: GROUP_REF,
        fromYard: "150",
        toYard: "3445",
        order: stages.at(-1).frontend.targeted.group,
        requestedBy: "exact-event-replay",
        reactivateCancelled: true
      });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: GROUP_REF, co });
      await upsertDispatchOrderCatalog({
        orders: await listDispatchOrders({ type: "CO", exactOrderRefs: [CO_REF] }),
        source: "exact-replay-co-reinitialize"
      });
      stages.push(await captureStage({ number: 7, event: "Reinitialize cancelled CO 150 -> 3445", planId }));
      assert.equal(stages.at(-1).frontend.targeted.co.sourceYard, "150");
      assert.equal(stages.at(-1).frontend.targeted.co.destinationYard, "3445");
      assert.deepEqual(pickup(stages.at(-1)), ["3445"]);

      co = await cancelLocalCoOrder(CO_REF, { requestedBy: "exact-event-replay" });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: GROUP_REF, co, cancelled: true });
      await removeDispatchOrderCatalogOrder(CO_REF);
      await storePlanSnapshot({ planId, revision: revision += 1, orders: [first, second] });
      await deactivateDispatchGlobalOrderDefinitions([GROUP_REF]);
      await upsertDispatchOrderCatalog({ orders: [group], source: "exact-replay-delayed-old-group" });
      stages.push(await captureStage({ number: 8, event: "Cancel CO, ungroup, then deliver delayed stale group refresh", planId }));
      assert.equal(stages.at(-1).frontend.targeted.group, null);
      assert.deepEqual(stages.at(-1).frontend.searches[FIRST_REF].map((order) => order.id), [FIRST_REF]);
      assert.equal(stages.at(-1).backend.catalogRefs.includes(GROUP_REF), false);
      await assert.rejects(
        saveDispatchPlanSnapshot(planId, {
          orders: [group],
          trucks: [],
          summary: {},
          baseRevision: null,
          planDate: PLAN_DATE,
          sessionId: "exact-replay-stale-force-save"
        }),
        (error) => error?.code === "DISPATCH_DERIVED_ORDER_RETIRED"
          && error?.retiredOrderRefs?.includes(GROUP_REF),
        "A stale force-save must not reactivate the explicitly ungrouped GOA."
      );
      const stalePersistedTrucks = [{
        id: "stale-truck",
        plate: "STALE-7894",
        loads: [{
          id: "stale-load",
          name: "Stale GOA load",
          stops: [{ id: "stale-stop", orderId: GROUP_REF, type: "dropoff" }]
        }]
      }];
      await storePlanSnapshot({
        planId,
        revision,
        orders: [group],
        trucks: stalePersistedTrucks
      });
      const staleImmutableBootstrap = await getDispatchV2Bootstrap({ planId, date: PLAN_DATE });
      assert.deepEqual(staleImmutableBootstrap.plan.assignedOrderSnapshots, [],
        "A hard refresh must hide a retired GOA even when an old immutable snapshot still stores it.");
      assert.deepEqual(staleImmutableBootstrap.plan.trucks[0]?.loads[0]?.stops || [], [],
        "A hard refresh must also hide stops owned by a retired GOA.");
      const stalePersistedSnapshot = await query(
        "SELECT orders, trucks FROM dispatch_plan_snapshots WHERE plan_id = $1",
        [planId]
      );
      assert.equal(stalePersistedSnapshot.rows[0].orders[0]?.id, GROUP_REF,
        "Live reconciliation must not rewrite an immutable stored snapshot.");
      assert.equal(stalePersistedSnapshot.rows[0].trucks[0]?.loads[0]?.stops[0]?.orderId, GROUP_REF,
        "The historical stop remains stored while the live view suppresses it.");
      await storePlanSnapshot({ planId, revision, orders: [first, second] });

      const split = {
        ...clone(first),
        id: SPLIT_REF,
        originalOrderId: FIRST_REF,
        salesQty: 4,
        items: first.items.map((item) => ({ ...item, quantity: 4 }))
      };
      await storePlanSnapshot({ planId, revision: revision += 1, orders: [split, second] });
      await syncDispatchDeliveryGroupsFromPlan({ id: planId, planDate: PLAN_DATE, revision, orders: [split, second], trucks: [] });
      stages.push(await captureStage({ number: 9, event: "Split SOA07894 -> SOA07894-S1", planId }));
      assert.deepEqual(pickup(stages.at(-1), "split"), ["150"]);

      first = await simulateNetSuiteEvent({
        netsuiteId: 97_007_894,
        lineId: 98_007_894,
        ref: FIRST_REF,
        yard: "12441",
        statusText: "Sales Order : Partially Fulfilled"
      });
      stages.push(await captureStage({ number: 10, event: "NetSuite update while split: SOA07894 150 -> 12441", planId }));
      assert.deepEqual(pickup(stages.at(-1), "split"), ["12441"]);
      assert.deepEqual(stages.at(-1).backend.savedSnapshot.find((order) => order.id === SPLIT_REF)?.pickupLocations, ["150"]);

      await deactivateDispatchGlobalOrderDefinitions([SPLIT_REF]);
      await storePlanSnapshot({ planId, revision: revision += 1, orders: [first, second] });
      await upsertDispatchOrderCatalog({ orders: [split], source: "exact-replay-delayed-old-split" });
      stages.push(await captureStage({ number: 11, event: "Unsplit, then deliver delayed stale split refresh", planId }));
      assert.equal(stages.at(-1).frontend.targeted.split, null);
      assert.equal(stages.at(-1).backend.catalogRefs.includes(SPLIT_REF), false);
      await assert.rejects(
        saveDispatchPlanSnapshot(planId, {
          orders: [split, second],
          trucks: [],
          summary: {},
          baseRevision: null,
          planDate: PLAN_DATE,
          sessionId: "exact-replay-stale-split-force-save"
        }),
        (error) => error?.code === "DISPATCH_DERIVED_ORDER_RETIRED"
          && error?.retiredOrderRefs?.includes(SPLIT_REF),
        "A stale force-save must not reactivate an explicitly unsplit order."
      );

      group = groupOrder(first, second);
      const regroupedPlan = await saveDispatchPlanSnapshot(planId, {
        orders: [group],
        trucks: [],
        summary: {},
        baseRevision: revision,
        planDate: PLAN_DATE,
        sessionId: "exact-replay-explicit-regroup",
        reactivatedGlobalOrderRefs: [GROUP_REF]
      });
      revision = Number(regroupedPlan.revision);
      stages.push(await captureStage({ number: 12, event: "Regroup after split/unsplit", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["12441", "2967"]);

      co = await upsertLocalCoOrder({
        sourceOrderRef: GROUP_REF,
        fromYard: "12441",
        toYard: "150",
        order: stages.at(-1).frontend.targeted.group,
        requestedBy: "exact-event-replay",
        reactivateCancelled: true
      });
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: GROUP_REF, co });
      await upsertDispatchOrderCatalog({
        orders: await listDispatchOrders({ type: "CO", exactOrderRefs: [CO_REF] }),
        source: "exact-replay-final-co"
      });
      stages.push(await captureStage({ number: 13, event: "Initialize final CO 12441 -> 150", planId }));
      assert.deepEqual(pickup(stages.at(-1)), ["150"]);
      assert.equal(stages.at(-1).frontend.targeted.co.sourceYard, "12441");
      assert.equal(stages.at(-1).frontend.targeted.co.destinationYard, "150");

      const expectedStages = [
        { sources: { [FIRST_REF]: "2967", [SECOND_REF]: "3445" }, groupActive: null, groupPickups: [], splitActive: null, coStatus: null, bootstrapRefs: [] },
        { sources: { [FIRST_REF]: "2967", [SECOND_REF]: "3445" }, groupActive: true, groupPickups: ["2967", "3445"], splitActive: null, coStatus: null, bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "2967", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["2967"], splitActive: null, coStatus: null, bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "2967", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["12441"], splitActive: null, coStatus: "pending_load", coRoute: ["2967", "12441"], bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "150", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["12441"], splitActive: null, coStatus: "pending_load", coRoute: ["2967", "12441"], bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "150", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["150", "2967"], splitActive: null, coStatus: "cancelled", bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "150", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["3445"], splitActive: null, coStatus: "pending_load", coRoute: ["150", "3445"], bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "150", [SECOND_REF]: "2967" }, groupActive: false, groupPickups: [], splitActive: null, coStatus: "cancelled", bootstrapRefs: [] },
        { sources: { [FIRST_REF]: "150", [SECOND_REF]: "2967" }, groupActive: false, groupPickups: [], splitActive: true, splitPickups: ["150"], coStatus: "cancelled", bootstrapRefs: [SPLIT_REF] },
        { sources: { [FIRST_REF]: "12441", [SECOND_REF]: "2967" }, groupActive: false, groupPickups: [], splitActive: true, splitPickups: ["12441"], coStatus: "cancelled", bootstrapRefs: [SPLIT_REF] },
        { sources: { [FIRST_REF]: "12441", [SECOND_REF]: "2967" }, groupActive: false, groupPickups: [], splitActive: false, splitPickups: [], coStatus: "cancelled", bootstrapRefs: [] },
        { sources: { [FIRST_REF]: "12441", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["12441", "2967"], splitActive: false, splitPickups: [], coStatus: "cancelled", bootstrapRefs: [GROUP_REF] },
        { sources: { [FIRST_REF]: "12441", [SECOND_REF]: "2967" }, groupActive: true, groupPickups: ["150"], splitActive: false, splitPickups: [], coStatus: "pending_load", coRoute: ["12441", "150"], bootstrapRefs: [GROUP_REF] }
      ];
      assert.equal(stages.length, expectedStages.length);
      stages.forEach((stage, index) => assertReplayStage(stage, expectedStages[index]));
    });
  } finally {
    await rollback.rollback();
  }

  const artifactPath = String(process.env.MBT_REPLAY_ARTIFACT_PATH || "").trim();
  if (artifactPath) {
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify({
      schemaVersion: "dispatch-soa07894-event-replay-v1",
      refs: { first: FIRST_REF, second: SECOND_REF, group: GROUP_REF, co: CO_REF, split: SPLIT_REF },
      snapshotPolicy: "persisted snapshots remain immutable; frontend bootstrap overlays current NetSuite/global-definition/local-CO state",
      stages
    }, null, 2)}\n`, "utf8");
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { query } from "../../../src/db.js";
import {
  claimDispatchOrderCatalogRefreshes,
  completeDispatchOrderCatalogRefresh,
  enqueueDispatchOrderCatalogRefresh,
  getDispatchOrderCatalogOrder,
  getDispatchOrderCatalogState,
  listDispatchOrderPool,
  markDispatchOrderCatalogReady,
  recordDispatchOrderPoolShadowComparison,
  replaceDispatchOrderCatalog,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import {
  dispatchPlanAssignmentRows,
  listDispatchPlanOrderAssignmentsProjection,
  syncDispatchPlanOrderAssignments,
  syncDispatchPlanRelationEdges
} from "../../../src/dispatch-planner-v2-repository.js";

async function resetCatalog() {
  await query("DELETE FROM dispatch_plans WHERE note LIKE 'catalog test%'");
  await query("TRUNCATE dispatch_order_catalog_refresh_outbox, dispatch_order_relation_edges, dispatch_order_catalog_entries, dispatch_order_catalog_state, dispatch_planner_shadow_mismatches RESTART IDENTITY CASCADE");
  await query("INSERT INTO dispatch_order_catalog_state (singleton, status) VALUES (true, 'warming')");
}

test("DPO-06 indexed pool defaults to unplanned and search returns planned route metadata", async () => {
  await resetCatalog();
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note)
     VALUES ('2326-08-20', 'draft', 'catalog test')
     RETURNING id`
  );
  await upsertDispatchOrderCatalog({
    source: "test",
    orders: [
      { id: "SO-CAT-001", type: "SO", customer: "Alpha", address: "One Road", items: [{ sku: "STONE-A" }] },
      { id: "SO-CAT-002", type: "SO", customer: "Beta", address: "Two Road", items: [{ sku: "STONE-B" }] },
      { id: "PO-CAT-003", type: "PO", customer: "Vendor", address: "Three Road", items: [{ sku: "STONE-C" }] }
    ]
  });
  await query(
    `INSERT INTO dispatch_plan_order_assignments (
       plan_id, plan_date, order_ref, planned_order_ref, assignment_kind,
       load_id, stop_id, assignment, updated_at
     ) VALUES ($1, '2326-08-20', 'SO-CAT-002', 'SO-CAT-002', 'direct',
       'load-2', 'stop-2', $2::jsonb, now())`,
    [plan.rows[0].id, JSON.stringify({
      dispatchTruckPlate: "TRK-22",
      dispatchLoadName: "Driver Two · Load 2",
      dispatchDriverName: "Driver Two"
    })]
  );
  await markDispatchOrderCatalogReady({ source: "test" });

  const defaultPool = await listDispatchOrderPool({ type: "SO", limit: 50 });
  assert.deepEqual(defaultPool.orders.map((order) => order.id), ["SO-CAT-001"]);
  assert.equal(defaultPool.ready, true);
  assert.equal(defaultPool.source, "catalog");

  const searched = await listDispatchOrderPool({ search: "CAT-002", limit: 50 });
  assert.equal(searched.orders.length, 1);
  assert.equal(searched.orders[0].id, "SO-CAT-002");
  assert.equal(searched.orders[0].dispatchPlanned, true);
  assert.equal(searched.orders[0].readOnly, true);
  assert.equal(searched.orders[0].dispatchPlanDate, "2326-08-20");
  assert.equal(searched.orders[0].dispatchTruckPlate, "TRK-22");
  assert.equal(searched.orders[0].dispatchLoadName, "Driver Two · Load 2");
  assert.deepEqual(searched.orders[0].jump, { planId: String(plan.rows[0].id), planDate: "2326-08-20" });

  const hydrated = await getDispatchOrderCatalogOrder("SO-CAT-001");
  assert.equal(hydrated.catalogHydrated, true);
  assert.equal(hydrated.items[0].sku, "STONE-A");
});

test("DPO-06b indexed pool retains completed transit CO evidence for the customer leg", async () => {
  await resetCatalog();
  await upsertDispatchOrderCatalog({
    source: "dispatch-so-refresh",
    orders: [{
      id: "SOA07512",
      type: "SO",
      sourceYard: "2967",
      pickupLocations: ["12441"],
      transitCo: {
        id: "CO-SOA07512",
        fromYard: "2967",
        toYard: "12441",
        status: "completed",
        source: "local-db",
        raw: { giant: "x".repeat(50_000), credential: "must-not-leak" }
      }
    }]
  });
  await markDispatchOrderCatalogReady({ source: "dispatch-so-refresh" });

  const pool = await listDispatchOrderPool({ type: "SO", search: "SOA07512" });
  assert.equal(pool.orders.length, 1);
  assert.deepEqual(pool.orders[0].transitCo, {
    id: "CO-SOA07512",
    fromYard: "2967",
    toYard: "12441",
    status: "completed",
    source: "local-db"
  });
  assert.deepEqual(pool.orders[0].pickupLocations, ["12441"]);
  assert.doesNotMatch(JSON.stringify(pool.orders[0]), /must-not-leak/u);
});

test("DPO-06 pool cursors are stable and replacement removes only the selected scope", async () => {
  await resetCatalog();
  await upsertDispatchOrderCatalog({
    source: "seed",
    orders: Array.from({ length: 7 }, (_, index) => ({
      id: `SO-PAGE-${String(index + 1).padStart(2, "0")}`,
      type: "SO",
      customer: `Customer ${index + 1}`,
      expectedDeliveryDate: "2326-08-20"
    })).concat([{ id: "PO-KEEP-01", type: "PO", customer: "Vendor" }])
  });
  const first = await listDispatchOrderPool({ type: "SO", limit: 3 });
  const second = await listDispatchOrderPool({ type: "SO", limit: 3, cursor: first.nextCursor });
  const third = await listDispatchOrderPool({ type: "SO", limit: 3, cursor: second.nextCursor });
  assert.deepEqual([...first.orders, ...second.orders, ...third.orders].map((order) => order.id), [
    "SO-PAGE-07", "SO-PAGE-06", "SO-PAGE-05", "SO-PAGE-04", "SO-PAGE-03", "SO-PAGE-02", "SO-PAGE-01"
  ]);
  await assert.rejects(
    listDispatchOrderPool({ cursor: "hostile-not-a-cursor" }),
    (error) => error?.code === "DISPATCH_ORDER_POOL_CURSOR_INVALID" && error?.status === 400
  );

  await replaceDispatchOrderCatalog({
    source: "replace-so",
    type: "SO",
    orders: [{ id: "SO-NEW-01", type: "SO", customer: "New" }]
  });
  assert.deepEqual((await listDispatchOrderPool({ type: "SO" })).orders.map((order) => order.id), ["SO-NEW-01"]);
  assert.equal((await getDispatchOrderCatalogOrder("PO-KEEP-01")).id, "PO-KEEP-01");
});

test("DPO-06 catalog refresh outbox deduplicates work and claims it once", async () => {
  await resetCatalog();
  const first = await enqueueDispatchOrderCatalogRefresh({ orderRef: "SO-QUEUE-1", source: "netsuite-webhook" });
  const second = await enqueueDispatchOrderCatalogRefresh({ orderRef: "so-queue-1", source: "scm-update" });
  assert.equal(first.id, second.id);
  const [claimed] = await claimDispatchOrderCatalogRefreshes({ limit: 10 });
  assert.equal(claimed.orderRef, "SO-QUEUE-1");
  assert.equal((await claimDispatchOrderCatalogRefreshes({ limit: 10 })).length, 0);
  await completeDispatchOrderCatalogRefresh(claimed.id);
  const state = await getDispatchOrderCatalogState();
  assert.equal(state.pendingRefreshCount, 0);
});

test("DPO-19 a full catalog refresh coalesces the pending targeted backlog", async () => {
  await resetCatalog();
  await enqueueDispatchOrderCatalogRefresh({ orderRef: "SO-QUEUE-1", orderType: "SO", source: "webhook" });
  await enqueueDispatchOrderCatalogRefresh({ orderRef: "TO-QUEUE-2", orderType: "TO", source: "webhook" });
  const full = await enqueueDispatchOrderCatalogRefresh({ source: "startup" });

  const claimed = await claimDispatchOrderCatalogRefreshes({ limit: 25 });
  assert.deepEqual(claimed.map((refresh) => refresh.id), [full.id]);
  assert.equal(claimed[0].orderRef, "");
  const rows = await query(
    `SELECT refresh_key, status
       FROM dispatch_order_catalog_refresh_outbox
      ORDER BY id`
  );
  assert.deepEqual(rows.rows, [
    { refresh_key: "order:SO:so-queue-1", status: "complete" },
    { refresh_key: "order:TO:to-queue-2", status: "complete" },
    { refresh_key: "full:all", status: "running" }
  ]);
});

test("DPO-06 shadow verification records matches, blocks mismatches, and resets on full refresh", async () => {
  await resetCatalog();
  await recordDispatchOrderPoolShadowComparison({
    requestKey: "SO default",
    legacy: [{ id: "SO-SHADOW-1" }, { id: "SO-SHADOW-2" }],
    optimized: [{ id: "SO-SHADOW-2" }, { id: "SO-SHADOW-1" }]
  });
  await recordDispatchOrderPoolShadowComparison({
    requestKey: "SO search",
    legacy: [{ id: "SO-SHADOW-1" }],
    optimized: [{ id: "SO-SHADOW-9" }]
  });
  const compared = await getDispatchOrderCatalogState();
  assert.equal(compared.shadowMatchCount, 1);
  assert.equal(compared.shadowMismatchCount, 1);
  assert.ok(compared.lastShadowComparisonAt);

  const mismatches = await query(
    `SELECT details
       FROM dispatch_planner_shadow_mismatches
      WHERE comparison_kind = 'order_pool'
        AND request_key = 'SO search'
      ORDER BY id DESC
      LIMIT 1`
  );
  assert.deepEqual(mismatches.rows[0].details, {
    legacyOnly: ["SO-SHADOW-1"],
    optimizedOnly: ["SO-SHADOW-9"],
    legacyCount: 1,
    optimizedCount: 1
  });

  await replaceDispatchOrderCatalog({
    source: "shadow-reset",
    orders: [{ id: "SO-SHADOW-1", type: "SO" }]
  });
  const refreshed = await getDispatchOrderCatalogState();
  assert.equal(refreshed.shadowMatchCount, 0);
  assert.equal(refreshed.shadowMismatchCount, 0);
  assert.equal(refreshed.lastShadowComparisonAt, null);
});

test("DPO-07 assignment and relation projections retain interacting planning identities", async () => {
  await resetCatalog();
  const seeded = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ('2326-08-21', 'draft', 'catalog test projections', 9)
     RETURNING id`
  );
  const plan = {
    id: String(seeded.rows[0].id),
    planDate: "2326-08-21",
    revision: 9,
    orders: [{
      id: "GOA-PROJECT",
      type: "GROUP",
      childOrders: ["SOA-PROJECT-S1", "SOA-PROJECT-2"],
      childOrderDetails: [{
        id: "SOA-PROJECT-S1",
        type: "SO",
        originalOrderId: "SOA-PROJECT",
        poPickupManifest: [{ poOrderRef: "POB-PROJECT" }],
        orderDependencies: [{ transferOrderRef: "TOB-PROJECT", mode: "direct_to_customer" }]
      }, { id: "SOA-PROJECT-2", type: "SO" }]
    }],
    trucks: [{
      id: "truck-project",
      plate: "PRO-001",
      driverName: "Projection Driver",
      loads: [{
        id: "load-project",
        name: "Load 4",
        stops: [{ id: "stop-project", type: "drop", orderId: "GOA-PROJECT" }]
      }]
    }]
  };
  await syncDispatchPlanOrderAssignments(plan);
  await syncDispatchPlanRelationEdges(plan);

  const assignments = await query(
    `SELECT order_ref, planned_order_ref, assignment_kind, load_id, stop_id, assignment
       FROM dispatch_plan_order_assignments
      WHERE plan_id = $1
      ORDER BY assignment_kind, order_ref`,
    [plan.id]
  );
  assert.deepEqual(assignments.rows.map((row) => [row.order_ref, row.planned_order_ref, row.assignment_kind]), [
    ["GOA-PROJECT", "GOA-PROJECT", "direct"],
    ["SOA-PROJECT-2", "GOA-PROJECT", "group_member"],
    ["SOA-PROJECT-S1", "GOA-PROJECT", "group_member"],
    ["SOA-PROJECT", "GOA-PROJECT", "split_parent_alias"]
  ]);
  assert.ok(assignments.rows.every((row) => row.load_id === "load-project" && row.stop_id === "stop-project"));
  assert.ok(assignments.rows.every((row) => row.assignment.dispatchTruckPlate === "PRO-001"));
  assert.equal(
    assignments.rows.find((row) => row.order_ref === "SOA-PROJECT-S1")?.assignment?.plannedOrderSnapshot?.id,
    "GOA-PROJECT",
    "The indexed planned-assignment feed must retain the grouped/split snapshot used by the order pool."
  );
  const projected = await listDispatchPlanOrderAssignmentsProjection({
    orderRefs: ["soa-project", "SOA-PROJECT-S1"]
  });
  assert.deepEqual(projected.map((row) => row.orderRef).sort(), ["SOA-PROJECT", "SOA-PROJECT-S1"]);

  const relations = await query(
    `SELECT relation_type, owner_ref, member_ref, source_revision::int
       FROM dispatch_order_relation_edges
      WHERE plan_id = $1
      ORDER BY relation_type, owner_ref, member_ref`,
    [plan.id]
  );
  assert.deepEqual(relations.rows.map((row) => [row.relation_type, row.owner_ref, row.member_ref, row.source_revision]), [
    ["direct_ship", "SOA-PROJECT-S1", "TOB-PROJECT", 9],
    ["group_member", "GOA-PROJECT", "SOA-PROJECT-2", 9],
    ["group_member", "GOA-PROJECT", "SOA-PROJECT-S1", 9],
    ["po_link", "SOA-PROJECT-S1", "POB-PROJECT", 9],
    ["split_child", "SOA-PROJECT", "SOA-PROJECT-S1", 9],
    ["to_link", "SOA-PROJECT-S1", "TOB-PROJECT", 9]
  ]);

  const legacySplitRows = dispatchPlanAssignmentRows({
    orders: [
      { id: "SOA-LEGACY-S1", type: "SO" },
      { id: "CUSTOM-LEGACY-S1", type: "CUSTOM", sourceTable: "dispatch_custom_orders" }
    ],
    trucks: [{
      id: "legacy-truck",
      loads: [{
        id: "legacy-load",
        stops: [
          { id: "legacy-so-stop", type: "drop", orderId: "SOA-LEGACY-S1" },
          { id: "legacy-custom-stop", type: "drop", orderId: "CUSTOM-LEGACY-S1" }
        ]
      }]
    }]
  });
  assert.deepEqual(
    legacySplitRows.map((row) => [row.orderRef, row.plannedOrderRef, row.assignmentKind]),
    [
      ["SOA-LEGACY-S1", "SOA-LEGACY-S1", "direct"],
      ["CUSTOM-LEGACY-S1", "CUSTOM-LEGACY-S1", "direct"],
      ["SOA-LEGACY", "SOA-LEGACY-S1", "split_parent_alias"]
    ]
  );
});

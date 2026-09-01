import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  reconcileDispatchGlobalOrderTransitCos,
  removeDispatchGlobalGroupedMember,
  syncDispatchDeliveryGroupsFromPlan,
  syncDispatchGlobalOrderTransitCo
} from "../../../src/dispatch-delivery-group-repository.js";
import {
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import { syncDispatchPlanOrderAssignments } from "../../../src/dispatch-planner-v2-repository.js";

after(closeDb);

function assignedTruck(orderRef) {
  return [{
    id: "global-derived-truck",
    plate: "GLOBAL-DERIVED",
    loads: [{
      id: "global-derived-load",
      name: "Global derived load",
      stops: [{ id: `stop-${orderRef}`, type: "drop", orderId: orderRef }]
    }]
  }];
}

function baseOrder(id, type, sourceYard = "2967") {
  return {
    id,
    type,
    customer: `${type} global fixture`,
    address: "1 Global Order Road",
    sourceYard,
    pickupLocations: [sourceYard],
    items: [{ sku: `${id}-ITEM`, quantity: 10, pallets: 1 }],
    pallets: 1,
    salesQty: 10,
    eligible: true
  };
}

test("SO, PO, TO, and CO splits are global definitions while their date assignment remains independent", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const owner = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-08-31', 'draft', $1, 1) RETURNING id`,
        [`global split owner ${suffix}`]
      );
      const next = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-09-01', 'draft', $1, 1) RETURNING id`,
        [`global split next ${suffix}`]
      );
      const soParent = baseOrder(`SO-GLOBAL-${suffix}`, "SO");
      const poParent = baseOrder(`PO-GLOBAL-${suffix}`, "PO", "3445");
      const toParent = baseOrder(`TO-GLOBAL-${suffix}`, "TO", "3445");
      const coParent = baseOrder(`CO-GLOBAL-${suffix}`, "CO", "2967");
      const soSplit = {
        ...soParent,
        id: `${soParent.id}-S1`,
        originalOrderId: soParent.id,
        salesQty: 4,
        items: [{ ...soParent.items[0], quantity: 4 }]
      };
      const toSplit = {
        ...toParent,
        id: `${toParent.id}-S1`,
        originalOrderId: toParent.id,
        salesQty: 6,
        items: [{ ...toParent.items[0], quantity: 6 }]
      };
      const poSplit = {
        ...poParent,
        id: `${poParent.id}-S1`,
        originalOrderId: poParent.id,
        salesQty: 3,
        items: [{ ...poParent.items[0], quantity: 3 }]
      };
      const coSplit = {
        ...coParent,
        id: `${coParent.id}-S1`,
        originalOrderId: coParent.id,
        salesQty: 5,
        items: [{ ...coParent.items[0], quantity: 5 }]
      };
      await upsertDispatchOrderCatalog({
        orders: [soParent, poParent, toParent, coParent],
        source: "global-derived-red"
      });

      const ownerPlan = {
        id: String(owner.rows[0].id),
        planDate: "2098-08-31",
        revision: 1,
        orders: [soSplit, poSplit, toSplit, coSplit],
        trucks: []
      };
      await syncDispatchDeliveryGroupsFromPlan(ownerPlan);

      const soPool = await listDispatchOrderPool({ type: "SO", search: soParent.id, limit: 20 });
      const poPool = await listDispatchOrderPool({ type: "PO", search: poParent.id, limit: 20 });
      const toPool = await listDispatchOrderPool({ type: "TO", search: toParent.id, limit: 20 });
      const coPool = await listDispatchOrderPool({ type: "CO", search: coParent.id, limit: 20 });
      assert.deepEqual(soPool.orders.map((order) => order.id), [soSplit.id]);
      assert.deepEqual(poPool.orders.map((order) => order.id), [poSplit.id]);
      assert.deepEqual(toPool.orders.map((order) => order.id), [toSplit.id]);
      assert.deepEqual(coPool.orders.map((order) => order.id), [coSplit.id]);
      assert.equal(soPool.orders[0].dispatchPlanned, false);
      assert.equal(toPool.orders[0].dispatchPlanned, false);
      assert.equal((await getDispatchOrderCatalogOrder(soSplit.id)).globalOrderDefinition, true);
      assert.equal((await getDispatchOrderCatalogOrder(toSplit.id)).globalOrderDefinitionKind, "split");

      const copiedUnassignedPlan = {
        id: String(next.rows[0].id),
        planDate: "2098-09-01",
        revision: 1,
        orders: [
          await getDispatchOrderCatalogOrder(soSplit.id),
          await getDispatchOrderCatalogOrder(poSplit.id),
          await getDispatchOrderCatalogOrder(toSplit.id),
          await getDispatchOrderCatalogOrder(coSplit.id)
        ],
        trucks: []
      };
      await syncDispatchDeliveryGroupsFromPlan(copiedUnassignedPlan);
      let ownership = await query(
        `SELECT split_ref, source_plan_id::text AS source_plan_id
           FROM dispatch_global_order_splits
          WHERE split_ref = ANY($1::text[])
          ORDER BY split_ref`,
        [[soSplit.id, poSplit.id, toSplit.id, coSplit.id]]
      );
      assert.ok(ownership.rows.every((row) => row.source_plan_id === String(owner.rows[0].id)));

      const assignedNextPlan = {
        ...copiedUnassignedPlan,
        revision: 2,
        trucks: assignedTruck(soSplit.id)
      };
      await syncDispatchPlanOrderAssignments(assignedNextPlan);
      await syncDispatchDeliveryGroupsFromPlan(assignedNextPlan);
      const assigned = await listDispatchOrderPool({ type: "SO", search: soSplit.id, limit: 20 });
      assert.equal(assigned.orders[0].dispatchPlanId, String(next.rows[0].id));
      assert.equal(assigned.orders[0].dispatchPlanDate, "2098-09-01");

      ownership = await query(
        `SELECT source_plan_id::text AS source_plan_id
           FROM dispatch_global_order_splits
          WHERE split_ref = $1`,
        [soSplit.id]
      );
      assert.equal(
        ownership.rows[0].source_plan_id,
        String(owner.rows[0].id),
        "assignment is date-scoped and must not own the definition"
      );

      await syncDispatchDeliveryGroupsFromPlan({ ...ownerPlan, revision: 3, orders: [] });
      ownership = await query(
        `SELECT source_plan_id::text AS source_plan_id
           FROM dispatch_global_order_splits
          WHERE split_ref = $1`,
        [soSplit.id]
      );
      assert.equal(
        ownership.rows[0].source_plan_id,
        String(owner.rows[0].id),
        "compact plan omission must not retire a global split"
      );
      assert.equal((await getDispatchOrderCatalogOrder(soSplit.id)).id, soSplit.id);
    });
  } finally {
    await rollback.rollback();
  }
});

test("a local consolidation TO is global and does not hide its source SO", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-08-31', 'draft', $1, 1) RETURNING id`,
        [`global consolidation ${suffix}`]
      );
      const source = baseOrder(`SO-CONSOLIDATE-${suffix}`, "SO");
      const draft = {
        ...baseOrder(`TO-DRAFT-${suffix}`, "TO", "3445"),
        sourceOrderId: source.id,
        globalOrderDefinitionKind: "consolidation",
        planOwned: true
      };
      await upsertDispatchOrderCatalog({ orders: [source], source: "global-consolidation-red" });
      const plan = {
        id: String(planRow.rows[0].id),
        planDate: "2098-08-31",
        revision: 1,
        orders: [source, draft],
        trucks: []
      };
      await syncDispatchDeliveryGroupsFromPlan(plan);

      assert.deepEqual(
        (await listDispatchOrderPool({ type: "TO", search: draft.id, limit: 20 })).orders.map((order) => order.id),
        [draft.id]
      );
      assert.equal((await getDispatchOrderCatalogOrder(draft.id)).globalOrderDefinitionKind, "consolidation");
      assert.deepEqual(
        (await listDispatchOrderPool({ type: "SO", search: source.id, limit: 20 })).orders.map((order) => order.id),
        [source.id],
        "a consolidation move is related to, but does not replace, its source SO"
      );

      await syncDispatchDeliveryGroupsFromPlan({ ...plan, revision: 2, orders: [] });
      assert.equal((await getDispatchOrderCatalogOrder(draft.id)).id, draft.id);
      await deactivateDispatchGlobalOrderDefinitions([draft.id]);
      assert.equal(await getDispatchOrderCatalogOrder(draft.id), null);
    });
  } finally {
    await rollback.rollback();
  }
});

test("CO metadata follows a global split across dates and restores globally on cancellation", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const owner = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-08-31', 'draft', $1, 1) RETURNING id`,
        [`global split CO ${suffix}`]
      );
      const parent = baseOrder(`TO-CO-SPLIT-${suffix}`, "TO", "2967");
      const split = {
        ...parent,
        id: `${parent.id}-S1`,
        originalOrderId: parent.id
      };
      await upsertDispatchOrderCatalog({ orders: [parent], source: "global-split-co-red" });
      await syncDispatchDeliveryGroupsFromPlan({
        id: String(owner.rows[0].id),
        planDate: "2098-08-31",
        revision: 1,
        orders: [split],
        trucks: []
      });
      await upsertDispatchOrderCatalog({
        orders: [{ ...split, sourceYard: "2967", pickupLocations: ["2967"] }],
        source: "stale-derived-card-red"
      });

      const co = {
        co_ref: `CO-${split.id}`,
        source_order_ref: split.id,
        from_location: "2967",
        to_location: "12441",
        status: "pending_load"
      };
      await query(
        `INSERT INTO local_co_orders (
           co_ref, source_order_ref, from_location, to_location,
           status, created_by, details
         ) VALUES ($1, $2, $3, $4, $5, 'global-derived-red', '{}'::jsonb)`,
        [co.co_ref, co.source_order_ref, co.from_location, co.to_location, co.status]
      );
      const repaired = await reconcileDispatchGlobalOrderTransitCos();
      assert.deepEqual(repaired.orderRefs, [split.id]);

      const redirected = await getDispatchOrderCatalogOrder(split.id);
      assert.equal(redirected.sourceYard, "12441");
      assert.deepEqual(redirected.pickupLocations, ["12441"]);
      assert.equal(redirected.transitOriginalSourceYard, "2967");
      assert.equal(redirected.transitCo.id, co.co_ref);
      assert.equal(
        (await listDispatchOrderPool({ type: "TO", search: split.id, limit: 20 })).orders[0].sourceYard,
        "12441"
      );

      await query(
        "UPDATE local_co_orders SET status = 'cancelled', updated_at = now() WHERE co_ref = $1",
        [co.co_ref]
      );
      await reconcileDispatchGlobalOrderTransitCos();
      const restored = await getDispatchOrderCatalogOrder(split.id);
      assert.equal(restored.sourceYard, "2967");
      assert.deepEqual(restored.pickupLocations, ["2967"]);
      assert.equal(restored.transitCo ?? null, null);
    });
  } finally {
    await rollback.rollback();
  }
});

test("CO metadata propagates through a global group of split orders", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-08-31', 'draft', $1, 1) RETURNING id`,
        [`global split group CO ${suffix}`]
      );
      const parents = [
        baseOrder(`SO-GROUP-SPLIT-${suffix}-1`, "SO"),
        baseOrder(`SO-GROUP-SPLIT-${suffix}-2`, "SO")
      ];
      const splits = parents.map((parent) => ({
        ...parent,
        id: `${parent.id}-S1`,
        originalOrderId: parent.id
      }));
      const group = {
        ...splits[0],
        id: `GSO-GROUP-SPLIT-${suffix}`,
        originalOrderId: "",
        childOrders: splits.map((split) => split.id),
        childOrderDetails: splits,
        groupPlanId: String(planRow.rows[0].id),
        groupPlanDate: "2098-08-31"
      };
      await upsertDispatchOrderCatalog({ orders: parents, source: "global-split-group-co-red" });
      await syncDispatchDeliveryGroupsFromPlan({
        id: String(planRow.rows[0].id),
        planDate: "2098-08-31",
        revision: 1,
        orders: [...splits, group],
        trucks: []
      });

      assert.deepEqual(
        (await listDispatchOrderPool({ type: "SO", search: splits[0].id, limit: 20 }))
          .orders.map((order) => order.id),
        [group.id]
      );

      const memberCo = {
        co_ref: `CO-${splits[0].id}`,
        source_order_ref: splits[0].id,
        from_location: "2967",
        to_location: "12441",
        status: "pending_load"
      };
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: splits[0].id, co: memberCo });
      let hydrated = await getDispatchOrderCatalogOrder(group.id);
      const redirectedMember = hydrated.childOrderDetails.find((child) => child.id === splits[0].id);
      assert.equal(redirectedMember.sourceYard, "12441");
      assert.deepEqual(redirectedMember.pickupLocations, ["12441"]);
      assert.deepEqual(hydrated.pickupLocations.sort(), ["12441", "2967"].sort());
      assert.deepEqual(
        (await listDispatchOrderPool({ type: "SO", search: group.id, limit: 20 }))
          .orders[0].pickupLocations.sort(),
        ["12441", "2967"].sort()
      );

      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: splits[0].id, co: memberCo, cancelled: true });
      hydrated = await getDispatchOrderCatalogOrder(group.id);
      assert.deepEqual(hydrated.pickupLocations, ["2967"]);
      assert.ok(hydrated.childOrderDetails.every((child) => child.sourceYard === "2967"));

      const groupCo = {
        co_ref: `CO-${group.id}`,
        source_order_ref: group.id,
        from_location: "2967",
        to_location: "12441",
        status: "pending_load"
      };
      await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: group.id, co: groupCo });
      hydrated = await getDispatchOrderCatalogOrder(group.id);
      assert.equal(hydrated.sourceYard, "12441");
      assert.deepEqual(hydrated.pickupLocations, ["12441"]);
      assert.equal(hydrated.transitCo.id, groupCo.co_ref);
      assert.ok(hydrated.childOrderDetails.every((child) => child.sourceYard === "12441"));
    });
  } finally {
    await rollback.rollback();
  }
});

test("grouped CO and CO-of-group are global without hiding the source-order lifecycle", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-08-31', 'draft', $1, 1) RETURNING id`,
        [`global grouped CO ${suffix}`]
      );
      const soMembers = [
        baseOrder(`SO-CO-GROUP-${suffix}-1`, "SO"),
        baseOrder(`SO-CO-GROUP-${suffix}-2`, "SO")
      ];
      const sourceGroup = {
        ...soMembers[0],
        id: `GSO-CO-GROUP-${suffix}`,
        childOrders: soMembers.map((order) => order.id),
        childOrderDetails: soMembers,
        groupPlanId: String(planRow.rows[0].id),
        groupPlanDate: "2098-08-31"
      };
      const sourceGroupCo = {
        id: `CO-${sourceGroup.id}`,
        type: "CO",
        customer: "CO of grouped SO",
        sourceYard: "2967",
        destinationYard: "12441",
        pickupLocations: ["2967"],
        childOrders: soMembers.map((order) => order.id),
        childOrderDetails: soMembers,
        groupPlanId: String(planRow.rows[0].id),
        groupPlanDate: "2098-08-31"
      };
      const individualCos = soMembers.map((order) => ({
        id: `CO-${order.id}`,
        type: "CO",
        customer: `CO for ${order.id}`,
        sourceYard: "2967",
        destinationYard: "12441",
        pickupLocations: ["2967"]
      }));
      const groupedCos = {
        ...individualCos[0],
        id: `CO-GSO-INDIVIDUAL-${suffix}`,
        childOrders: [sourceGroupCo.id, ...individualCos.map((order) => order.id)],
        childOrderDetails: [sourceGroupCo, ...individualCos],
        groupPlanId: String(planRow.rows[0].id),
        groupPlanDate: "2098-08-31"
      };
      await upsertDispatchOrderCatalog({
        orders: [...soMembers, sourceGroupCo, ...individualCos],
        source: "global-grouped-co-red"
      });
      await syncDispatchDeliveryGroupsFromPlan({
        id: String(planRow.rows[0].id),
        planDate: "2098-08-31",
        revision: 1,
        orders: [sourceGroup, sourceGroupCo],
        trucks: []
      });

      assert.deepEqual(
        (await listDispatchOrderPool({ type: "SO", search: soMembers[0].id, limit: 20 }))
          .orders.map((order) => order.id),
        [sourceGroup.id],
        "the SO group, not its CO, owns SO member visibility"
      );
      assert.deepEqual(
        (await listDispatchOrderPool({ type: "CO", search: sourceGroupCo.id, limit: 20 }))
          .orders.map((order) => order.id),
        [sourceGroupCo.id]
      );
      assert.equal(
        Number((await query(
          "SELECT count(*)::int AS count FROM dispatch_global_order_groups WHERE group_ref = $1",
          [sourceGroupCo.id]
        )).rows[0].count),
        0,
        "a CO for a grouped source is one canonical CO, not a grouped-CO definition"
      );

      await syncDispatchDeliveryGroupsFromPlan({
        id: String(planRow.rows[0].id),
        planDate: "2098-08-31",
        revision: 2,
        orders: [sourceGroup, sourceGroupCo, groupedCos],
        trucks: []
      });
      assert.deepEqual(
        (await listDispatchOrderPool({ type: "CO", search: sourceGroupCo.id, limit: 20 }))
          .orders.map((order) => order.id),
        [groupedCos.id],
        "a true CO group replaces both direct COs and a CO-of-group globally"
      );

      const membership = await query(
        `SELECT member_order_ref, hides_member
           FROM dispatch_global_order_group_members
          WHERE group_ref = $1
          ORDER BY position`,
        [groupedCos.id]
      );
      assert.deepEqual(
        membership.rows.map((row) => row.member_order_ref).sort(),
        [sourceGroupCo.id, ...individualCos.map((order) => order.id)].sort()
      );
      assert.ok(membership.rows.every((row) => row.hides_member === true));

      const pruned = await removeDispatchGlobalGroupedMember(individualCos[0].id);
      assert.deepEqual(pruned.updated, [groupedCos.id]);
      assert.deepEqual(
        (await getDispatchOrderCatalogOrder(groupedCos.id)).childOrders.sort(),
        [sourceGroupCo.id, individualCos[1].id].sort(),
        "cancelling one unassigned CO must update its global grouped-CO definition immediately"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  reconcileDispatchPlanGlobalOrderDefinitions,
  reconcileDispatchGlobalOrderSources,
  reconcileDispatchGlobalOrderTransitCos,
  removeDispatchGlobalGroupedMember,
  syncDispatchDeliveryGroupsFromPlan,
  syncDispatchGlobalOrderTransitCo
} from "../../../src/dispatch-delivery-group-repository.js";
import { canonicalizeDispatchCoGroupIdentities } from "../../../src/dispatch-co-group-identity.js";
import {
  getDispatchOrderCatalogOrder,
  listDispatchOrderPool,
  upsertDispatchOrderCatalog
} from "../../../src/dispatch-order-catalog-repository.js";
import {
  getDispatchV2Bootstrap,
  syncDispatchPlanOrderAssignments
} from "../../../src/dispatch-planner-v2-repository.js";

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
      assert.ok(
        repaired.orderRefs.includes(split.id),
        "the global reconciliation result may also include independently changing orders"
      );

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

test("a source refresh cannot turn one aliased grouped-CO member back into an SO", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ('2098-09-02', 'draft', $1, 1) RETURNING id`,
        [`aliased grouped CO source refresh ${suffix}`]
      );
      const memberRefs = [1, 2, 3].map((index) => `SO-ALIASED-CO-${suffix}-${index}`);
      const coMembers = memberRefs.map((id, index) => ({
        ...baseOrder(id, "CO"),
        customer: `Aliased CO member ${index + 1}`,
        sourceTable: "local_co_orders",
        destinationYard: "12441"
      }));
      const group = {
        ...coMembers[0],
        id: `CO-GOA-ALIASED-${suffix}`,
        childOrders: memberRefs,
        childOrderDetails: coMembers,
        groupPlanId: String(planRow.rows[0].id),
        groupPlanDate: "2098-09-02"
      };
      await syncDispatchDeliveryGroupsFromPlan({
        id: String(planRow.rows[0].id),
        planDate: "2098-09-02",
        revision: 1,
        orders: [group],
        trucks: []
      });

      const refreshed = await reconcileDispatchGlobalOrderSources({
        orders: [{
          ...baseOrder(memberRefs[2], "SO", "3445"),
          sourceTable: "sales_orders",
          customer: "Fresh NetSuite SO must not replace the CO wrapper"
        }]
      });
      assert.deepEqual(refreshed.groups, [group.id]);
      const stored = await query(
        "SELECT full_order FROM dispatch_global_order_groups WHERE group_ref = $1",
        [group.id]
      );
      const persisted = stored.rows[0].full_order;
      assert.deepEqual(
        persisted.childOrderDetails.map((child) => ({ id: child.id, type: child.type })),
        coMembers.map((child) => ({ id: child.id, type: "CO" })),
        "the source SO refresh must not create a mixed CO/non-CO definition"
      );
      assert.equal(
        persisted.childOrderDetails[2].customer,
        coMembers[2].customer,
        "the local CO wrapper remains the operational authority for its member"
      );
      assert.doesNotThrow(() => canonicalizeDispatchCoGroupIdentities({
        orders: [persisted],
        trucks: []
      }));
    });
  } finally {
    await rollback.rollback();
  }
});

test("retired consolidation and generic derived definitions cannot be revived by a stale sync", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planDate = "2098-09-03";
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ($1::date, 'draft', $2, 1) RETURNING id`,
        [planDate, `retired non-split definitions ${suffix}`]
      );
      const planId = String(planRow.rows[0].id);
      const consolidation = {
        ...baseOrder(`TO-DRAFT-${suffix}`, "TO", "3445"),
        sourceOrderId: `SO-CONSOLIDATION-SOURCE-${suffix}`,
        globalOrderDefinitionKind: "consolidation",
        planOwned: true
      };
      const derived = {
        ...baseOrder(`CUSTOM-DERIVED-${suffix}`, "CUSTOM", "12441"),
        sourceOrderId: `SO-DERIVED-SOURCE-${suffix}`,
        globalOrderDefinitionKind: "derived",
        planOwned: true
      };
      const stalePlan = {
        id: planId,
        planDate,
        revision: 1,
        orders: [consolidation, derived],
        trucks: []
      };

      await syncDispatchDeliveryGroupsFromPlan(stalePlan);
      await deactivateDispatchGlobalOrderDefinitions([consolidation.id, derived.id]);

      await syncDispatchDeliveryGroupsFromPlan({ ...stalePlan, revision: 2 });
      const afterTolerantSync = await query(
        `SELECT split_ref, definition_kind, active
           FROM dispatch_global_order_splits
          WHERE lower(split_ref) = ANY($1::text[])
          ORDER BY definition_kind`,
        [[consolidation.id, derived.id].map((ref) => ref.toLowerCase())]
      );
      assert.deepEqual(
        afterTolerantSync.rows.map((row) => ({ kind: row.definition_kind, active: row.active })),
        [
          { kind: "consolidation", active: false },
          { kind: "derived", active: false }
        ],
        "background synchronization must skip every retired global-derived kind"
      );

      await assert.rejects(
        syncDispatchDeliveryGroupsFromPlan({ ...stalePlan, revision: 3 }, {
          rejectRetiredGlobalOrderRefs: true
        }),
        (error) => error?.code === "DISPATCH_DERIVED_ORDER_RETIRED"
          && [consolidation.id, derived.id].every((ref) => error.retiredOrderRefs?.includes(ref))
          && new Set(error.conflicts?.map((conflict) => conflict.definitionKind)).size === 2,
        "an operator write must reject stale consolidation and generic-derived snapshots"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("mixed-case explicit reactivation reuses canonical group and split row identities", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planDate = "2098-09-03";
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ($1::date, 'draft', $2, 1) RETURNING id`,
        [planDate, `mixed-case derived reactivation ${suffix}`]
      );
      const planId = String(planRow.rows[0].id);
      const members = [1, 2].map((index) => baseOrder(`SO-CASE-${suffix}-${index}`, "SO"));
      const canonicalGroup = {
        ...members[0],
        id: `GO-CASE-${suffix}`,
        customer: "2 case-sensitive orders grouped",
        childOrders: members.map((member) => member.id),
        childOrderDetails: clone(members),
        groupPlanId: planId,
        groupPlanDate: planDate,
        planOwned: true
      };
      const splitParent = baseOrder(`TO-CASE-${suffix}`, "TO", "3445");
      const canonicalSplit = {
        ...splitParent,
        id: `${splitParent.id}-S1`,
        originalOrderId: splitParent.id,
        salesQty: 4,
        items: [{ ...splitParent.items[0], quantity: 4 }],
        planOwned: true
      };
      const canonicalPlan = {
        id: planId,
        planDate,
        revision: 1,
        orders: [canonicalGroup, canonicalSplit],
        trucks: []
      };
      await syncDispatchDeliveryGroupsFromPlan(canonicalPlan);
      await deactivateDispatchGlobalOrderDefinitions([canonicalGroup.id, canonicalSplit.id]);

      const lowerGroup = { ...clone(canonicalGroup), id: canonicalGroup.id.toLowerCase() };
      const lowerSplit = { ...clone(canonicalSplit), id: canonicalSplit.id.toLowerCase() };
      await syncDispatchDeliveryGroupsFromPlan({
        ...canonicalPlan,
        revision: 2,
        orders: [lowerGroup, lowerSplit]
      }, {
        reactivatedGlobalOrderRefs: [lowerGroup.id, lowerSplit.id],
        rejectRetiredGlobalOrderRefs: true
      });

      const groupRows = await query(
        `SELECT group_ref, full_order->>'id' AS full_order_id, active
           FROM dispatch_global_order_groups
          WHERE lower(group_ref) = lower($1)`,
        [canonicalGroup.id]
      );
      assert.equal(groupRows.rowCount, 1);
      assert.deepEqual(groupRows.rows[0], {
        group_ref: canonicalGroup.id,
        full_order_id: canonicalGroup.id,
        active: true
      });
      const splitRows = await query(
        `SELECT split_ref, full_order->>'id' AS full_order_id, active
           FROM dispatch_global_order_splits
          WHERE lower(split_ref) = lower($1)`,
        [canonicalSplit.id]
      );
      assert.equal(splitRows.rowCount, 1);
      assert.deepEqual(splitRows.rows[0], {
        split_ref: canonicalSplit.id,
        full_order_id: canonicalSplit.id,
        active: true
      });
    });
  } finally {
    await rollback.rollback();
  }
});

test("an active pruned group overlays a consistent child list without rewriting its saved snapshot", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
      const planDate = "2098-09-03";
      const planRow = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note, revision)
         VALUES ($1::date, 'draft', $2, 1) RETURNING id`,
        [planDate, `pruned group live read ${suffix}`]
      );
      const planId = String(planRow.rows[0].id);
      const members = [1, 2, 3].map((index) => ({
        ...baseOrder(`SO-PRUNE-${suffix}-${index}`, "SO", index === 1 ? "3445" : "2967"),
        customer: `Prune member ${index}`
      }));
      const group = {
        ...members[0],
        id: `GO-PRUNE-${suffix}`,
        customer: "3 orders grouped",
        childOrders: members.map((member) => member.id),
        childOrderDetails: clone(members),
        groupPlanId: planId,
        groupPlanDate: planDate,
        planOwned: true
      };
      const trucks = assignedTruck(group.id);
      await query(
        `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary, saved_at)
         VALUES ($1, $2::jsonb, $3::jsonb, '{}'::jsonb, now())`,
        [planId, JSON.stringify([group]), JSON.stringify(trucks)]
      );
      await syncDispatchDeliveryGroupsFromPlan({
        id: planId,
        planDate,
        revision: 1,
        orders: [group],
        trucks
      });

      const removedRef = members[1].id;
      const retainedRefs = [members[0].id, members[2].id];
      const pruned = await removeDispatchGlobalGroupedMember(removedRef);
      assert.deepEqual(pruned.updated, [group.id]);

      const bootstrap = await getDispatchV2Bootstrap({ planId, date: planDate });
      const liveGroup = bootstrap.plan.assignedOrderSnapshots.find((order) => order.id === group.id);
      assert.deepEqual(liveGroup?.childOrders, retainedRefs);
      assert.deepEqual(
        liveGroup?.childOrderDetails.map((child) => child.id),
        retainedRefs,
        "childOrders and childOrderDetails must describe the same canonical members"
      );
      assert.equal(liveGroup?.customer, "2 orders grouped");

      const stored = await query(
        `SELECT orders
           FROM dispatch_plan_snapshots
          WHERE plan_id = $1`,
        [planId]
      );
      assert.deepEqual(
        stored.rows[0].orders[0].childOrders,
        members.map((member) => member.id),
        "the live overlay must not mutate the immutable persisted snapshot"
      );

      const direct = await reconcileDispatchPlanGlobalOrderDefinitions({
        id: planId,
        planDate,
        revision: 1,
        orders: [clone(group)],
        trucks: clone(trucks)
      });
      assert.deepEqual(direct.orders[0].childOrders, retainedRefs);
    });
  } finally {
    await rollback.rollback();
  }
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  deactivateDispatchGlobalOrderDefinitions,
  reconcileDispatchPlanGlobalOrderDefinitions,
  syncDispatchDeliveryGroupsFromPlan
} from "../../../src/dispatch-delivery-group-repository.js";
import { getDispatchOrderCatalogOrder } from "../../../src/dispatch-order-catalog-repository.js";

after(closeDb);

async function scenario(run, { type = "SO", assigned = false } = {}) {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const plans = await query(`INSERT INTO dispatch_plans(plan_date,status,revision)
        VALUES ('2097-10-28','draft',1),('2097-10-29','draft',1)
        RETURNING id::text,plan_date::text`);
      const [owner, target] = plans.rows;
      const children = [1, 2].map(index => ({
        id: `${type}-REGROUP-${index}`, type, sourceYard: "2967", pickupLocations: ["2967"],
        address: "1 Isolated Road", items: [{ sku: `REGROUP-${index}`, quantity: index }],
        eligible: true, netsuiteActive: true
      }));
      if (type === "CO") {
        for (const child of children) {
          await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,status,from_location,to_location)
            VALUES ($1,$2,'pending_load','2967','3445')`, [child.id, child.id.replace(/^CO-/, "SO-")]);
        }
      }
      const group = { ...children[0], id: type === "CO" ? "CO-GOA-REGROUP" : `G${type}-REGROUP`,
        childOrders: children.map(child => child.id), childOrderDetails: children,
        items: children.flatMap(child => child.items), planOwned: true, groupPlanId: owner.id };
      const ownerPlan = { id: owner.id, planDate: owner.plan_date, revision: 1, orders: [group], trucks: [] };
      await syncDispatchDeliveryGroupsFromPlan(ownerPlan);
      const candidate = { ...ownerPlan, id: target.id, planDate: target.plan_date,
        orders: [{ ...group, groupPlanId: target.id, groupPlanDate: target.plan_date,
          address: "2 Regrouped Road" }],
        trucks: assigned ? [{ id: "REGROUP-T1", loads: [{ id: "REGROUP-L1", name: "Load 1",
          stops: [{ id: "REGROUP-DROP", type: "drop", orderId: group.id }] }] }] : [] };
      const read = async () => (await query(`SELECT active, source_plan_id::text, full_order,
        source_revision FROM dispatch_global_order_groups WHERE group_ref=$1`, [group.id])).rows[0];
      await run({ group, ownerPlan, candidate, read });
    });
  } finally { await rollback.rollback(); }
}

for (const type of ["SO", "TO", "CO"]) {
  test(`${type}: explicit unassigned regroup on another date persists before the next save`, () => scenario(async ({ group, ownerPlan, candidate, read }) => {
    await deactivateDispatchGlobalOrderDefinitions([group.id]);
    await syncDispatchDeliveryGroupsFromPlan(candidate, {
      reactivatedGlobalOrderRefs: [group.id.toLowerCase()], rejectRetiredGlobalOrderRefs: true
    });
    const restored = await read();
    assert.equal(restored.active, true, "An acknowledged regroup must reactivate its global definition");
    assert.equal(restored.source_plan_id, ownerPlan.id, "Keep original definition provenance");
    assert.equal(restored.full_order.address, "2 Regrouped Road");
    assert.deepEqual(restored.full_order.items, candidate.orders[0].items);
    assert.equal((await getDispatchOrderCatalogOrder(group.id))?.globalGroupDefinition, true);
    const next = await reconcileDispatchPlanGlobalOrderDefinitions(candidate, { rejectRetiredGlobalOrderRefs: true });
    await syncDispatchDeliveryGroupsFromPlan(next, { rejectRetiredGlobalOrderRefs: true });
    assert.deepEqual(await read(), restored, "Ordinary subsequent save preserves the restored definition");
  }, { type }));
}

test("stale snapshots cannot restore a retired group with or without a load", async () => {
  for (const assigned of [false, true]) { await scenario(async ({ group, candidate, read }) => {
    await deactivateDispatchGlobalOrderDefinitions([group.id]);
    const retired = await read();
    await assert.rejects(syncDispatchDeliveryGroupsFromPlan(candidate, { rejectRetiredGlobalOrderRefs: true }),
      { code: "DISPATCH_DERIVED_ORDER_RETIRED" });
    await syncDispatchDeliveryGroupsFromPlan(candidate);
    assert.deepEqual(await read(), retired);
  }, { assigned }); }
});

test("explicit flags do not overwrite another plan's active unassigned group", () => scenario(async ({ group, candidate, read }) => {
  const before = await read();
  await syncDispatchDeliveryGroupsFromPlan(candidate, {
    reactivatedGlobalOrderRefs: [group.id], rejectRetiredGlobalOrderRefs: true
  });
  assert.deepEqual(await read(), before);
}));

test("reactivation is scoped to the explicit reference and rolls back atomically", () => scenario(async ({ group, ownerPlan, candidate, read }) => {
  const other = { ...group, id: "GSO-OTHER-RETIRED" };
  await syncDispatchDeliveryGroupsFromPlan({ ...ownerPlan, orders: [group, other] });
  await deactivateDispatchGlobalOrderDefinitions([group.id, other.id]);
  await query("SAVEPOINT regroup_atomicity");
  await syncDispatchDeliveryGroupsFromPlan(candidate, { reactivatedGlobalOrderRefs: [group.id] });
  assert.equal((await read()).active, true);
  assert.equal((await query("SELECT active FROM dispatch_global_order_groups WHERE group_ref=$1", [other.id])).rows[0].active, false);
  await query("ROLLBACK TO SAVEPOINT regroup_atomicity");
  assert.equal((await read()).active, false);
}));

test("property: only explicit recreation or an existing active definition can remain active", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("SO", "TO", "CO"), fc.boolean(), fc.boolean(), fc.boolean(),
    (type, retired, explicit, assigned) => scenario(async ({ group, candidate, read }) => {
      if (retired) { await deactivateDispatchGlobalOrderDefinitions([group.id]); }
      const before = await read();
      await syncDispatchDeliveryGroupsFromPlan(candidate, {
        reactivatedGlobalOrderRefs: explicit ? [group.id.toLowerCase()] : []
      });
      const saved = await read();
      assert.equal(saved.active, !retired || explicit);
      assert.equal(saved.source_plan_id, before.source_plan_id);
      if (!retired && !assigned) { assert.deepEqual(saved, before); }
      if (retired && !explicit) { assert.deepEqual(saved, before); }
      if (retired && explicit) { assert.deepEqual(saved.full_order.items, candidate.orders[0].items); }
    }, { type, assigned })), { seed: 20261028, numRuns: 36 });
});

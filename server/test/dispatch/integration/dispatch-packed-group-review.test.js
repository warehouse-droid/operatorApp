import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import { syncDispatchDeliveryGroupsFromPlan } from "../../../src/dispatch-delivery-group-repository.js";
import { getDispatchOrderCatalogOrder } from "../../../src/dispatch-order-catalog-repository.js";
import { activeSalesOrderFamilyDraft } from "../../../src/sales-order-reconciliation-repository.js";
import { refreshPackedGroupReviews } from "../../../tools/refresh-dispatch-packed-group-reviews.mjs";

after(closeDb);

let fixtureSequence = 0;
async function fixture({ status = "packed", progress = true, stale = false, locked = false } = {}) {
  const seed = 9_881_100_000 + (fixtureSequence += 10);
  const ids = [seed + 1, seed + 2];
  const refs = ids.map(id => `TST-SOB${id}`);
  const groupRef = `GOB-PACKED-${seed}`;
  for (const [index, id] of ids.entries()) {
    await query(`INSERT INTO sales_orders (netsuite_id,tranid,status,status_text,customer,
      sales_order_type,operator_status,local_yard_order_status,fulfillment_status,
      netsuite_active,preparing_operator_id)
      VALUES ($1,$2,'B','Sales Order : Pending Fulfillment','Packed group fixture',
      'Delivery',$3,'Open','not_fulfilled',true,$4)`,
    [id, refs[index], status, locked ? "packed-group-fixture" : null]);
    await query(`INSERT INTO sales_order_lines (sales_order_id,line_id,item_id,item_name,
      item_type,quantity,unit,confirmed,packed_sales_qty,pack_quantity_source,netsuite_active)
      VALUES ($1,$2,25,'Packed fixture item','InvtPart',10,'EA',$3,$4,'sales_only',true)`,
    [id, seed + 101 + index, progress, progress ? 10 : 0]);
  }
  const review = stale ? {
    reconciliationStatus: "review", reconciliationBlocked: true,
    reconciliationApplicationStatus: "Reconcile Review",
    reconciliationReason: "Sales Order family reconciliation is blocked by an active operator packing draft."
  } : {};
  const children = refs.map(id => ({ id, type: "SO", pallets: 1, salesQty: 10,
    packed: { pallets: 1 }, items: [{ sku: "PACKED-FIXTURE", quantity: 10 }], ...review }));
  const group = { id: groupRef, type: "SO", childOrders: refs, childOrderDetails: children,
    pallets: 2, salesQty: 20, ...review };
  const { rows: [plan] } = await query(`INSERT INTO dispatch_plans (plan_date,status,note)
    VALUES ('2099-11-27','draft','Packed group review fixture') RETURNING id`);
  await query(`INSERT INTO dispatch_plan_snapshots (plan_id,orders,trucks,summary)
    VALUES ($1,$2::jsonb,'[]'::jsonb,'{}'::jsonb)`, [plan.id, JSON.stringify([group])]);
  return { ids, refs, groupRef, planId: plan.id };
}

async function sourceState(f) {
  return {
    orders: (await query("SELECT * FROM sales_orders WHERE netsuite_id=ANY($1::bigint[]) ORDER BY netsuite_id", [f.ids])).rows,
    lines: (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id", [f.ids])).rows,
    plan: (await query("SELECT * FROM dispatch_plans WHERE id=$1", [f.planId])).rows,
    snapshot: (await query("SELECT * FROM dispatch_plan_snapshots WHERE plan_id=$1", [f.planId])).rows
  };
}

for (const stale of [false, true]) {
  test(`packed confirmed group ${stale ? "clears an old false review" : "stays available for dispatch"}`, async () => {
    await withTransaction(async () => {
      const f = await fixture({ stale });
      const before = await sourceState(f);
      const plan = await getDispatchPlan(f.planId);
      const group = plan.orders.find(order => order.id === f.groupRef);
      assert.equal(group.reconciliationApplicationStatus, "Queued");
      assert.equal(group.reconciliationBlocked, false);
      assert.equal(group.reconciliationReason, "");
      assert.deepEqual(group.childOrders, f.refs);
      assert.equal(group.salesQty, 20);
      assert.equal(group.pallets, 2);
      assert.ok(group.childOrderDetails.every(child => child.operatorStatus === "packed" && !child.reconciliationBlocked));
      assert.deepEqual((await getDispatchPlan(f.planId)).orders, plan.orders);
      assert.deepEqual(await sourceState(f), before, "reading must preserve packing, quantities and saved plan history");
      await syncDispatchDeliveryGroupsFromPlan(plan);
      const catalog = await getDispatchOrderCatalogOrder(f.groupRef);
      assert.equal(catalog.reconciliationBlocked, false);
      const stored = (await query("SELECT full_order,card FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef])).rows[0];
      assert.equal(stored.full_order.reconciliationApplicationStatus, "Queued");
      assert.equal(stored.card.reconciliationBlocked, false);
      assert.equal(stored.card.reconciliationReason, "");
      assert.deepEqual(await sourceState(f), before);
    }, { rollback: true });
  });
}

test("packed groups remain protected from authoritative reconciliation writes", async () => {
  await withTransaction(async () => {
    const f = await fixture();
    const before = await sourceState(f);
    assert.equal((await activeSalesOrderFamilyDraft({ familyIds: f.ids, familyRefs: f.refs })).blocked, true);
    assert.deepEqual(await sourceState(f), before);
  }, { rollback: true });
});

for (const [name, options] of [
  ["active preparing order", { status: "preparing", progress: false }],
  ["unfinished progress on open order", { status: "open", progress: true }],
  ["active preparation lock on packed order", { locked: true }]
]) {
  test(`${name} keeps draft protection`, async () => {
    await withTransaction(async () => {
      const f = await fixture(options);
      const group = (await getDispatchPlan(f.planId)).orders[0];
      assert.equal(group.reconciliationApplicationStatus, "Reconcile Review");
      assert.equal(group.reconciliationBlocked, true);
      assert.match(group.reconciliationReason, /active operator packing draft/);
    }, { rollback: true });
  });
}

for (const status of ["review", "missing", "error"]) {
  test(`packed group retains genuine ${status} state and its reason`, async () => {
    await withTransaction(async () => {
      const f = await fixture();
      await query(`INSERT INTO scm_reconciliation_order_state (order_kind,source_order_netsuite_id,
        source_order_ref,application_status,reconciliation_status,reconciliation_reason)
        VALUES ('SO',$1,$2,'Reconcile Review',$3,'Authoritative line identity needs review')`,
      [f.ids[0], f.refs[0], status]);
      const group = (await getDispatchPlan(f.planId)).orders[0];
      assert.equal(group.reconciliationBlocked, true);
      assert.equal(group.reconciliationReason, "Authoritative line identity needs review");
    }, { rollback: true });
  });
}

for (const count of [1, 2]) {
  test(`${count} fulfilled member(s) retain the correct completion rollup beside packed orders`, async () => {
    await withTransaction(async () => {
      const f = await fixture();
      await query("UPDATE sales_orders SET fulfillment_status='fulfilled' WHERE netsuite_id=ANY($1::bigint[])", [f.ids.slice(0, count)]);
      const group = (await getDispatchPlan(f.planId)).orders[0];
      assert.equal(group.reconciliationApplicationStatus, count === 1 ? "Partially Done" : "Completed");
      assert.equal(group.reconciliationBlocked, false);
    }, { rollback: true });
  });
}

test("refreshing old group cards changes only review fields and preserves real reviews", async () => {
  await withTransaction(async () => {
    const f = await fixture({ stale: true });
    const before = await sourceState(f);
    const oldGroup = before.snapshot[0].orders[0];
    await syncDispatchDeliveryGroupsFromPlan({ id: f.planId, planDate: "2099-11-27", orders: [oldGroup], trucks: [] });
    const cachedBefore = (await query("SELECT full_order,card FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef])).rows[0];
    await query(`INSERT INTO scm_reconciliation_order_state (order_kind,source_order_netsuite_id,
      source_order_ref,application_status,reconciliation_status,reconciliation_reason)
      VALUES ('SO',$1,$2,'Reconcile Review','review','Genuine source mismatch')`, [f.ids[0], f.refs[0]]);
    const protectedResult = await refreshPackedGroupReviews({ apply: true });
    assert.deepEqual(protectedResult.cleared, []);
    assert.equal(protectedResult.retained[0].groupRef, f.groupRef);
    assert.deepEqual((await query("SELECT full_order,card FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef])).rows[0], cachedBefore);
    await query("DELETE FROM scm_reconciliation_order_state WHERE source_order_netsuite_id=$1", [f.ids[0]]);
    const repaired = await refreshPackedGroupReviews({ apply: true });
    assert.deepEqual(repaired.cleared, [{ groupRef: f.groupRef, status: "Queued" }]);
    const cachedAfter = (await query("SELECT full_order,card FROM dispatch_global_order_groups WHERE group_ref=$1", [f.groupRef])).rows[0];
    const withoutReview = value => JSON.parse(JSON.stringify(value, (key, item) => key.startsWith("reconciliation") ? undefined : item));
    assert.deepEqual(withoutReview(cachedAfter), withoutReview(cachedBefore), "cache refresh must preserve every non-review field");
    assert.equal(cachedAfter.card.reconciliationBlocked, false);
    assert.deepEqual(await sourceState(f), before);
    assert.deepEqual((await refreshPackedGroupReviews({ apply: true })).cleared, [], "refresh must be idempotent");
  }, { rollback: true });
});

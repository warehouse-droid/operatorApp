import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { reconcileDispatchPlanLocalCos } from "../../../src/dispatch-co-lifecycle.js";
import { materializeDispatchPickupVisits } from "../../../src/dispatch-pickup-visits.js";
import { getDispatchOrderCatalogOrder } from "../../../src/dispatch-order-catalog-repository.js";
import { compactDispatchOrderCard } from "../../../src/dispatch-planner-optimization.js";
import { createDispatchPlan, saveDispatchPlanSnapshot } from "../../../src/dispatch-plan-repository.js";
import { applyDispatchV2Command, getDispatchV2Bootstrap } from "../../../src/dispatch-planner-v2-repository.js";
import { syncDispatchGlobalOrderTransitCo } from "../../../src/dispatch-delivery-group-repository.js";
import { coFixture, staleCoFixture } from "../../support/co-cargo-fixture.mjs";

after(closeDb);

async function fixture(operation) {
  const rollback = await beginRollbackContext();
  try { return await rollback.run(async () => {
    const suffix = crypto.randomUUID();
    const full = coFixture(suffix);
    const co = (await query(`INSERT INTO local_co_orders
      (co_ref, source_order_ref, from_location, to_location, status, details)
      VALUES ($1,$2,'2967','12441','pending_load',$3::jsonb) RETURNING id`,
    [full.id, full.sourceOrderId, JSON.stringify({ sourceOrderType: "SO", childOrderIds: full.childOrders, childOrderDetails: full.childOrderDetails })])).rows[0];
    for (const item of full.items) {await query(`INSERT INTO local_co_order_lines
      (co_id,line_id,item_id,sku,item_name,item_type,quantity,pallet_qty,raw)
      VALUES ($1,$2,$3,$4,$4,'InvtPart',$5,$6,$7::jsonb)`,
    [co.id,item.lineId,item.itemId,item.sku,item.quantity,item.pallets,JSON.stringify(item)]);}
    const stale = staleCoFixture(suffix);
    const plan = { orders: [stale], trucks: [{ id: "T4", loads: [{ id: "L4", name: "Load 4", pickupVisitSchemaVersion: 1,
      stops: [{ id: "D", type: "drop", orderId: full.id }] }] }] };
    return operation({ full, stale, plan, co });
  }); } finally { await rollback.rollback(); }
}

test("plan CO authority restores the persisted cargo without rewriting stops or source orders", async () => fixture(async ({ plan, full }) => {
  const before = structuredClone(plan);
  const result = await reconcileDispatchPlanLocalCos(plan);
  assert.deepEqual(result.orders[0].items.map((i) => [i.sku,i.quantity,i.pallets]), full.items.map((i) => [i.sku,i.quantity,i.pallets]));
  assert.equal(result.orders[0].pallets, 6);
  assert.deepEqual(result.orders[0].childOrderDetails, full.childOrderDetails);
  assert.equal(Boolean(result.orders[0].globalGroupDefinition), false);
  assert.deepEqual(result.trucks, plan.trucks);
  assert.deepEqual(plan, before);
  assert.deepEqual(await reconcileDispatchPlanLocalCos(result), result);
}));

test("empty CO cargo cannot bypass missing-pickup validation after authority refresh", async () => fixture(async ({ plan, full }) => {
  const restored = await reconcileDispatchPlanLocalCos(plan);
  const conflicts = materializeDispatchPickupVisits(restored).conflicts;
  assert.ok(conflicts.some((c) => c.code === "DISPATCH_PICKUP_ORDER_MISSING" && c.orderRef === full.id));
  restored.trucks[0].loads[0].stops.unshift({ id: "P", type: "pick", orderId: full.id, orderRefs: [full.id], location: "2967" });
  assert.deepEqual(materializeDispatchPickupVisits(restored).conflicts, []);
}));

test("a CO manifest remains physical cargo even when its source raw lines carry PO allocations", async () => fixture(async ({ plan, co, full }) => {
  await query(`UPDATE local_co_order_lines SET raw=raw || jsonb_build_object(
    'poAllocatedPallets',pallet_qty,'poAllocatedSalesQty',quantity) WHERE co_id=$1`, [co.id]);
  const restored = await reconcileDispatchPlanLocalCos(plan);
  assert.equal(restored.orders[0].pallets, 6);
  assert.ok(materializeDispatchPickupVisits(restored).conflicts.some((conflict) => conflict.orderRef === full.id && conflict.code === "DISPATCH_PICKUP_ORDER_MISSING"));
}));

test("executed CO cargo and completed stop evidence remain unchanged", async () => fixture(async ({ plan, co }) => {
  await query("UPDATE local_co_orders SET status='completed' WHERE id=$1", [co.id]);
  plan.trucks[0].loads[0].stops[0].status = "completed";
  const result = await reconcileDispatchPlanLocalCos(plan);
  assert.deepEqual(result.orders[0].items, plan.orders[0].items);
  assert.deepEqual(result.trucks, plan.trucks);
}));

test("targeted CO hydration ignores the empty legacy group cargo", async () => fixture(async ({ full, stale }) => {
  await query(`INSERT INTO dispatch_global_order_groups (group_ref,order_type,source_plan_date,full_order,card,search_text)
    VALUES ($1,'CO','2098-10-01',$2::jsonb,$3::jsonb,$1)`,
  [full.id, JSON.stringify(stale), JSON.stringify(compactDispatchOrderCard(stale))]);
  const hydrated = await getDispatchOrderCatalogOrder(full.id);
  assert.equal(hydrated.items.length, 2);
  assert.equal(hydrated.pallets, 6);
  assert.deepEqual(hydrated.childOrderDetails, full.childOrderDetails);
}));

test("source-group refresh cannot replace one CO manifest with its source children's items", async () => fixture(async ({ full }) => {
  full.childOrderDetails[1].items.push({ sku: "Delivery Charge", itemType: "OthCharge", quantity: 1 });
  await query(`INSERT INTO dispatch_global_order_groups (group_ref,order_type,source_plan_date,full_order,card,search_text)
    VALUES ($1,'CO','2098-10-01',$2::jsonb,$3::jsonb,$1)`,
  [full.id, JSON.stringify(full), JSON.stringify(compactDispatchOrderCard(full))]);
  await syncDispatchGlobalOrderTransitCo({ sourceOrderRef: full.sourceOrderId,
    co: { co_ref: full.id, source_order_ref: full.sourceOrderId, from_location: "2967", to_location: "12441", status: "pending_load" } });
  const stored = (await query("SELECT full_order FROM dispatch_global_order_groups WHERE group_ref=$1", [full.id])).rows[0].full_order;
  assert.deepEqual(stored.items, full.items);
  assert.equal(stored.sourceOrderId, full.sourceOrderId);
}));

test("full and incremental saves retain authoritative CO cargo through repeated stale submissions", async () => fixture(async ({ full, stale }) => {
  const plan = await createDispatchPlan({ planDate: "2098-10-01", note: "CO cargo save regression" });
  const truck = (await query("INSERT INTO dispatch_trucks (plate,active) VALUES ($1,true) RETURNING id::text,plate", [`CO-${crypto.randomUUID().slice(0,8)}`])).rows[0];
  const trucks = [{ ...truck, loads: [{ id: "CARGO-L4", name: "Load 4", pickupVisitSchemaVersion: 1, stops: [
    { id: "P", type: "pick", orderId: full.id, orderRefs: [full.id], location: "2967" },
    { id: "D", type: "drop", orderId: full.id }
  ] }] }];
  let saved = await saveDispatchPlanSnapshot(plan.id, { planDate: plan.planDate, baseRevision: plan.revision, orders: [stale], trucks, summary: {} });
  assert.equal(saved.orders.find((o) => o.id === full.id).items.length, 2);
  for (let index = 0; index < 12; index += 1) {
    const bootstrap = await getDispatchV2Bootstrap({ planId: plan.id });
    const result = await applyDispatchV2Command({ planId: plan.id, command: {
      commandId: crypto.randomUUID(), commandType: "replace_plan", baseRevision: saved.revision,
      baseDigest: bootstrap.plan.digest, payload: { ...saved, orders: [stale] }
    } });
    saved = { ...result.payload.plan, orders: result.payload.plan.assignedOrderSnapshots };
    assert.equal(saved.orders.find((o) => o.id === full.id).items.length, 2);
    assert.equal(saved.orders.find((o) => o.id === full.id).pallets, 6);
    assert.deepEqual(saved.trucks[0].loads[0].stops.map((s) => s.id), ["P", "D"]);
  }
}));

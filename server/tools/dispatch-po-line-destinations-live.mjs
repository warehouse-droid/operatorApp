import assert from "node:assert/strict";
import { query, withTransaction, closeDb } from "./src/db.js";
import { listDispatchOrders, enrichDispatchOrdersWithPoTargetAllocations } from "./src/dispatch-repository.js";
import { saveDispatchPlanSnapshot } from "./src/dispatch-plan-repository.js";
import { reconcileAuthoritativeDispatchOrderProjection } from "./src/dispatch-plan-order-projection.js";
import { persistedDispatchPlan } from "./src/dispatch-plan-fence.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./src/dispatch-fleet-status.js";
import { getDispatchV2Bootstrap } from "./src/dispatch-planner-v2-repository.js";

const mode = process.argv.includes("--repair") ? "repair" : process.argv.includes("--preview") ? "preview" : "verify";
const ref = "SN1401728";
const planId = "342";
const expectedArg = process.argv.find(value => value.startsWith("--revision="));
const expectedRevision = expectedArg ? Number(expectedArg.slice("--revision=".length)) : null;

function relevantOrder(plan) {
  const order = plan.orders.find(candidate => candidate.id === ref);
  assert.ok(order, "SN1401728 must remain in the plan");
  return order;
}

function projectionSummary(order) {
  return order.poRouteProjection.dropoffs.map(drop => [drop.destinationYard, drop.pallets, drop.weight]);
}

function expectedProjection(order) {
  assert.deepEqual(projectionSummary(order), [["2967", 3, 10500], ["3445", 5, 15872]]);
  assert.equal(order.poRouteProjection.pallets, 8);
  assert.deepEqual(order.poRouteProjection.allocations.map(row => [String(row.poLineId), row.pallets, row.salesQty]), [["492674", 1, 720]]);
}

function containingLoads(plan) {
  return plan.trucks.flatMap(truck => truck.loads || []).filter(load => (load.stops || []).some(stop =>
    stop.orderId === ref || (stop.orderRefs || []).includes(ref)));
}

try {
  const report = await withTransaction(async () => {
    if (mode === "verify") {await query("SET TRANSACTION READ ONLY");}
    else {await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);}
    await query("SET LOCAL statement_timeout='30s'");
    const row = (await query(`SELECT p.id,p.plan_date::text,p.status,p.note,p.revision,s.orders,s.trucks,s.summary,s.saved_at
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1
      ${mode === "verify" ? "" : "FOR UPDATE OF p"}`, [planId])).rows[0];
    assert.ok(row);
    const before = persistedDispatchPlan(row);
    if (mode === "repair") {assert.equal(before.revision, expectedRevision, "Plan changed since preview; obtain a fresh preview");}
    const originalOrder = relevantOrder(before);
    const loadIds = containingLoads(before).map(load => load.id);
    assert.equal(loadIds.length, 1, "Repair expects one existing SN1401728 load");
    const allocationBefore = (await query("SELECT * FROM dispatch_so_po_allocations WHERE po_order_id=1026879 ORDER BY id")).rows;
    const sourceLinesBefore = (await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=1026879 ORDER BY id")).rows;
    if (mode === "verify") {
      expectedProjection(originalOrder);
      const bootstrap = await getDispatchV2Bootstrap({ planId });
      const compact = bootstrap.plan.assignedOrderSnapshots.find(order => order.id === ref);
      assert.equal(compact.dropoffs.length, 2);
      expectedProjection(compact);
      return { verified: true, planId, revision: before.revision, ref, destinations: projectionSummary(compact),
        directPickup: { target: "SOA09523", pallets: 1 }, compactFullDropoffs: compact.dropoffs.length };
    }
    assert.equal((await query(`SELECT count(*)::int AS count FROM driver_job_records WHERE plan_id=$1
      AND load_id=ANY($2::text[]) AND status IN ('in_progress','complete')`, [planId, loadIds])).rows[0].count, 0,
    "The affected load has started; driver evidence must be preserved");
    assert.equal((await query(`SELECT count(*)::int AS count FROM dispatch_plan_load_assignments WHERE plan_id=$1
      AND load_id=ANY($2::text[]) AND completed=true`, [planId, loadIds])).rows[0].count, 0,
    "The affected load is completed");
    const source = (await listDispatchOrders({ exactOrderRefs: [ref], includeHiddenScm: true,
      includeAllDiscoverableScmPurchaseOrders: true, unboundedPerType: true })).find(order => order.id === ref);
    assert.ok(source);
    assert.deepEqual(source.dropoffs.map(drop => [drop.destinationYard, drop.pallets]), [["2967", 4], ["3445", 5]]);
    assert.deepEqual(source.items.map(item => [String(item.lineRowId), item.quantity, item.destinationYard]),
      originalOrder.items.map(item => [String(item.lineRowId), item.quantity, item.destinationYard]));
    const projected = (await enrichDispatchOrdersWithPoTargetAllocations([{ ...originalOrder, dropoffs: source.dropoffs }]))[0];
    expectedProjection(projected);
    const projectedOrders = before.orders.map(order => order.id === ref ? projected : order);
    const candidate = reconcileAuthoritativeDispatchOrderProjection({ plan: before, projectedOrders }).plan;
    const result = await saveDispatchPlanSnapshot(planId, { orders: candidate.orders, trucks: candidate.trucks,
      summary: candidate.summary, planDate: before.planDate, baseRevision: before.revision,
      sessionId: "repair-sn1401728-line-destinations-20260930" });
    const afterRow = (await query(`SELECT p.id,p.plan_date::text,p.status,p.note,p.revision,s.orders,s.trucks,s.summary,s.saved_at
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [planId])).rows[0];
    const after = persistedDispatchPlan(afterRow);
    expectedProjection(relevantOrder(after));
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual((await query("SELECT * FROM dispatch_so_po_allocations WHERE po_order_id=1026879 ORDER BY id")).rows, allocationBefore);
    assert.deepEqual((await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=1026879 ORDER BY id")).rows, sourceLinesBefore);
    for (const truck of before.trucks) {
      const savedTruck = after.trucks.find(entry => entry.id === truck.id);
      assert.ok(savedTruck, "Every existing truck is retained");
      for (const load of truck.loads || []) {
        const savedLoad = (savedTruck.loads || []).find(entry => entry.id === load.id);
        assert.ok(savedLoad, "Every existing load is retained");
        if (!loadIds.includes(load.id)) {assert.deepEqual(savedLoad.stops, load.stops, "Unrelated route stops are retained");}
      }
    }
    const drops = containingLoads(after)[0].stops.filter(stop => stop.orderId === ref && stop.type === "drop");
    assert.deepEqual(drops.map(stop => [stop.dropLocation, stop.dropPallets]), [["2967", 3], ["3445", 5]]);
    return { mode, rolledBack: mode !== "repair", planId, beforeRevision: before.revision, afterRevision: after.revision,
      ref, destinations: projectionSummary(relevantOrder(after)), stops: drops.map(stop => ({ id: stop.id,
        location: stop.dropLocation, pallets: stop.dropPallets })), directPickupUnchanged: true,
      sourceLinesUnchanged: true, unrelatedStopsUnchanged: true, saved: Boolean(result), backup: row };
  }, { rollback: mode !== "repair" });
  console.log(JSON.stringify(report));
} finally {await closeDb();}

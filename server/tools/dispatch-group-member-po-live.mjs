// Run from /app using the normal save path. Preview rolls back every DB write.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { query, withTransaction, closeDb } from "./src/db.js";
import { enrichDispatchOrdersWithPoTargetAllocations } from "./src/dispatch-repository.js";
import { saveDispatchPlanSnapshot } from "./src/dispatch-plan-repository.js";
import { stripDispatchRelationshipProjections, reconcileAuthoritativeDispatchOrderProjection } from "./src/dispatch-plan-order-projection.js";
import { persistedDispatchPlan } from "./src/dispatch-plan-fence.js";
import { dispatchRequiredPickupVisitLocations } from "./src/dispatch-pickup-visits.js";
import { dispatchPhysicalStopVisits } from "./src/dispatch-load-assignment.js";
import { lockDispatchPlanEditLeaseDate } from "./src/dispatch-plan-lease-repository.js";
import { getDispatchV2Bootstrap } from "./src/dispatch-planner-v2-repository.js";
import { writeDispatchAudit } from "./src/dispatch-audit-repository.js";

const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--verify") ? "verify" : "preview";
const expectedHash = process.argv.find(arg => arg.startsWith("--hash="))?.slice(7);
const ref = "GOM-6255S2-6256S2-6662-6663";
const planId = "343";
const loadId = "T5-L1790802618906-1948df55737158";
const vendor = "TECHO BLOC Vaughan";
const members = ["SOM06255-S2", "SOM06256-S2", "SOM06662", "SOM06663"];
const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function readPlan() {
  return (await query(`SELECT p.id,p.plan_date::text,p.status,p.note,p.revision,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [planId])).rows[0];
}

const group = plan => plan.orders.find(order => order.id === ref);
const load = plan => plan.trucks.flatMap(truck => truck.loads || []).find(candidate => candidate.id === loadId);
const routeSummary = plan => load(plan).stops.map(stop => ({ id: stop.id, type: stop.type,
  orderId: stop.orderId, orderRefs: stop.orderRefs || [], location: stop.location, dropLocation: stop.dropLocation }));

function checkProjection(order) {
  assert.deepEqual([...order.childOrders].sort(), members);
  assert.deepEqual(dispatchRequiredPickupVisitLocations(order), [vendor]);
  assert.deepEqual(order.items.filter(item => Number(item.quantity) > 0).map(item => Number(item.poAllocatedSalesQty)),
    [2, 270.78, 52.75, 1274.4]);
  assert.deepEqual(order.poPickupManifest.map(entry => entry.poOrderRef).sort(), ["LOINC-035332", "LOINC-036776"]);
  assert.equal(order.poPickupManifest.flatMap(entry => entry.items).length, 4);
}

function checkRoute(plan) {
  checkProjection(group(plan));
  assert.equal(load(plan).stops.filter(stop => stop.type === "pick" && stop.location === "150").length, 0);
  const visits = load(plan).stops.filter(stop => stop.type === "pick" && stop.location === vendor);
  assert.equal(visits.length, 1);
  assert.deepEqual([...visits[0].orderRefs].sort(), [ref, "LOINC-033778"]);
  assert.equal(load(plan).stops.filter(stop => stop.type === "drop" && stop.orderId === ref).length, 1);
  const truck = plan.trucks.find(candidate => candidate.loads.some(entry => entry.id === loadId));
  const physicalVisits = dispatchPhysicalStopVisits(plan, truck, load(plan));
  assert.equal(physicalVisits.length, 3);
  assert.deepEqual(physicalVisits.map(visit => visit.type), ["pick", "drop", "drop"]);
  assert.ok(group(plan).address && group(plan).address !== "150");
  assert.equal(physicalVisits[1].address, group(plan).address);
  assert.ok(physicalVisits[2].address.includes("3445"));
}

try {
  const result = await withTransaction(async () => {
    await query("SET LOCAL statement_timeout='45s'");
    await query("SET LOCAL lock_timeout='15s'");
    if (mode === "verify") { await query("SET TRANSACTION READ ONLY"); }
    else {
      await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'))");
      await lockDispatchPlanEditLeaseDate("2026-10-01");
      const activeEditors = (await query(`SELECT count(*)::int AS count FROM dispatch_plan_edit_leases
        WHERE plan_date='2026-10-01' AND expires_at>clock_timestamp()`)).rows[0].count;
      // Rehearsal never commits. An actual repair requires the editor to exit.
      if (mode === "apply") { assert.equal(activeEditors, 0, "Dispatcher is editing; defer repair"); }
      await query("SELECT id FROM dispatch_plans WHERE id=$1 FOR UPDATE", [planId]);
    }
    const row = await readPlan();
    const before = persistedDispatchPlan(row);
    if (mode === "verify") {
      checkRoute(before);
      const bootstrap = await getDispatchV2Bootstrap({ planId });
      const compact = bootstrap.plan.assignedOrderSnapshots.find(order => order.id === ref);
      checkProjection(compact);
      return { verified: true, planId, revision: before.revision, group: ref,
        requiredPickups: dispatchRequiredPickupVisitLocations(compact), route: routeSummary(before) };
    }
    const allocationBefore = (await query(`SELECT * FROM dispatch_so_po_allocations
      WHERE dispatch_target_ref=ANY($1::text[]) ORDER BY id`, [members])).rows;
    const beforeHash = fingerprint({ row, allocationBefore });
    if (mode === "apply") { assert.equal(beforeHash, expectedHash, "Plan or PO links changed since preview"); }
    assert.equal((await query(`SELECT count(*)::int AS count FROM driver_job_records
      WHERE plan_id=$1 AND load_id=$2 AND status IN ('in_progress','complete')`, [planId, loadId])).rows[0].count, 0,
    "Driver work has started; preserve its route");
    assert.equal((await query(`SELECT count(*)::int AS count FROM dispatch_plan_load_assignments
      WHERE plan_id=$1 AND load_id=$2 AND (started OR completed)`, [planId, loadId])).rows[0].count, 0,
    "Affected load has started or completed");
    const [projected] = await enrichDispatchOrdersWithPoTargetAllocations(stripDispatchRelationshipProjections([group(before)]));
    checkProjection(projected);
    const candidate = structuredClone(before);
    const target = load(candidate);
    const obsolete = target.stops.filter(stop => stop.type === "pick" && stop.location === "150");
    assert.equal(obsolete.length, 1);
    assert.equal(obsolete[0].orderId, ref);
    assert.deepEqual(obsolete[0].orderRefs, [ref]);
    target.stops = target.stops.filter(stop => stop.id !== obsolete[0].id);
    const vendorStop = target.stops.find(stop => stop.type === "pick" && stop.location === vendor);
    assert.ok(vendorStop);
    assert.deepEqual(vendorStop.orderRefs, ["LOINC-033778"]);
    vendorStop.orderRefs = ["LOINC-033778", ref];
    const reconciled = reconcileAuthoritativeDispatchOrderProjection({ plan: candidate,
      projectedOrders: candidate.orders.map(order => order.id === ref ? projected : order) }).plan;
    let backup = null;
    if (mode === "apply") {
      const directory = "/app/data/support-fixes";
      await mkdir(directory, { recursive: true, mode: 0o700 });
      backup = `${directory}/dispatch-group-member-po-20261001-${Date.now()}.json`;
      await writeFile(backup, JSON.stringify({ beforeHash, row, allocationBefore }), { mode: 0o600, flag: "wx" });
    }
    await saveDispatchPlanSnapshot(planId, { orders: reconciled.orders, trucks: reconciled.trucks,
      summary: reconciled.summary, planDate: before.planDate, baseRevision: before.revision,
      sessionId: "support-group-member-po-20261001" });
    const after = persistedDispatchPlan(await readPlan());
    checkRoute(after);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual((await query(`SELECT * FROM dispatch_so_po_allocations
      WHERE dispatch_target_ref=ANY($1::text[]) ORDER BY id`, [members])).rows, allocationBefore);
    for (const truck of before.trucks) {
      const savedTruck = after.trucks.find(entry => entry.id === truck.id);
      assert.ok(savedTruck);
      assert.deepEqual(savedTruck.loads.map(entry => entry.id), truck.loads.map(entry => entry.id));
      for (const prior of truck.loads) {
        const next = savedTruck.loads.find(entry => entry.id === prior.id);
        if (prior.id !== loadId) { assert.deepEqual(next.stops, prior.stops, `Unrelated load ${prior.id} changed`); }
      }
    }
    assert.deepEqual(load(after).stops.map(stop => stop.id), load(before).stops.filter(stop => stop.id !== obsolete[0].id).map(stop => stop.id));
    const dropFields = stop => Object.fromEntries(Object.entries(stop).filter(([key]) => ![
      "timing", "arriveTime", "departTime", "plannedArrive", "plannedDepart", "plannedArrival", "plannedDeparture"
    ].includes(key)));
    assert.deepEqual(load(after).stops.filter(stop => stop.type === "drop").map(dropFields),
      load(before).stops.filter(stop => stop.type === "drop").map(dropFields));
    await writeDispatchAudit({ action: "support_group_member_po_route_corrected", entityType: "dispatch_plan",
      entityId: planId, planId, planDate: before.planDate, sessionId: "support-group-member-po-20261001",
      details: { groupRef: ref, loadId, removedPickupId: obsolete[0].id, vendorPickupId: vendorStop.id,
        allocationIds: allocationBefore.filter(entry => entry.status === "active").map(entry => entry.id), backup } });
    return { mode, rolledBack: mode !== "apply", beforeRevision: before.revision, afterRevision: after.revision,
      beforeHash, backup, group: ref, requiredPickups: [vendor], route: routeSummary(after),
      unrelatedStopsUnchanged: true, allocationsUnchanged: true };
  }, { rollback: mode !== "apply" });
  console.log(JSON.stringify(result));
} finally { await closeDb(); }

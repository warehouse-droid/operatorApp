import assert from "node:assert/strict";
import fs from "node:fs";
import { query, withTransaction, closeDb } from "../../src/db.js";
import { reconcileDispatchPlanLocalCos } from "../../src/dispatch-co-lifecycle.js";
import { materializeDispatchPickupVisits } from "../../src/dispatch-pickup-visits.js";
import { productionFunctions } from "./co-cargo-fixture.mjs";

const [mode, file] = process.argv.slice(2);
const loadId = "T4-L1788581352764-2a46c025e1ae78";
try {
  if (mode === "capture") {
    const state = await withTransaction(async () => {
      await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const plan = (await query(`SELECT p.id,p.plan_date::text AS "planDate",p.revision,s.orders,s.trucks,s.summary
        FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=310`)).rows[0];
      const jobs = (await query("SELECT status FROM driver_job_records WHERE plan_id=310 AND load_id=$1", [loadId])).rows;
      return { plan: await reconcileDispatchPlanLocalCos(plan), jobs };
    }, { rollback: true });
    fs.writeFileSync(file, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ captured: true, revision: state.plan.revision }));
  } else {
    assert.equal(mode, "replay");
    assert.equal(process.env.MBT_TEST_ISOLATED, "1");
    const { plan, jobs } = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(!jobs.some((job) => ["complete", "completed", "in_progress"].includes(job.status)), "Target load must be unexecuted");
    const before = structuredClone(plan);
    const load = plan.trucks.flatMap((truck) => truck.loads).find((entry) => entry.id === loadId);
    const orderById = (id) => plan.orders.find((order) => order.id === id);
    const names = ["dispatchLocationHierarchyRoot", "normalizedPickupLocation", "sameDispatchLocation",
      "uniqueDispatchLocationLabels", "orderRequiresPickupLocation", "pickupStopOrderRefs", "pickupStopIncludesOrder",
      "pickupOrdersForStop", "isMbbsSpecialLinkLine", "isOperationalDispatchItem", "itemHasQuantity", "tooltipItemsForOrder",
      "poRouteProjectionForOrder", "routeItemsForOrder", "positiveBalance", "isOwnYardCode", "directPickupEntriesForLocation",
      "directPickupItemsForLocation", "poPickupEntriesForLocation", "poPickupItemsForLocation", "directPickupAllocatedForItem",
      "itemForPickupLocation", "requiredPickupLocations", "opaqueDispatchStopId", "materializePickupVisitOrderRefs",
      "driverActivityDetails", "dispatchEditableRouteBoundary", "makePickupStop", "enablePickupVisitSchema", "ensurePickupStops", "syncPickupStops"];
    const ui = productionFunctions("../../public/dispatch.js", names, {
      trucks: [{ loads: [load] }], orderById, stopOrder: (stop) => orderById(stop.orderId),
      ownYardForLocation: (location) => ["3445", "2967", "12441", "150"].includes(String(location).split(" : ")[0]),
      stopHasDriverActivity: (_load, stop) => ["in_progress", "complete", "completed"].includes(stop.status),
      loadDriverActivityRecords: () => []
    });
    ui.syncPickupStops();
    assert.deepEqual(materializeDispatchPickupVisits(plan).conflicts, []);
    const originalLoad = before.trucks.flatMap((truck) => truck.loads).find((entry) => entry.id === loadId);
    const existingIds = new Set(originalLoad.stops.map((stop) => stop.id));
    assert.deepEqual(load.stops.filter((stop) => existingIds.has(stop.id)).map((stop) => stop.id), originalLoad.stops.map((stop) => stop.id));
    assert.equal(load.stops.length, originalLoad.stops.length + 1);
    assert.equal(load.stops[0].location, "2967");
    assert.ok(load.stops[0].orderRefs.includes("CO-GOA-7453-7455"));
    assert.ok(load.stops[0].orderRefs.includes("CO-GOA-7941-7987"));
    const repeated = structuredClone(load.stops);
    ui.syncPickupStops();
    assert.deepEqual(load.stops, repeated);
    for (const entry of plan.trucks.flatMap((truck) => truck.loads).filter((candidate) => candidate.id !== loadId)) {
      assert.deepEqual(entry, before.trucks.flatMap((oldTruck) => oldTruck.loads).find((oldLoad) => oldLoad.id === entry.id));
    }
    console.log(JSON.stringify({ currentPlanFrontendReplay: "passed", revision: plan.revision,
      validationConflicts: 0, newPhysicalPickups: 1, existingStopIdsPreserved: existingIds.size, unrelatedLoadsUnchanged: true }));
  }
} finally {
  await closeDb();
}

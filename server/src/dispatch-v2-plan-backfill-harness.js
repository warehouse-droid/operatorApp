import assert from "node:assert/strict";
import { backfillDispatchV2Plans } from "./backfill-dispatch-v2-plans.js";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  convertLegacyDispatchPlanToV2,
  getDispatchPlanSnapshot,
  restoreDispatchPlanSnapshot,
  saveDispatchPlanSnapshot
} from "./dispatch-plan-repository.js";
import { listDispatchPlanLoadAssignments } from "./dispatch-load-assignment-repository.js";

const MIGRATED_AT = "2098-04-05T06:07:08.000Z";
const OWN_YARD_CODES = ["3445", "2967", "12441", "150", "CUSTOM-YARD"];

const orders = [{
  id: "PO-BACKFILL-HARNESS",
  status: "planned",
  items: [{ lineRowId: "501", quantity: 3 }, { lineRowId: "502", quantity: 7 }]
}];

const legacyTrucks = [{
  id: "LEGACY-TRUCK-A",
  plate: "LEGACY-A",
  driverLogin: "legacy-driver",
  driver: "Legacy Driver",
  base: "12441",
  parkingSpot: "A-7",
  status: "ready",
  parentOnlyField: { preserve: true },
  loads: [{
    id: "LEGACY-LATE",
    name: "Late load",
    status: "planned",
    orders: [{ id: "PO-BACKFILL-HARNESS", allocation: "late" }],
    timing: { start: 600, finish: 660, routeMinutes: 42 },
    stops: [{
      id: "DROP-LATE-1",
      type: "drop",
      orderId: "PO-BACKFILL-HARNESS",
      dropoffKey: "location:28",
      dropLocation: "2967",
      lineRowIds: ["501"],
      status: "pending"
    }]
  }, {
    id: "LEGACY-EARLY",
    name: "Early load",
    status: "loaded",
    orders: [{ id: "PO-BACKFILL-HARNESS", allocation: "early" }],
    timing: { start: 480, finish: 540, routeMinutes: 35 },
    stops: [{
      id: "DROP-EARLY-1",
      type: "drop",
      orderId: "PO-BACKFILL-HARNESS",
      dropoffKey: "location:15",
      dropLocation: "12441",
      lineRowIds: ["502"],
      status: "complete"
    }]
  }]
}, {
  id: "LEGACY-TRUCK-B",
  plate: "LEGACY-B",
  driverLogin: "legacy-driver",
  driver: "Legacy Driver",
  base: "3445",
  parkingSpot: "B-2",
  status: "active",
  loads: [{
    id: "LEGACY-MIDDLE",
    name: "Middle load",
    status: "in_progress",
    orders: [],
    timing: { start: 540, finish: 590, routeMinutes: 30 },
    stops: [{ id: "RETURN-MIDDLE", type: "return", location: "3445", status: "pending" }]
  }]
}];

const originalSummary = {
  label: "legacy summary",
  nested: { preserve: true }
};

function loadById(trucks, id) {
  return trucks.flatMap((truck) => truck.loads || []).find((load) => load.id === id);
}

function assertConvertedPlan(plan) {
  const late = loadById(plan.trucks, "LEGACY-LATE");
  const early = loadById(plan.trucks, "LEGACY-EARLY");
  const middle = loadById(plan.trucks, "LEGACY-MIDDLE");
  assert.equal(late.driverLogin, "legacy-driver");
  assert.equal(late.driverName, "Legacy Driver");
  assert.equal(late.truckId, "LEGACY-TRUCK-A");
  assert.equal(late.truckPlate, "LEGACY-A");
  assert.equal(late.switchYard, "12441");
  assert.equal(late.parkingSpot, "A-7");
  assert.equal(early.driverSequence, 0);
  assert.equal(middle.driverSequence, 1);
  assert.equal(late.driverSequence, 2);
  assert.deepEqual(late.timing, legacyTrucks[0].loads[0].timing);
  assert.deepEqual(early.orders, legacyTrucks[0].loads[1].orders);
  assert.deepEqual(early.stops, legacyTrucks[0].loads[1].stops);
  assert.equal(early.status, "loaded");
  assert.equal(plan.trucks[0].status, "ready");
  assert.deepEqual(plan.trucks[0].parentOnlyField, { preserve: true });
}

const pureConversion = convertLegacyDispatchPlanToV2({
  orders,
  trucks: legacyTrucks,
  summary: originalSummary
}, { migratedAt: MIGRATED_AT, ownYardCodes: OWN_YARD_CODES });
assertConvertedPlan(pureConversion);
assert.deepEqual(pureConversion.orders, orders);
assert.deepEqual(pureConversion.summary, {
  ...originalSummary,
  ownYardCodes: OWN_YARD_CODES,
  dispatchPlanFormat: {
    version: 2,
    source: "dockerVer-backfill",
    migratedAt: MIGRATED_AT,
    ownYardCodes: OWN_YARD_CODES
  }
});

const rollback = await beginRollbackContext();

try {
  await rollback.run(async () => {
    const day = String((Date.now() % 26) + 1).padStart(2, "0");
    const planDate = `2198-11-${day}`;
    const inserted = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note, revision)
       VALUES ($1::date, 'confirmed', 'Dispatch V2 backfill harness', 7)
       RETURNING id`,
      [planDate]
    );
    const planId = inserted.rows[0].id;
    await query(
      `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
      [planId, JSON.stringify(orders), JSON.stringify(legacyTrucks), JSON.stringify(originalSummary)]
    );

    const dryRun = await backfillDispatchV2Plans({ planId, migratedAt: MIGRATED_AT, ownYardCodes: OWN_YARD_CODES });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.eligible, 1);
    assert.equal(dryRun.migrated, 0);
    assert.equal(dryRun.plans[0].action, "would_migrate");
    let persisted = (await query(
      `SELECT p.status, p.revision, s.orders, s.trucks, s.summary
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1`,
      [planId]
    )).rows[0];
    assert.equal(persisted.revision, "7");
    assert.equal(persisted.status, "confirmed");
    assert.deepEqual(persisted.orders, orders);
    assert.deepEqual(persisted.trucks, legacyTrucks);
    assert.deepEqual(persisted.summary, originalSummary);
    assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_snapshot_history WHERE plan_id = $1", [planId])).rows[0].count, 0);
    assert.equal((await listDispatchPlanLoadAssignments({ planId })).length, 0);

    const firstApply = await backfillDispatchV2Plans({ apply: true, planId, migratedAt: MIGRATED_AT, ownYardCodes: OWN_YARD_CODES });
    assert.equal(firstApply.migrated, 1);
    assert.equal(firstApply.archived, 1);
    assert.equal(firstApply.assignmentLoadsRebuilt, 3);
    persisted = (await query(
      `SELECT p.status, p.revision, s.orders, s.trucks, s.summary
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE p.id = $1`,
      [planId]
    )).rows[0];
    assert.equal(persisted.revision, "8");
    assert.equal(persisted.status, "confirmed");
    assert.deepEqual(persisted.orders, orders);
    assertConvertedPlan(persisted);
    assert.deepEqual(persisted.summary.ownYardCodes, OWN_YARD_CODES);
    assert.deepEqual(persisted.summary.dispatchPlanFormat, pureConversion.summary.dispatchPlanFormat);

    const historyResult = await query(
      `SELECT id, orders, trucks, summary, archive_reason
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND archive_reason = 'before_driver_oriented_planning'`,
      [planId]
    );
    assert.equal(historyResult.rowCount, 1);
    const legacyArchive = historyResult.rows[0];
    assert.deepEqual(legacyArchive.orders, orders);
    assert.deepEqual(legacyArchive.trucks, legacyTrucks);
    assert.deepEqual(legacyArchive.summary, originalSummary);

    const assignmentsAfterBackfill = await listDispatchPlanLoadAssignments({ planId });
    assert.equal(assignmentsAfterBackfill.length, 3);
    assert.deepEqual(
      Object.fromEntries(assignmentsAfterBackfill.map((row) => [row.load_id, row.driver_sequence])),
      { "LEGACY-EARLY": 0, "LEGACY-MIDDLE": 1, "LEGACY-LATE": 2 }
    );
    assert(assignmentsAfterBackfill.every((row) => row.driver_login === "legacy-driver"));

    const normalSave = await saveDispatchPlanSnapshot(planId, {
      orders: persisted.orders,
      trucks: persisted.trucks,
      summary: { ...originalSummary, ownYardCodes: OWN_YARD_CODES },
      planDate,
      baseRevision: 8,
      sessionId: "dispatch-v2-normal-save"
    });
    assert.equal(normalSave.revision, 9);
    assert.equal(normalSave.summary.dispatchPlanFormat.source, "dockerVer-backfill");
    assert.equal(normalSave.summary.dispatchPlanFormat.migratedAt, MIGRATED_AT);
    assert.deepEqual(normalSave.summary.ownYardCodes, OWN_YARD_CODES);
    const assignmentsBeforeSecondApply = await listDispatchPlanLoadAssignments({ planId });

    const secondApply = await backfillDispatchV2Plans({ apply: true, planId, ownYardCodes: OWN_YARD_CODES });
    assert.equal(secondApply.migrated, 0);
    assert.equal(secondApply.archived, 0);
    assert.equal(secondApply.skipped, 1);
    assert.equal(secondApply.assignmentLoadsRebuilt, 0);
    const afterSecondApply = await query("SELECT revision FROM dispatch_plans WHERE id = $1", [planId]);
    assert.equal(afterSecondApply.rows[0].revision, "9");
    const assignmentsAfterSecondApply = await listDispatchPlanLoadAssignments({ planId });
    assert.deepEqual(
      assignmentsAfterSecondApply.map((row) => ({ id: row.id, updatedAt: row.updated_at })),
      assignmentsBeforeSecondApply.map((row) => ({ id: row.id, updatedAt: row.updated_at }))
    );
    assert.equal((await query(
      `SELECT count(*)::int AS count
         FROM dispatch_plan_snapshot_history
        WHERE plan_id = $1
          AND archive_reason = 'before_driver_oriented_planning'`,
      [planId]
    )).rows[0].count, 1);

    const archiveView = await getDispatchPlanSnapshot(legacyArchive.id);
    const viewedLate = loadById(archiveView.rawTrucks, "LEGACY-LATE");
    assert.equal(viewedLate.driverLogin, "legacy-driver");
    assert.equal(viewedLate.truckPlate, "LEGACY-A");
    assert.equal(viewedLate.switchYard, "12441");
    assert.deepEqual(archiveView.summary, originalSummary);
    const archiveAfterView = (await query(
      "SELECT orders, trucks, summary FROM dispatch_plan_snapshot_history WHERE id = $1",
      [legacyArchive.id]
    )).rows[0];
    assert.deepEqual(archiveAfterView, {
      orders,
      trucks: legacyTrucks,
      summary: originalSummary
    });

    const restored = await restoreDispatchPlanSnapshot(legacyArchive.id, { sessionId: "dispatch-v2-backfill-harness" });
    assertConvertedPlan(restored.plan);
    assert.equal(restored.plan.summary.dispatchPlanFormat.version, 2);
    assert.equal(restored.plan.summary.dispatchPlanFormat.source, "dockerVer-backfill");
    assert.deepEqual(restored.plan.summary.ownYardCodes, OWN_YARD_CODES);
    const archiveAfterRestore = (await query(
      "SELECT orders, trucks, summary FROM dispatch_plan_snapshot_history WHERE id = $1",
      [legacyArchive.id]
    )).rows[0];
    assert.deepEqual(archiveAfterRestore, archiveAfterView);
  });
  console.log(JSON.stringify({ ok: true, tests: 42 }));
} finally {
  await rollback.rollback();
  await closeDb();
}

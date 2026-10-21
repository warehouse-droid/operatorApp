import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { runMbtBinPlanningCommand } from "../../../src/mbt/bin-planning-service.js";
import { planningFixture, boundary, command, run, storedPlan } from "../support/bin-planning-fixtures.js";
after(closeDb);

function loadIntent(f, visits = [], overrides = {}) {
  return { id: f.binLoadIds[0], truckId: f.binTruckId, driverId: f.driverId,
    name: "Load 1", startMode: "fixed", start: "07:00", driverSequence: 0,
    plannedStartMinute: 420, plannedFinishMinute: visits.length ? 480 : null,
    visits, ...overrides };
}
async function visitIntent(f) {
  const input = await command(f, "assign");
  return { visitId: f.frontVisitId, expectedVisitRevision: input.expectedVisitRevision,
    assetAssignments: input.assetAssignments, stopOverrides: [{ sequence: 2, minutes: 25 }] };
}

test("board saves empty drafts, computed times and overrides atomically, preserving ordinary Dispatch", async () => {
  const f = await planningFixture(2110); const before = await storedPlan(f.planId);
  await run(f, "save_board", { loads: [loadIntent(f)] });
  let plan = await storedPlan(f.planId);
  assert.equal(plan.trucks[0].loads[0].plannedFinishMinute, null);
  const input = await command(f, "save_board", { loads: [loadIntent(f, [await visitIntent(f)])] });
  const saved = await runMbtBinPlanningCommand(input, boundary);
  const replay = await runMbtBinPlanningCommand(input, boundary);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.body, saved.body);
  plan = await storedPlan(f.planId);
  assert.deepEqual(plan.trucks[1], before.trucks[1]);
  assert.equal(plan.trucks[0].loads[0].stops[1].stopTimeOverrideMinutes, 25);
  assert.equal(plan.trucks[0].loads[0].start, "07:00");
  await run(f, "confirm");
  const released = await query("SELECT generation,released_at,withdrawn_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 ORDER BY generation", [f.frontVisitId]);
  await run(f, "save_board", { loads: [loadIntent(f, [await visitIntent(f)])] });
  assert.deepEqual((await query("SELECT generation,released_at,withdrawn_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 ORDER BY generation", [f.frontVisitId])).rows, released.rows);
  const moved = loadIntent(f, [await visitIntent(f)], { id: "BIN-draft-afternoon", start: "14:00", plannedStartMinute: 840, plannedFinishMinute: 900 });
  await run(f, "save_board", { loads: [loadIntent(f), moved] });
  const generations = (await query("SELECT generation,released_at,withdrawn_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1 ORDER BY generation", [f.frontVisitId])).rows;
  assert.equal(generations.length, 2); assert.ok(generations[0].withdrawn_at);
  assert.equal(generations[1].released_at, null);
});

test("board rejects duplicates, ordinary load IDs, stale visits and overlap without partial writes", async () => {
  const f = await planningFixture(2111);
  const setup = await storedPlan(f.planId);
  Object.assign(setup.trucks[1].loads[0], { returnOnly: true, plannedStartMinute: 900, plannedFinishMinute: 960 });
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(setup.trucks)]);
  const before = await storedPlan(f.planId);
  const visit = await visitIntent(f);
  for (const loads of [
    [loadIntent(f, [visit, visit])],
    [loadIntent(f, [visit], { id: before.trucks[1].loads[0].id })],
    [loadIntent(f, [{ ...visit, expectedVisitRevision: 9999 }])],
    [loadIntent(f, [visit], { plannedStartMinute: 600, plannedFinishMinute: 1440 })]
  ]) {
    await assert.rejects(() => run(f, "save_board", { loads }), e => [400, 409].includes(e.status));
    assert.deepEqual(await storedPlan(f.planId), before);
    assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId])).rows[0].n, 0);
  }
});

test("shared route timing, handoff metadata and driver lane order survive save and confirmation", async () => {
  const f = await planningFixture(2112); const before = await storedPlan(f.planId);
  const stopTimings = [{ sequence: 1, arrival: 420, depart: 435 }, { sequence: 2, arrival: 455, depart: 480 }];
  const routeEstimate = { source: "google", routeSignature: "test-route", routeEstimateId: "route-1",
    rawDriveMinutes: 20, driveMinutes: 20, stayMinutes: 0, totalMinutes: 20, legMinutes: [20], rawLegMinutes: [20],
    allowTolls: false, travelTimePercent: 0, routePath: [{ lat: 43.7, lng: -79.4 }, { lat: 43.8, lng: -79.5 }],
    stopCoordinates: [{ lat: 43.7, lng: -79.4 }, { lat: 43.8, lng: -79.5 }] };
  const visit = { ...await visitIntent(f), stopTimings };
  const load = loadIntent(f, [visit], { routeEstimate, handoffTravelMinutes: 10, handoffTravelFrom: "3445", handoffTravelTo: "12441" });
  await run(f, "save_board", { loads: [load], driverLaneOrder: [f.driverLogin, "unassigned"] });
  let plan = await storedPlan(f.planId);
  assert.deepEqual(plan.summary, { ...before.summary, driverLaneOrder: [f.driverLogin, "unassigned"] });
  const saved = plan.trucks[0].loads[0];
  assert.deepEqual(saved.routeEstimate, routeEstimate);
  assert.equal(saved.handoffTravelMinutes, 10);
  assert.equal(saved.handoffTravelFrom, "3445"); assert.equal(saved.handoffTravelTo, "12441");
  assert.deepEqual(saved.stops.map(s => s.timing), stopTimings.map(({ arrival, depart }) => ({ arrival, depart })));
  assert.deepEqual(plan.trucks[1], before.trucks[1]);
  await run(f, "confirm");
  const confirmedOrdinary = (await storedPlan(f.planId)).trucks[1];
  const history = (await query("SELECT generation,released_at,withdrawn_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId])).rows;
  await run(f, "save_board", { loads: [{ ...load, visits: [{ ...await visitIntent(f), stopTimings }] }], driverLaneOrder: ["unassigned", f.driverLogin] });
  plan = await storedPlan(f.planId);
  assert.deepEqual(plan.summary.driverLaneOrder, ["unassigned", f.driverLogin]);
  assert.deepEqual((await query("SELECT generation,released_at,withdrawn_at FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId])).rows, history);
  assert.deepEqual(plan.trucks[1], confirmedOrdinary);
});

test("invalid required steps, out-of-load timing and expired leases roll back all board changes", async () => {
  const f = await planningFixture(2113); const before = await storedPlan(f.planId);
  const visit = await visitIntent(f);
  for (const change of [{ stopOverrides: [{ sequence: 99, minutes: 10 }] }, { stopTimings: [{ sequence: 99, arrival: 420, depart: 450 }] },
    { stopTimings: [{ sequence: 1, arrival: 410, depart: 450 }] }, { stopTimings: [{ sequence: 1, arrival: 470, depart: 490 }] }]) {
    await assert.rejects(() => run(f, "save_board", { loads: [loadIntent(f, [{ ...visit, ...change }])] }), e => e.status === 409 && e.code === "MBT_BIN_BOARD_INVALID");
    assert.deepEqual(await storedPlan(f.planId), before);
  }
  const input = await command(f, "save_board", { loads: [loadIntent(f, [visit])], driverLaneOrder: [f.driverLogin] });
  let emitted = 0;
  await assert.rejects(() => runMbtBinPlanningCommand(input, { ...boundary, onCommitted: () => { emitted++; }, hooks: { beforeCommit: () => query(
    "UPDATE dispatch_plan_edit_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE plan_date=$1", [f.planDate]) } }), e => e.status === 409);
  assert.deepEqual(await storedPlan(f.planId), before); assert.equal(emitted, 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId])).rows[0].n, 0);
});

test("concurrent board saves serialize and never duplicate a visit generation", async () => {
  const f = await planningFixture(2114);
  const input = await command(f, "save_board", { loads: [loadIntent(f, [await visitIntent(f)])] });
  const results = await Promise.allSettled([runMbtBinPlanningCommand(input, boundary), runMbtBinPlanningCommand({ ...input, idempotencyKey: `${input.idempotencyKey}-second` }, boundary)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  assert.equal((await query("SELECT count(*)::int AS n FROM mbt_bin_planning_assignments WHERE service_visit_id=$1", [f.frontVisitId])).rows[0].n, 1);
});

test("empty BIN drafts reject starts outside the plan day without changing the schedule", async () => {
  const f = await planningFixture(2115); const before = await storedPlan(f.planId);
  for (const plannedStartMinute of [-1, 1440, 420.5, null, "07:00"]) {
    await assert.rejects(() => run(f, "save_board", { loads: [loadIntent(f, [], { plannedStartMinute })] }),
      e => e.status === 400 && e.code === "MBT_BIN_LOAD_TIME_REQUIRED");
    assert.deepEqual(await storedPlan(f.planId), before);
  }
});

test("legacy Dispatch truck aliases resolve to the BIN fleet without duplicate trucks", async () => {
  const f = await planningFixture(2116); const before = await storedPlan(f.planId);
  before.trucks[0].id = 'T1';
  for (const load of before.trucks[0].loads) load.truckId = 'T1';
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(before.trucks)]);
  await run(f, "save_board", { loads: [loadIntent(f, [await visitIntent(f)])] });
  const plan = await storedPlan(f.planId);
  assert.equal(plan.trucks.length, 2);
  assert.equal(plan.trucks[0].id, f.binTruckId);
  assert.equal(plan.trucks[0].loads[0].stops.length, 2);
  assert.deepEqual(plan.trucks[1], before.trucks[1]);
  await run(f, "confirm");
});

test("resolving a legacy truck cannot relocate ordinary work on that truck", async () => {
  const f = await planningFixture(2117); const before = await storedPlan(f.planId);
  before.trucks[0].id = 'T1';
  before.trucks[0].loads[2].stops = [{ id: 'ordinary', type: 'drop', orderId: 'SO-context' }];
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2::jsonb WHERE plan_id=$1", [f.planId, JSON.stringify(before.trucks)]);
  const original = await storedPlan(f.planId);
  await assert.rejects(() => run(f, "save_board", { loads: [loadIntent(f)] }), e => e.code === 'MBT_BIN_LOAD_REQUIRED');
  assert.deepEqual(await storedPlan(f.planId), original);
});

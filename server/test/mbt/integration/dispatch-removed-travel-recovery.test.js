import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getDriverDayJobs, getDriverDayState, getDriverNextJobContext, startDriverJob } from "../../../src/driver-repository.js";
import { persistDriverOfflineDayPlan, registerDriverOfflineEvents } from "../../../src/driver-offline-repository.js";
import { processDriverOfflineQueue } from "../../../src/driver-offline-service.js";

after(closeDb);

async function seedTravel({ status = "in_progress", target = "3445", stopType = "travel", planDate = "1898-09-11" } = {}) {
  const suffix = crypto.randomUUID();
  const login = `removed-travel-${suffix}`;
  const { rows: [plan] } = await query(
    "INSERT INTO dispatch_plans (plan_date, status, revision) VALUES ($1, 'confirmed', 1) RETURNING id",
    [planDate]
  );
  const orders = [{ id: `SO-${suffix}`, type: "SO", sourceYard: "150", pickupLocations: ["150"], address: "Customer road" }];
  const trucks = [{ id: `T-${suffix}`, plate: "RECOVER", base: "3445", driverLogin: login, driver: login, loads: [{
    id: `L-${suffix}`, name: "Unstarted pickup", driverLogin: login,
    stops: [{ id: `P-${suffix}`, type: "pick", orderId: orders[0].id, location: "150" }]
  }] }];
  await query("INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary) VALUES ($1, $2, $3, '{}')", [plan.id, JSON.stringify(orders), JSON.stringify(trucks)]);
  const route = await getDriverDayJobs(login, { date: planDate });
  const job = route.jobs.find((candidate) => candidate.stopType === "travel");
  assert.ok(job);
  const { rows: [record] } = await query(
    `INSERT INTO driver_job_records (job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
      load_id, load_name, stop_id, stop_type, order_refs, status, started_at, completed_at, job_details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]', $11,
       '2026-09-11T17:47:36.409Z', $12, $13) RETURNING *`,
    [job.jobId, plan.id, planDate, login, job.truckId, job.truckPlate, job.loadId, job.loadName, job.stopId, stopType,
      status, status === "complete" ? "2026-09-11T18:00:00Z" : null, JSON.stringify(job)]
  );
  trucks[0].loads[0].stops[0].location = target;
  orders[0].sourceYard = target;
  orders[0].pickupLocations = [target];
  await query("UPDATE dispatch_plan_snapshots SET trucks=$2, orders=$3 WHERE plan_id=$1", [plan.id, JSON.stringify(trucks), JSON.stringify(orders)]);
  return { plan, planDate, login, job, record, trucks };
}

for (const [entry, refresh] of [["next job", getDriverNextJobContext], ["day plan", getDriverDayJobs], ["day state", getDriverDayState]]) {
  for (const target of ["3445", "2967"]) {
    test(`${entry}: removed travel closes automatically and ${target === "3445" ? "pickup" : "replacement travel"} remains pending`, async () => {
      await withTransaction(async () => {
        const { plan, planDate, login, job, record } = await seedTravel({ target });
        await refresh(login, { date: planDate });
        const next = await getDriverNextJobContext(login, { date: planDate });
        assert.notEqual(next.job.jobId, job.jobId);
        assert.equal(next.job.stopType, target === "3445" ? "pickup" : "travel");
        assert.equal(next.job.status, "pending", "replacement work must require a fresh driver start");
        assert.equal(next.jobs.some((item) => item.jobId === job.jobId), false);
        const { rows: [updated] } = await query("SELECT * FROM driver_job_records WHERE id=$1", [record.id]);
        assert.equal(updated.status, "superseded");
        assert.deepEqual(updated.started_at, record.started_at);
        assert.deepEqual(updated.completed_at, record.completed_at);
        assert.equal(updated.job_details.toLocation, "150");
        assert.ok(updated.job_details.travelSupersededAt);
        const { rows: audits } = await query("SELECT before_state,after_state FROM dispatch_audit_log WHERE action='driver_travel_superseded' AND entity_id=$1", [job.jobId]);
        assert.equal(audits.length, 1, "repeated refresh must create only one audit");
        assert.equal(audits[0].before_state.status, "in_progress");
        assert.equal(audits[0].after_state.status, "superseded");
        const { rows: [currentPlan] } = await query("SELECT revision FROM dispatch_plans WHERE id=$1", [plan.id]);
        assert.equal(String(currentPlan.revision), "1", "closure must not rewrite the confirmed plan");
        const { rows: createdJobs } = await query("SELECT job_id FROM driver_job_records WHERE plan_id=$1", [plan.id]);
        assert.equal(createdJobs.length, 1, "automatic closure must never auto-start the replacement");
      }, { rollback: true });
    });
  }
}

test("current active travel and completed history are retained", async () => {
  for (const scenario of [{ target: "150", status: "in_progress" }, { target: "2967", status: "complete" }]) {
    await withTransaction(async () => {
      const { planDate, login, record } = await seedTravel(scenario);
      await getDriverNextJobContext(login, { date: planDate });
      const { rows: [updated] } = await query("SELECT * FROM driver_job_records WHERE id=$1", [record.id]);
      assert.deepEqual(updated, record);
    }, { rollback: true });
  }
});

test("a missing physical pickup retains the real route-conflict block", async () => {
  await withTransaction(async () => {
    const { planDate, login, record } = await seedTravel({ stopType: "pickup" });
    await assert.rejects(getDriverNextJobContext(login, { date: planDate }), (error) => error.code === "DRIVER_ACTIVE_ROUTE_CONFLICT");
    const { rows: [updated] } = await query("SELECT * FROM driver_job_records WHERE id=$1", [record.id]);
    assert.deepEqual(updated, record);
  }, { rollback: true });
});

test("a removed travel leg added back later needs a fresh start and timestamp", async () => {
  await withTransaction(async () => {
    const { plan, planDate, login, job, record, trucks } = await seedTravel({ target: "2967" });
    await getDriverNextJobContext(login, { date: planDate });
    trucks[0].loads[0].stops[0].location = "150";
    await query("UPDATE dispatch_plan_snapshots SET trucks=$2 WHERE plan_id=$1", [plan.id, JSON.stringify(trucks)]);
    const current = await getDriverNextJobContext(login, { date: planDate });
    assert.equal(current.job.jobId, job.jobId);
    assert.equal(current.job.status, "pending");
    assert.equal(current.job.startedAt, null);
    const startedAt = "2026-09-11T19:00:00.000Z";
    const started = await startDriverJob(login, current.job.jobId, { job: current.job, occurredAt: startedAt });
    assert.equal(started.status, "in_progress");
    assert.equal(started.started_at.toISOString(), startedAt);
    assert.notDeepEqual(started.started_at, record.started_at);
  }, { rollback: true });
});

test("concurrent PWA refreshes close the removed leg once", async () => {
  const fixture = await seedTravel({ target: "2967" });
  try {
    const routes = await Promise.all([
      getDriverNextJobContext(fixture.login, { date: fixture.planDate }),
      getDriverNextJobContext(fixture.login, { date: fixture.planDate })
    ]);
    for (const route of routes) {
      assert.equal(route.job.status, "pending");
      assert.notEqual(route.job.jobId, fixture.job.jobId);
    }
    const { rows } = await query("SELECT id FROM dispatch_audit_log WHERE action='driver_travel_superseded' AND entity_id=$1", [fixture.job.jobId]);
    assert.equal(rows.length, 1);
  } finally {
    await query("DELETE FROM dispatch_audit_log WHERE plan_id=$1", [fixture.plan.id]);
    await query("DELETE FROM driver_job_records WHERE plan_id=$1", [fixture.plan.id]);
    await query("DELETE FROM dispatch_plans WHERE id=$1", [fixture.plan.id]);
  }
});

test("late offline travel events drain as evidence and cannot restart the closed leg", async () => {
  await withTransaction(async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const { plan, planDate, login, job, record } = await seedTravel({ target: "2967", planDate: today });
    const deviceId = `removed-travel-device-${crypto.randomUUID()}`;
    const manifestId = crypto.randomUUID();
    const manifest = await persistDriverOfflineDayPlan({
      manifestId, driverLogin: login, deviceId,
      planMetadata: { planId: Number(plan.id), planDate, planRevision: 1 },
      jobs: [job], driverProfile: { login, name: "Removed travel test" },
      dayState: { planDate, truckPlate: job.truckPlate, preDvirStatus: "complete" }
    });
    await getDriverNextJobContext(login, { date: planDate });
    const eventId = crypto.randomUUID();
    const [registered] = await registerDriverOfflineEvents({
      driverLogin: login, deviceId, manifestId,
      events: [{ eventId, clientSequence: 1, eventType: "job_started", jobId: job.jobId,
        jobFingerprint: manifest.jobs[0].fingerprint,
        predecessorFingerprint: manifest.jobs[0].predecessorFingerprint,
        occurredAt: new Date().toISOString(), locationStatus: "not_checked_offline", details: {}, photos: [] }]
    });
    assert.notEqual(registered.status, "evidence_only", "the event must exercise queue recovery");
    await processDriverOfflineQueue({ driverLogin: login, planDate, deviceId, applyEvent: async () => assert.fail("removed travel must never execute again") });
    const { rows: [event] } = await query("SELECT status FROM driver_offline_events WHERE event_id=$1", [eventId]);
    assert.equal(event.status, "evidence_only");
    const { rows: [unchanged] } = await query("SELECT status FROM driver_job_records WHERE id=$1", [record.id]);
    assert.equal(unchanged.status, "superseded");
  }, { rollback: true });
});

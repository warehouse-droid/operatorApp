import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getDriverDayJobs } from "../../../src/driver-repository.js";
import { listDriverPwaStops, reopenDriverPwaStop } from "../../../src/driver-pwa-repository.js";

after(closeDb);

for (const status of ["in_progress", "complete"]) {
  test(`${status} travel is listed, reopened with retained evidence and idempotent`, async () => {
    await withTransaction(async () => {
      const suffix = crypto.randomUUID();
      const planDate = "1899-09-11";
      const login = `travel-hotfix-${suffix}`;
      const { rows: [plan] } = await query(
        "INSERT INTO dispatch_plans (plan_date, status, revision) VALUES ($1, 'confirmed', 1) RETURNING id",
        [planDate]
      );
      const orders = [{ id: `SO-${suffix}`, type: "SO", sourceYard: "2967", pickupLocations: ["2967"], address: "Customer road" }];
      const trucks = [{ id: `T-${suffix}`, plate: "HOTFIX", base: "3445", driverLogin: login, driver: login, loads: [{
        id: `L-${suffix}`, name: "Pickup not started", driverLogin: login,
        stops: [{ id: `P-${suffix}`, type: "pick", orderId: orders[0].id, location: "2967" }]
      }] }];
      await query("INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary) VALUES ($1, $2, $3, '{}')", [plan.id, JSON.stringify(orders), JSON.stringify(trucks)]);
      const route = await getDriverDayJobs(login, { date: planDate });
      const job = route.jobs.find((candidate) => candidate.stopType === "travel");
      assert.ok(job, "the real Driver route must contain travel before the untouched pickup");
      const { rows: [record] } = await query(
        `INSERT INTO driver_job_records (job_id, plan_id, plan_date, driver_login, truck_id, truck_plate,
          load_id, load_name, stop_id, stop_type, order_refs, status, started_at, completed_at, job_details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'travel', '[]', $10,
           '2026-09-11T16:18:16.835Z', $11, $12) RETURNING *`,
        [job.jobId, plan.id, planDate, login, job.truckId, job.truckPlate, job.loadId, job.loadName, job.stopId,
          status, status === "complete" ? "2026-09-11T16:30:00Z" : null, JSON.stringify(job)]
      );
      const listing = await listDriverPwaStops({ planDate, driverLogin: login });
      const listed = listing.stops.find((stop) => String(stop.recordId) === String(record.id));
      assert.ok(listed, "recorded travel must appear in Dispatch's reopen screen");
      assert.equal(listed.canReopen, true);
      const request = { recordId: listed.recordId, expectedStateHash: listed.stateHash, idempotencyId: crypto.randomUUID(), auditNote: "Correct the travel before pickup", reopenedBy: "Hotfix test" };
      await assert.rejects(reopenDriverPwaStop({ ...request, expectedStateHash: "0".repeat(64) }), (error) => error.status === 409);
      const result = await reopenDriverPwaStop(request);
      assert.equal(result.status, "pending");
      assert.deepEqual(await reopenDriverPwaStop(request), { ...result, exactRetry: true });
      const { rows: [updated] } = await query("SELECT * FROM driver_job_records WHERE id=$1", [record.id]);
      assert.equal(updated.status, "pending");
      assert.equal(updated.started_at, null);
      assert.equal(updated.job_details.requiredPhotos, 0);
      assert.equal(updated.job_details.remainingRequiredPhotos, 0);
      const { rows: corrections } = await query("SELECT before_state FROM driver_job_corrections WHERE driver_job_record_id=$1", [record.id]);
      assert.equal(corrections.length, 1);
      assert.equal(corrections[0].before_state.status, status);
      assert.equal(corrections[0].before_state.startedAt, record.started_at.toISOString());
      const { rows: audits } = await query("SELECT id FROM dispatch_audit_log WHERE action='driver_pwa_stop_reopened' AND entity_id=$1", [job.jobId]);
      assert.equal(audits.length, 1);
    }, { rollback: true });
  });
}

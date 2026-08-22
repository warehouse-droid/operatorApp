// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  actualArrivalStateHash,
  applyActualArrivalRun,
  createHistoricalActualArrivalRun,
  getActualArrivalRun,
  listActualArrivalRouteRecords,
  replaceActualArrivalRunResults
} from "../../../src/dispatch-actual-arrival-repository.js";
import { listDriverJobStatuses } from "../../../src/driver-repository.js";
import { actualArrivalWorkerTick } from "../../../src/dispatch-actual-arrival-service.js";

let rollbackContext;

before(async () => {
  rollbackContext = await beginRollbackContext();
});

after(async () => {
  await rollbackContext?.rollback();
  await closeDb();
});

function runInRollback(callback) {
  return rollbackContext.run(callback);
}

test("completion queues one run per physical visit and apply preserves PWA evidence", async () => {
  await runInRollback(async () => {
    const suffix = crypto.randomUUID();
    const driverLogin = `arrival-${suffix}`;
    const firstJob = `first-${suffix}`;
    const groupedLead = `group-a-${suffix}`;
    const groupedSibling = `group-b-${suffix}`;
    const planDate = "2026-08-17";
    const rows = [{
      jobId: firstJob,
      stopId: "STOP-1",
      orderRefs: ["SO-FIRST"],
      startedAt: "2026-08-17T12:00:00.000Z",
      completedAt: "2026-08-17T12:18:00.000Z",
      physicalVisitJobIds: [firstJob]
    }, {
      jobId: groupedLead,
      stopId: "STOP-2A",
      orderRefs: ["SO-GROUP-A"],
      startedAt: "2026-08-17T12:18:00.000Z",
      completedAt: "2026-08-17T14:19:00.000Z",
      physicalVisitJobIds: [groupedLead, groupedSibling]
    }, {
      jobId: groupedSibling,
      stopId: "STOP-2B",
      orderRefs: ["SO-GROUP-B"],
      startedAt: "2026-08-17T12:18:00.000Z",
      completedAt: "2026-08-17T14:19:00.000Z",
      physicalVisitJobIds: [groupedLead, groupedSibling]
    }];

    for (const row of rows) {
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, truck_plate, load_id, load_name,
           stop_id, stop_type, order_refs, photo_data_urls, status,
           started_at, completed_at, job_details
         ) VALUES (
           $1, $2::date, $3, 'CE94489', 'LOAD-1', 'Load 1',
           $4, 'dropoff', $5::jsonb, '[]'::jsonb, 'complete',
           $6::timestamptz, $7::timestamptz, $8::jsonb
         )`,
        [
          row.jobId,
          planDate,
          driverLogin,
          row.stopId,
          JSON.stringify(row.orderRefs),
          row.startedAt,
          row.completedAt,
          JSON.stringify({
            address: "100 Test Destination Road, Toronto, ON",
            dropAddress: "100 Test Destination Road, Toronto, ON",
            physicalVisitJobIds: row.physicalVisitJobIds
          })
        ]
      );
    }

    const automaticRuns = await query(
      `SELECT trigger_job_record_id
         FROM dispatch_actual_arrival_runs
        WHERE run_mode = 'automatic'
          AND driver_login = $1
        ORDER BY trigger_job_record_id`,
      [driverLogin]
    );
    assert.equal(automaticRuns.rowCount, 2, "The grouped sibling must not queue duplicate Samsara work.");

    await query(
      `UPDATE driver_job_records
          SET status = 'complete'
        WHERE job_id = $1`,
      [groupedLead]
    );
    const idempotentCount = await query(
      `SELECT COUNT(*)::int AS count
         FROM dispatch_actual_arrival_runs
        WHERE run_mode = 'automatic'
          AND driver_login = $1`,
      [driverLogin]
    );
    assert.equal(idempotentCount.rows[0]?.count, 2, "Idempotent completion updates must not queue another run.");

    const gatedOff = await actualArrivalWorkerTick({
      workerId: `gate-test:${suffix}`,
      isGateEnabled: async () => false
    });
    assert.equal(gatedOff.claimed, true);
    assert.equal(gatedOff.run?.status, "suppressed_gate_off", "The off gate must suppress work before any external lookup.");

    const rawBefore = await query(
      `SELECT job_id, started_at::text, completed_at::text, photo_data_urls, job_details
         FROM driver_job_records
        WHERE driver_login = $1
        ORDER BY job_id`,
      [driverLogin]
    );
    const preview = await createHistoricalActualArrivalRun({
      planDate,
      driverLogin,
      requestedBy: "operator:arrival-test"
    });
    await query(
      `UPDATE dispatch_actual_arrival_runs
          SET status = 'running', attempt_count = 1
        WHERE run_id = $1::uuid`,
      [preview.runId]
    );
    const routeRecords = await listActualArrivalRouteRecords({ planDate, driverLogin });
    const firstRecord = routeRecords.find((record) => record.job_id === firstJob);
    const groupedRecords = routeRecords.filter((record) => [groupedLead, groupedSibling].includes(record.job_id));
    assert.ok(firstRecord);
    assert.equal(groupedRecords.length, 2);

    const retained = await replaceActualArrivalRunResults(preview.runId, [{
      visitKey: `first:${suffix}`,
      sequence: 0,
      planId: null,
      loadId: "LOAD-1",
      loadName: "Load 1",
      stopIds: ["STOP-1"],
      orderRefs: ["SO-FIRST"],
      driverJobRecordIds: [Number(firstRecord.id)],
      truckPlate: "CE94489",
      destinationAddress: "100 Test Destination Road, Toronto, ON",
      destinationLatitude: 43.8,
      destinationLongitude: -79.3,
      previousCompletedAt: null,
      pwaStartedAt: firstRecord.started_at,
      completedAt: firstRecord.completed_at,
      existingArrivalAt: null,
      proposedArrivalAt: null,
      resolutionStatus: "first_stop",
      source: "pwa_started_at",
      confidence: "explicit",
      stateHash: actualArrivalStateHash([firstRecord]),
      evidence: { reason: "first_physical_stop_of_driver_day" },
      error: ""
    }, {
      visitKey: `group:${suffix}`,
      sequence: 1,
      planId: null,
      loadId: "LOAD-1",
      loadName: "Load 1",
      stopIds: ["STOP-2A", "STOP-2B"],
      orderRefs: ["SO-GROUP-A", "SO-GROUP-B"],
      driverJobRecordIds: groupedRecords.map((record) => Number(record.id)),
      truckPlate: "CE94489",
      destinationAddress: "100 Test Destination Road, Toronto, ON",
      destinationLatitude: 43.8,
      destinationLongitude: -79.3,
      previousCompletedAt: firstRecord.completed_at,
      pwaStartedAt: groupedRecords[0].started_at,
      completedAt: groupedRecords[0].completed_at,
      existingArrivalAt: null,
      proposedArrivalAt: "2026-08-17T13:54:00.000Z",
      resolutionStatus: "resolved",
      source: "samsara_gps_history",
      confidence: "high",
      stateHash: actualArrivalStateHash(groupedRecords),
      evidence: { pointCount: 72, calculationMs: 0.4 },
      error: ""
    }], { status: "preview_ready" });

    const applied = await applyActualArrivalRun(preview.runId, {
      expectedResultVersion: retained.resultVersion,
      appliedBy: "operator:arrival-test"
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.resolvedStops, 1);
    assert.equal(applied.skippedStops, 1);

    const rawAfter = await query(
      `SELECT job_id, started_at::text, completed_at::text, photo_data_urls, job_details
         FROM driver_job_records
        WHERE driver_login = $1
        ORDER BY job_id`,
      [driverLogin]
    );
    assert.deepEqual(rawAfter.rows, rawBefore.rows, "Apply must not mutate Driver start, completion, photo, or job evidence.");

    const canonical = await query(
      `SELECT record.job_id, arrival.actual_arrival_at::text, arrival.source, arrival.confidence
         FROM dispatch_actual_stop_arrivals arrival
         JOIN driver_job_records record ON record.id = arrival.driver_job_record_id
        WHERE record.driver_login = $1
        ORDER BY record.job_id`,
      [driverLogin]
    );
    assert.equal(canonical.rowCount, 2, "Every logical member of one physical visit must share the canonical arrival.");
    assert.ok(canonical.rows.every((row) => new Date(row.actual_arrival_at).toISOString() === "2026-08-17T13:54:00.000Z"));
    assert.ok(canonical.rows.every((row) => row.source === "samsara_gps_history" && row.confidence === "high"));

    const statuses = await listDriverJobStatuses({ planDate });
    const groupedStatuses = statuses.filter((record) => [groupedLead, groupedSibling].includes(record.job_id));
    assert.equal(groupedStatuses.length, 2);
    assert.ok(groupedStatuses.every((record) => new Date(record.actual_arrival_at).toISOString() === "2026-08-17T13:54:00.000Z"));

    const savedRun = await getActualArrivalRun(preview.runId);
    assert.equal(savedRun?.results.length, 2);
    assert.equal(savedRun?.results[1]?.evidence.pointCount, 72);

    const stalePreview = await createHistoricalActualArrivalRun({
      planDate,
      driverLogin,
      requestedBy: "operator:arrival-stale-test"
    });
    await query(
      `UPDATE dispatch_actual_arrival_runs
          SET status = 'running', attempt_count = 1
        WHERE run_id = $1::uuid`,
      [stalePreview.runId]
    );
    const currentRoute = await listActualArrivalRouteRecords({ planDate, driverLogin });
    const currentGroup = currentRoute.filter((record) => [groupedLead, groupedSibling].includes(record.job_id));
    const staleRetained = await replaceActualArrivalRunResults(stalePreview.runId, [{
      visitKey: `group:${suffix}`,
      sequence: 1,
      planId: null,
      loadId: "LOAD-1",
      loadName: "Load 1",
      stopIds: ["STOP-2A", "STOP-2B"],
      orderRefs: ["SO-GROUP-A", "SO-GROUP-B"],
      driverJobRecordIds: currentGroup.map((record) => Number(record.id)),
      truckPlate: "CE94489",
      destinationAddress: "100 Test Destination Road, Toronto, ON",
      destinationLatitude: 43.8,
      destinationLongitude: -79.3,
      previousCompletedAt: firstRecord.completed_at,
      pwaStartedAt: currentGroup[0].started_at,
      completedAt: currentGroup[0].completed_at,
      existingArrivalAt: "2026-08-17T13:54:00.000Z",
      proposedArrivalAt: "2026-08-17T13:55:00.000Z",
      resolutionStatus: "resolved",
      source: "samsara_gps_history",
      confidence: "high",
      stateHash: actualArrivalStateHash(currentGroup),
      evidence: { pointCount: 80 },
      error: ""
    }], { status: "preview_ready" });
    await query(
      `UPDATE driver_job_records
          SET job_details = job_details || '{"concurrentEvidenceChange":true}'::jsonb
        WHERE job_id = $1`,
      [groupedLead]
    );
    await assert.rejects(
      applyActualArrivalRun(stalePreview.runId, {
        expectedResultVersion: staleRetained.resultVersion,
        appliedBy: "operator:arrival-stale-test"
      }),
      (error) => error?.code === "DISPATCH_ACTUAL_ARRIVAL_STALE"
    );
    assert.equal((await getActualArrivalRun(stalePreview.runId))?.status, "stale");
    const canonicalAfterStale = await query(
      `SELECT DISTINCT actual_arrival_at::text
         FROM dispatch_actual_stop_arrivals
        WHERE driver_job_record_id = ANY($1::bigint[])`,
      [currentGroup.map((record) => Number(record.id))]
    );
    assert.equal(canonicalAfterStale.rowCount, 1);
    assert.equal(new Date(canonicalAfterStale.rows[0].actual_arrival_at).toISOString(), "2026-08-17T13:54:00.000Z");
  });
});

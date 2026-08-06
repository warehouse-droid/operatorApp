import crypto from "node:crypto";

import { query } from "../../../src/db.js";
import {
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "./bin-dispatch-fixtures.js";

const binDispatch = await import("../../../src/mbt/bin-dispatch-service.js");
let nextPlanDateOffset = 2_000 + crypto.randomInt(0, 2_000);

/**
 * Create one assigned, confirmed, entirely synthetic initial-delivery leg and
 * return the persisted physical stops as Driver-shaped base jobs. Production
 * must enrich these jobs from server-owned visit/asset state; the fixture does
 * not copy that state into its expectations.
 *
 * @param {string} label
 * @param {{includePilotScope?: boolean}} [options]
 */
export async function createAssignedDriverBinFixture(label, { includePilotScope = true } = {}) {
  const fixture = await createBinDispatchFixture({
    label: `driver-${label}`,
    planDate: binDispatchPlanDate(nextPlanDateOffset++),
    includePilotScope
  });
  const assignment = await binDispatch.assignMbtBinFrontLeg(
    binAssignmentCommand(fixture, `driver-${label}`),
    { capability: enabledBinDispatchBoundary }
  );
  await query(
    "UPDATE dispatch_plans SET status = 'confirmed', updated_at = now() WHERE id = $1",
    [fixture.planId]
  );
  const plan = await query(
    `SELECT p.id::text, p.plan_date::text, p.revision::int, s.orders, s.trucks, s.summary
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      WHERE p.id = $1`,
    [fixture.planId]
  );
  const truck = plan.rows[0].trucks.find((candidate) => String(candidate.id) === fixture.binTruckId);
  const load = truck.loads.find((candidate) => candidate.id === fixture.binLoadIds[0]);
  const jobs = load.stops
    .filter((stop) => stop?.mbt?.visitId === fixture.frontVisitId)
    .map((stop, index) => ({
      jobId: [fixture.planId, fixture.binTruckId, load.id, stop.id]
        .map((part) => encodeURIComponent(String(part)))
        .join(":"),
      planId: fixture.planId,
      planDate: fixture.planDate,
      driverLogin: fixture.driverLogin,
      driverName: `Synthetic BIN driver ${fixture.suffix}`,
      truckId: fixture.binTruckId,
      truckPlate: truck.plate,
      loadId: load.id,
      loadName: load.name,
      stopId: stop.id,
      stopType: stop.type === "pickup" ? "pickup" : "dropoff",
      location: stop.yardCode || "Synthetic customer site",
      address: stop.yardCode || "100 Test Route, Toronto, ON",
      requiredPhotos: stop.evidenceRequirements
        .filter((requirement) => requirement.type === "photo")
        .reduce((sum, requirement) => sum + Number(requirement.minimumCount), 0),
      orderRefs: [],
      orderTypes: ["BIN"],
      lineRowIds: [],
      sequence: { truckIndex: 0, loadIndex: 0, stopIndex: index },
      mbt: stop.mbt,
      mbtDispatchStop: stop
    }));
  return {
    ...fixture,
    assignment: assignment.body,
    plan: plan.rows[0],
    jobs
  };
}

/** @param {Awaited<ReturnType<typeof createAssignedDriverBinFixture>>} fixture */
export async function driverBinDurableState(fixture) {
  const result = await query(
    `SELECT
       visit.status AS visit_status,
       visit.revision::int AS visit_revision,
       visit.actual_started_at,
       visit.actual_completed_at,
       state.lifecycle_status AS asset_status,
       state.location_kind AS asset_location_kind,
       state.location_reference AS asset_location_reference,
       state.revision::int AS asset_revision,
       (SELECT count(*)::int FROM mbt_bin_movements movement
         WHERE movement.service_visit_id = visit.service_visit_id) AS movement_count,
       (SELECT count(*)::int FROM mbt_evidence evidence
         WHERE evidence.service_visit_id = visit.service_visit_id) AS evidence_count,
       (SELECT count(*)::int FROM mbt_driver_bin_event_applications application
         WHERE application.service_visit_id = visit.service_visit_id) AS application_count,
       (SELECT count(*)::int FROM driver_job_records record
         WHERE record.job_id = ANY($2::text[])) AS driver_record_count,
       (SELECT count(*)::int FROM driver_job_records record
         WHERE record.job_id = ANY($2::text[]) AND record.status = 'complete') AS completed_driver_record_count,
       (SELECT count(*)::int FROM mbt_bin_asset_reservations reservation
         WHERE reservation.visit_id = visit.service_visit_id AND reservation.released_at IS NULL) AS active_reservation_count,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS netsuite_outbox_count
      FROM mbt_service_visits visit
      JOIN mbt_bin_asset_state state ON state.asset_id = $3
     WHERE visit.service_visit_id = $1`,
    [fixture.frontVisitId, fixture.jobs.map(({ jobId }) => jobId), fixture.assetId]
  );
  return result.rows[0];
}

export function driverBinEvent(fixture, job, eventType, sequence, details = {}, overrides = {}) {
  const occurredAt = new Date(Date.now() + sequence);
  return {
    eventId: crypto.randomUUID(),
    eventType,
    driverLogin: fixture.driverLogin,
    deviceId: `p3-driver-device-${fixture.suffix}`,
    manifestId: crypto.randomUUID(),
    clientSequence: sequence,
    jobId: job.jobId,
    occurredAt: occurredAt.toISOString(),
    receivedAt: new Date(occurredAt.getTime() + 1_000).toISOString(),
    details,
    photos: [],
    ...overrides
  };
}

export const enabledDriverBinBoundary = Object.freeze({
  environmentEnabled: true,
  databaseEnabled: true,
  pilotAuthorized: true,
  issuedManifestAuthorized: true
});

import crypto from "node:crypto";

import { query, withTransaction } from "../../../src/db.js";
import { createFrontdeskPrerequisites } from "./frontdesk-fixtures.js";

export const BIN_DISPATCH_YARD_ID = "00000000-0000-4000-8000-000000012441";
export const BIN_DISPATCH_YARD_CODE = "12441";
export const BIN_DISPATCH_BIN_TYPE_ID = "00000000-0000-4000-8000-000000000014";

const DATE_SEED = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 6), 16);

/** @param {number} offset */
export function binDispatchPlanDate(offset = 0) {
  const date = new Date(Date.UTC(2060, 0, 1));
  date.setUTCDate(date.getUTCDate() + (DATE_SEED % 10_000) + offset);
  return date.toISOString().slice(0, 10);
}

/** @param {string} value */
function compact(value) {
  return value.replaceAll("-", "");
}

/**
 * Build one entirely synthetic current-leg fixture. The function is called
 * only after a P3.8 operation exists, so RED does not require migration 113.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.planDate
 * @param {string} [options.frontStatus]
 * @param {string} [options.successorStatus]
 * @param {number} [options.binLoadCount]
 * @param {boolean} [options.includePilotScope]
 */
export async function createBinDispatchFixture({
  label,
  planDate,
  frontStatus = "ready",
  successorStatus = "tentative",
  binLoadCount = 3,
  includePilotScope = true
}) {
  const fixtureId = crypto.randomUUID();
  const suffix = compact(fixtureId);
  const prerequisites = await createFrontdeskPrerequisites({ label: `bin-${label}` });
  const contractId = crypto.randomUUID();
  const frontVisitId = crypto.randomUUID();
  const successorVisitId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const movementId = crypto.randomUUID();
  const pilotScopeId = crypto.randomUUID();
  const contractNumber = `MBT-P3-${suffix.slice(0, 12)}`;
  const assetCode = `P3-BIN-${suffix.slice(0, 16)}`;
  const frontReference = `BIN-${contractNumber}-V1`;
  const successorReference = `BIN-${contractNumber}-V2`;
  const driverLogin = `p3_bin_driver_${suffix.slice(0, 12)}`;
  const occurredAt = `${planDate}T06:00:00.000Z`;

  const driver = await query(
    `INSERT INTO dispatch_drivers (name, login, active)
     VALUES ($1, $2, true)
     RETURNING id::text`,
    [`Synthetic BIN driver ${suffix}`, driverLogin]
  );
  const driverId = String(driver.rows[0].id);

  const fleet = await withTransaction(async () => {
    const binTruck = await query(
      `INSERT INTO dispatch_trucks (
         plate, capacity_lbs, active, truck_type, base_yard_id, revision,
         bin_service_enabled, bin_slot_capacity
       ) VALUES ($1, 48000, true, 'bin', $2, 1, true, 1)
       RETURNING id::text`,
      [`P3B${suffix.slice(0, 10)}`, BIN_DISPATCH_YARD_ID]
    );
    const binTruckId = String(binTruck.rows[0].id);
    await query(
      `INSERT INTO dispatch_truck_bin_types (
         truck_id, bin_type_id, active, created_by
       ) VALUES ($1, $2, true, 'p3-bin-dispatch-test')`,
      [binTruckId, BIN_DISPATCH_BIN_TYPE_ID]
    );
    const flatbedTruck = await query(
      `INSERT INTO dispatch_trucks (plate, capacity_lbs, active)
       VALUES ($1, 48000, true)
       RETURNING id::text`,
      [`P3F${suffix.slice(0, 10)}`]
    );
    return {
      binTruckId,
      flatbedTruckId: String(flatbedTruck.rows[0].id)
    };
  });

  await query(
    `INSERT INTO mbt_contracts (
       contract_id, contract_number, customer_netsuite_id,
       customer_site_profile_id, service_template_version_id,
       rate_card_version_id, bin_type_id, status,
       planned_delivery_at, planned_return_at,
       customer_snapshot, site_snapshot, terms_snapshot,
       tax_snapshot, pricing_snapshot, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'confirmed',
       $8::timestamptz, $9::timestamptz,
       $10::jsonb, $11::jsonb, $12::jsonb,
       $13::jsonb, $14::jsonb, 'p3-bin-dispatch-test', 'p3-bin-dispatch-test'
     )`,
    [
      contractId,
      contractNumber,
      prerequisites.customerNetsuiteId,
      prerequisites.siteProfileId,
      prerequisites.templateVersionId,
      prerequisites.rateCardVersionId,
      BIN_DISPATCH_BIN_TYPE_ID,
      `${planDate}T12:00:00.000Z`,
      `${planDate}T18:00:00.000Z`,
      JSON.stringify({
        customerNetsuiteId: prerequisites.customerNetsuiteId,
        displayName: `Synthetic BIN customer ${suffix}`
      }),
      JSON.stringify({
        siteProfileId: prerequisites.siteProfileId,
        addressId: prerequisites.addressId,
        addressLine1: "100 Test Route",
        city: "Toronto",
        region: "ON"
      }),
      JSON.stringify({ rentalCalendarDays: 14 }),
      JSON.stringify({ code: "ON_HST_13", basisPoints: 1300 }),
      JSON.stringify({ currency: "CAD", totalMinor: 53_675 })
    ]
  );

  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_assets (
         asset_id, asset_code, qr_code, bin_type_id, home_yard_id,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, 'p3-bin-dispatch-test', 'p3-bin-dispatch-test')`,
      [
        assetId,
        assetCode,
        `QR-${suffix}`,
        BIN_DISPATCH_BIN_TYPE_ID,
        BIN_DISPATCH_YARD_ID
      ]
    );
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         after_location_kind, after_location_reference, to_yard_id,
         source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 1, 'asset_registered', NULL, 'available', NULL,
         'yard', $3, $4, 'p3_bin_dispatch_fixture', 'system',
         'p3-bin-dispatch-test', $5::timestamptz
       )`,
      [movementId, assetId, BIN_DISPATCH_YARD_CODE, BIN_DISPATCH_YARD_ID, occurredAt]
    );
    await query(
      `INSERT INTO mbt_bin_asset_state (
         asset_id, lifecycle_status, location_kind, location_reference,
         yard_id, last_movement_id, revision, changed_at
       ) VALUES ($1, 'available', 'yard', $2, $3, $4, 1, $5::timestamptz)`,
      [assetId, BIN_DISPATCH_YARD_CODE, BIN_DISPATCH_YARD_ID, movementId, occurredAt]
    );
  });

  const frontStops = [
    {
      stopId: `${frontReference}-S1`,
      sequence: 1,
      actionCode: "collect_empty_bin",
      stopKind: "pickup",
      locationRole: "origin_yard",
      yardId: BIN_DISPATCH_YARD_ID,
      yardCode: BIN_DISPATCH_YARD_CODE,
      assetId
    },
    {
      stopId: `${frontReference}-S2`,
      sequence: 2,
      actionCode: "deliver_bin",
      stopKind: "drop",
      locationRole: "customer_site",
      siteProfileId: prerequisites.siteProfileId,
      assetId
    }
  ];
  const frontServiceSnapshot = {
    schemaVersion: "mbt-bin-service-snapshot-v1",
    predecessorVisitId: null,
    mandatoryStops: frontStops,
    evidenceRequirements: [
      { code: "outgoing_bin_scan", type: "bin_scan", minimumCount: 1 },
      { code: "placement_photo", type: "photo", minimumCount: 1 }
    ]
  };
  const successorServiceSnapshot = {
    schemaVersion: "mbt-bin-service-snapshot-v1",
    predecessorVisitId: frontVisitId,
    mandatoryStops: [
      {
        stopId: `${successorReference}-S1`,
        sequence: 1,
        actionCode: "pickup_bin",
        stopKind: "pickup",
        locationRole: "customer_site",
        siteProfileId: prerequisites.siteProfileId,
        assetId
      },
      {
        stopId: `${successorReference}-S2`,
        sequence: 2,
        actionCode: "return_bin",
        stopKind: "drop",
        locationRole: "return_yard",
        yardId: BIN_DISPATCH_YARD_ID,
        yardCode: BIN_DISPATCH_YARD_CODE,
        assetId
      }
    ]
  };

  await query(
    `INSERT INTO mbt_service_visits (
       service_visit_id, contract_id, predecessor_visit_id,
       visit_number, visit_reference, service_template_version_id,
       service_action, status, customer_site_profile_id, bin_type_id,
       expected_asset_id, outgoing_asset_id, scheduled_start_at,
       scheduled_end_at, customer_snapshot, site_snapshot, service_snapshot,
       dispatch_order_reference, created_by, updated_by
     ) VALUES
       (
         $1, $3, NULL, 1, $4, $5,
         'delivery', $6, $7, $8,
         $9, $9, $10::timestamptz, $11::timestamptz,
         $12::jsonb, $13::jsonb, $14::jsonb, $4,
         'p3-bin-dispatch-test', 'p3-bin-dispatch-test'
       ),
       (
         $2, $3, $1, 2, $15, $5,
         'return_bin', $16, $7, $8,
         $9, NULL, $17::timestamptz, $18::timestamptz,
         $12::jsonb, $13::jsonb, $19::jsonb, $15,
         'p3-bin-dispatch-test', 'p3-bin-dispatch-test'
       )`,
    [
      frontVisitId,
      successorVisitId,
      contractId,
      frontReference,
      prerequisites.templateVersionId,
      frontStatus,
      prerequisites.siteProfileId,
      BIN_DISPATCH_BIN_TYPE_ID,
      assetId,
      `${planDate}T12:00:00.000Z`,
      `${planDate}T16:00:00.000Z`,
      JSON.stringify({
        customerNetsuiteId: prerequisites.customerNetsuiteId,
        displayName: `Synthetic BIN customer ${suffix}`
      }),
      JSON.stringify({
        siteProfileId: prerequisites.siteProfileId,
        addressLine1: "100 Test Route"
      }),
      JSON.stringify(frontServiceSnapshot),
      successorReference,
      successorStatus,
      `${planDate}T17:00:00.000Z`,
      `${planDate}T20:00:00.000Z`,
      JSON.stringify(successorServiceSnapshot)
    ]
  );

  if (includePilotScope) {
    const pilotExpiresAt = new Date(`${planDate}T12:00:00.000Z`);
    pilotExpiresAt.setUTCDate(pilotExpiresAt.getUTCDate() + 2);
    await query(
      `INSERT INTO mbt_driver_pilot_scope (
         pilot_scope_id, plan_date, driver_login, truck_id, contract_id,
         service_visit_id, active, authorized_by, authorized_at, expires_at
       ) VALUES ($1, $2::date, $3, $4, $5, $6, true,
                 'p3-bin-dispatch-test', now(), $7::timestamptz)`,
      [
        pilotScopeId,
        planDate,
        driverLogin,
        fleet.binTruckId,
        contractId,
        frontVisitId,
        pilotExpiresAt.toISOString()
      ]
    );
  }

  const frontStepIds = [crypto.randomUUID(), crypto.randomUUID()];
  await query(
    `INSERT INTO mbt_visit_steps (
       visit_step_id, service_visit_id, sequence_number, action_code,
       display_name, location_role, expected_asset_id
     ) VALUES
       ($1, $3, 0, 'collect_empty_bin', 'Collect empty 14YD bin', 'origin_yard', $4),
       ($2, $3, 1, 'deliver_bin', 'Deliver empty 14YD bin', 'customer_site', $4)`,
    [frontStepIds[0], frontStepIds[1], frontVisitId, assetId]
  );
  await query(
    `INSERT INTO mbt_visit_evidence_requirements (
       visit_evidence_requirement_id, service_visit_id, visit_step_id,
       evidence_code, evidence_type, minimum_count, required
     ) VALUES
       ($1, $3, $4, 'outgoing_bin_scan', 'bin_scan', 1, true),
       ($2, $3, $5, 'placement_photo', 'photo', 1, true)`,
    [crypto.randomUUID(), crypto.randomUUID(), frontVisitId, frontStepIds[0], frontStepIds[1]]
  );

  const binLoads = Array.from({ length: Math.max(1, binLoadCount) }, (_, index) => ({
    id: `P3-BIN-LOAD-${suffix.slice(0, 8)}-${index + 1}`,
    name: `BIN Load ${index + 1}`,
    driverId,
    driverLogin,
    truckId: fleet.binTruckId,
    truckPlate: `P3B${suffix.slice(0, 10)}`,
    stops: []
  }));
  const flatbedLoad = {
    id: `P3-FLATBED-LOAD-${suffix.slice(0, 8)}`,
    name: "Flatbed control load",
    driverId,
    driverLogin,
    truckId: fleet.flatbedTruckId,
    truckPlate: `P3F${suffix.slice(0, 10)}`,
    stops: []
  };
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ($1::date, 'draft', 'Synthetic P3.8 BIN integration fixture', 1)
     RETURNING id::text`,
    [planDate]
  );
  const planId = String(plan.rows[0].id);
  const trucks = [
    {
      id: fleet.binTruckId,
      plate: `P3B${suffix.slice(0, 10)}`,
      truckType: "bin",
      binSlotCapacity: 1,
      supportedBinTypeCodes: ["14YD"],
      driverId,
      driverLogin,
      loads: binLoads
    },
    {
      id: fleet.flatbedTruckId,
      plate: `P3F${suffix.slice(0, 10)}`,
      truckType: "flatbed",
      binSlotCapacity: 0,
      supportedBinTypeCodes: [],
      driverId,
      driverLogin,
      loads: [flatbedLoad]
    }
  ];
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, $2::jsonb, $3::jsonb)`,
    [
      planId,
      JSON.stringify(trucks),
      JSON.stringify({
        dispatchPlanFormat: { version: 2, source: "p3-bin-dispatch-test" },
        ownYardCodes: [BIN_DISPATCH_YARD_CODE]
      })
    ]
  );

  return {
    fixtureId,
    pilotScopeId,
    suffix,
    planId,
    planDate,
    planRevision: 1,
    contractId,
    contractNumber,
    frontVisitId,
    successorVisitId,
    frontReference,
    successorReference,
    frontStops,
    assetId,
    assetCode,
    assetStateRevision: 1,
    binTypeId: BIN_DISPATCH_BIN_TYPE_ID,
    binTypeCode: "14YD",
    siteProfileId: prerequisites.siteProfileId,
    driverId,
    driverLogin,
    binTruckId: fleet.binTruckId,
    flatbedTruckId: fleet.flatbedTruckId,
    binLoadIds: binLoads.map(({ id }) => id),
    flatbedLoadId: flatbedLoad.id
  };
}

export async function ordinaryDispatchSideEffects() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM sales_orders) AS sales_orders,
       (SELECT count(*)::int FROM purchase_orders) AS purchase_orders,
       (SELECT count(*)::int FROM transfer_orders) AS transfer_orders,
       (SELECT count(*)::int FROM order_dependencies) AS dependencies,
       (SELECT count(*)::int FROM driver_job_records) AS driver_jobs,
       (SELECT count(*)::int FROM operator_saved_delivery_orders) AS operator_orders,
       (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS netsuite_chains,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS netsuite_outbox`
  );
  return result.rows[0];
}

/** @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture */
export async function durableBinDispatchState(fixture) {
  const result = await query(
    `SELECT
       p.status AS plan_status,
       p.revision::int AS plan_revision,
       s.orders, s.trucks, s.summary,
       v.status AS visit_status,
       v.revision::int AS visit_revision,
       v.dispatch_plan_id,
       v.dispatch_plan_revision::int,
       (SELECT count(*)::int
          FROM mbt_bin_asset_reservations r
         WHERE r.visit_id = v.service_visit_id AND r.released_at IS NULL) AS reservations,
       (SELECT count(*)::int
          FROM mbt_command_receipts r
         WHERE r.command_name LIKE 'mbt.bin_dispatch.%'
           AND r.response_body ->> 'visitId' = v.service_visit_id::text) AS receipts,
       (SELECT count(*)::int
          FROM mbt_audit_events a
         WHERE a.entity_type = 'mbt_service_visit'
           AND a.entity_id = v.service_visit_id::text) AS audits
      FROM dispatch_plans p
      JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
      JOIN mbt_service_visits v ON v.service_visit_id = $2
     WHERE p.id = $1`,
    [fixture.planId, fixture.frontVisitId]
  );
  return result.rows[0];
}

/**
 * @param {Awaited<ReturnType<typeof createBinDispatchFixture>>} fixture
 * @param {string} label
 * @param {Record<string, unknown>} [overrides]
 */
export function binAssignmentCommand(fixture, label, overrides = {}) {
  const identity = `${fixture.suffix}-${label}-${compact(crypto.randomUUID())}`;
  return {
    actor: {
      operatorId: `p3-bin-dispatcher-${fixture.suffix}`,
      roles: ["dispatcher"]
    },
    planId: fixture.planId,
    planDate: fixture.planDate,
    loadId: fixture.binLoadIds[0],
    visitId: fixture.frontVisitId,
    expectedVisitRevision: 1,
    expectedPlanRevision: fixture.planRevision,
    assetAssignments: [{
      reservationSlot: "outgoing",
      assetId: fixture.assetId,
      expectedStateRevision: fixture.assetStateRevision
    }],
    reason: `Synthetic BIN assignment ${label}`,
    idempotencyKey: `p3-bin-assign-${identity}`,
    correlationId: `p3-bin-corr-${identity}`,
    requestId: `p3-bin-req-${identity}`,
    ...overrides
  };
}

export const enabledBinDispatchBoundary = Object.freeze({
  environmentEnabled: true,
  databaseEnabled: true,
  pilotAuthorized: true
});

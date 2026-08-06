import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query, withTransaction } from "../../../src/db.js";
import { assignMbtBinFrontLeg } from "../../../src/mbt/bin-dispatch-service.js";
import {
  BIN_DISPATCH_BIN_TYPE_ID,
  BIN_DISPATCH_YARD_CODE,
  BIN_DISPATCH_YARD_ID,
  enabledBinDispatchBoundary,
  ordinaryDispatchSideEffects
} from "../support/bin-dispatch-fixtures.js";
import { createFrontdeskPrerequisites } from "../support/frontdesk-fixtures.js";

const COMPETITORS = 25;
const ACTOR = Object.freeze({ operatorId: "p3-seam-race-dispatcher", roles: ["dispatcher"] });
const RACE_DATE_OFFSET = Number.parseInt(crypto.randomUUID().replaceAll("-", "").slice(0, 6), 16) % 20_000;

/** @param {Array<() => Promise<unknown>>} operations */
async function releaseTogether(operations) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const attempts = operations.map(async (operation) => {
    await gate;
    return operation();
  });
  release();
  return Promise.allSettled(attempts);
}

async function createSharedAsset() {
  const assetId = crypto.randomUUID();
  const movementId = crypto.randomUUID();
  const assetCode = `SEAM-RACE-${assetId.replaceAll("-", "").slice(0, 12)}`;
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_assets (
         asset_id, asset_code, qr_code, bin_type_id, home_yard_id,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, 'p3-seam-race', 'p3-seam-race')`,
      [assetId, assetCode, `QR-${assetCode}`, BIN_DISPATCH_BIN_TYPE_ID, BIN_DISPATCH_YARD_ID]
    );
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         after_location_kind, after_location_reference, to_yard_id,
         source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 1, 'asset_registered', NULL, 'available', NULL,
         'yard', $3, $4, 'p3_seam_race', 'system', 'p3-seam-race', now()
       )`,
      [movementId, assetId, BIN_DISPATCH_YARD_CODE, BIN_DISPATCH_YARD_ID]
    );
    await query(
      `INSERT INTO mbt_bin_asset_state (
         asset_id, lifecycle_status, location_kind, location_reference,
         yard_id, last_movement_id, revision, changed_at
       ) VALUES ($1, 'available', 'yard', $2, $3, $4, 1, now())`,
      [assetId, BIN_DISPATCH_YARD_CODE, BIN_DISPATCH_YARD_ID, movementId]
    );
  });
  return { assetId, assetCode };
}

async function createSharedFleet() {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const driver = await query(
    "INSERT INTO dispatch_drivers (name, login, active) VALUES ($1, $2, true) RETURNING id::text",
    [`Seam race driver ${suffix}`, `seam_race_${suffix}`]
  );
  const truckId = await withTransaction(async () => {
    const truck = await query(
      `INSERT INTO dispatch_trucks (
         plate, capacity_lbs, active, truck_type, base_yard_id,
         bin_service_enabled, bin_slot_capacity
       ) VALUES ($1, 48000, true, 'bin', $2, true, 1)
       RETURNING id::text`,
      [`SR${suffix}`, BIN_DISPATCH_YARD_ID]
    );
    await query(
      `INSERT INTO dispatch_truck_bin_types (truck_id, bin_type_id, active, created_by)
       VALUES ($1, $2, true, 'p3-seam-race')`,
      [truck.rows[0].id, BIN_DISPATCH_BIN_TYPE_ID]
    );
    return String(truck.rows[0].id);
  });
  return {
    truckId,
    plate: `SR${suffix}`,
    driverId: String(driver.rows[0].id),
    driverLogin: `seam_race_${suffix}`
  };
}

/**
 * @param {Awaited<ReturnType<typeof createFrontdeskPrerequisites>>} prerequisites
 * @param {Awaited<ReturnType<typeof createSharedFleet>>} fleet
 * @param {number} index
 */
async function createCompetitor(prerequisites, fleet, index) {
  const date = new Date(Date.UTC(2088, 0, 1 + RACE_DATE_OFFSET + index)).toISOString().slice(0, 10);
  const contractId = crypto.randomUUID();
  const deliveryVisitId = crypto.randomUUID();
  const returnVisitId = crypto.randomUUID();
  const contractNumber = `MBT-SEAM-RACE-${String(index + 1).padStart(2, "0")}-${contractId.replaceAll("-", "").slice(0, 6)}`;
  const deliveryReference = `${contractNumber}-V1`;
  const returnReference = `${contractNumber}-V2`;
  const site = {
    siteProfileId: prerequisites.siteProfileId,
    addressId: prerequisites.addressId,
    addressLine1: "100 Test Route",
    city: "Toronto",
    region: "ON"
  };
  const customer = {
    netsuiteId: prerequisites.customerNetsuiteId,
    displayName: `Seam race customer ${index + 1}`
  };
  const deliveryStops = [
    {
      stopId: `${deliveryReference}-S1`, sequence: 1, actionCode: "collect_empty_bin",
      stopKind: "pickup", locationRole: "origin_yard",
      yardId: BIN_DISPATCH_YARD_ID, yardCode: BIN_DISPATCH_YARD_CODE, assetId: null
    },
    {
      stopId: `${deliveryReference}-S2`, sequence: 2, actionCode: "deliver_bin",
      stopKind: "drop", locationRole: "customer_site",
      siteProfileId: prerequisites.siteProfileId, assetId: null
    }
  ];
  const returnStops = [
    {
      stopId: `${returnReference}-S1`, sequence: 1, actionCode: "pickup_bin",
      stopKind: "pickup", locationRole: "customer_site",
      siteProfileId: prerequisites.siteProfileId, assetId: null
    },
    {
      stopId: `${returnReference}-S2`, sequence: 2, actionCode: "return_bin",
      stopKind: "drop", locationRole: "return_yard",
      yardId: BIN_DISPATCH_YARD_ID, yardCode: BIN_DISPATCH_YARD_CODE, assetId: null
    }
  ];
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
       $10::jsonb, $11::jsonb, '{"rentalCalendarDays":14}'::jsonb,
       '{}'::jsonb, '{}'::jsonb, 'p3-seam-race', 'p3-seam-race'
     )`,
    [
      contractId, contractNumber, prerequisites.customerNetsuiteId,
      prerequisites.siteProfileId, prerequisites.templateVersionId,
      prerequisites.rateCardVersionId, BIN_DISPATCH_BIN_TYPE_ID,
      `${date}T12:00:00.000Z`, `${date}T18:00:00.000Z`,
      JSON.stringify(customer), JSON.stringify(site)
    ]
  );
  await query(
    `INSERT INTO mbt_service_visits (
       service_visit_id, contract_id, predecessor_visit_id,
       visit_number, visit_reference, service_template_version_id,
       service_action, status, customer_site_profile_id, bin_type_id,
       scheduled_start_at, scheduled_end_at,
       customer_snapshot, site_snapshot, service_snapshot,
       created_by, updated_by
     ) VALUES
       ($1, $3, NULL, 1, $4, $5, 'delivery', 'ready', $6, $7,
        $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb, $12::jsonb,
        'p3-seam-race', 'p3-seam-race'),
       ($2, $3, $1, 2, $13, $5, 'return_bin', 'tentative', $6, $7,
        $14::timestamptz, $15::timestamptz, $10::jsonb, $11::jsonb, $16::jsonb,
        'p3-seam-race', 'p3-seam-race')`,
    [
      deliveryVisitId, returnVisitId, contractId, deliveryReference,
      prerequisites.templateVersionId, prerequisites.siteProfileId,
      BIN_DISPATCH_BIN_TYPE_ID, `${date}T12:00:00.000Z`, `${date}T16:00:00.000Z`,
      JSON.stringify(customer), JSON.stringify(site),
      JSON.stringify({
        schemaVersion: "mbt-bin-service-snapshot-v1",
        templateVersionId: prerequisites.templateVersionId,
        templateRevision: 2,
        dependentReturnVisitId: returnVisitId,
        dependentReturnVisitRevision: 1,
        mandatoryStops: deliveryStops
      }),
      returnReference, `${date}T18:00:00.000Z`, `${date}T21:00:00.000Z`,
      JSON.stringify({
        schemaVersion: "mbt-bin-service-snapshot-v1",
        predecessorVisitId: deliveryVisitId,
        mandatoryStops: returnStops
      })
    ]
  );
  const stepIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await query(
    `INSERT INTO mbt_visit_steps (
       visit_step_id, service_visit_id, sequence_number, action_code,
       display_name, location_role
     ) VALUES
       ($1, $5, 0, 'collect_empty_bin', 'Collect empty bin', 'origin_yard'),
       ($2, $5, 1, 'deliver_bin', 'Deliver empty bin', 'customer_site'),
       ($3, $6, 0, 'pickup_bin', 'Pickup bin', 'customer_site'),
       ($4, $6, 1, 'return_bin', 'Return bin', 'return_yard')`,
    [...stepIds, deliveryVisitId, returnVisitId]
  );
  const loadId = `SEAM-RACE-LOAD-${index + 1}`;
  const plan = await query(
    `INSERT INTO dispatch_plans (plan_date, status, note, revision)
     VALUES ($1::date, 'draft', 'P3 seam asset race', 1) RETURNING id::text`,
    [date]
  );
  const planId = String(plan.rows[0].id);
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES ($1, '[]'::jsonb, $2::jsonb, '{}'::jsonb)`,
    [planId, JSON.stringify([{
      id: fleet.truckId,
      plate: fleet.plate,
      truckType: "bin",
      binSlotCapacity: 1,
      supportedBinTypeCodes: ["14YD"],
      driverId: fleet.driverId,
      driverLogin: fleet.driverLogin,
      loads: [{
        id: loadId,
        name: `Seam race load ${index + 1}`,
        truckId: fleet.truckId,
        driverId: fleet.driverId,
        stops: []
      }]
    }])]
  );
  return { date, contractId, deliveryVisitId, returnVisitId, planId, loadId };
}

after(async () => {
  await closeDb();
});

test("P3-F16 seam: twenty-five independent unbound visits racing for one asset yield one atomic binding", {
  timeout: 180_000
}, async () => {
  const prerequisites = await createFrontdeskPrerequisites({ label: "unbound-asset-race" });
  const fleet = await createSharedFleet();
  const asset = await createSharedAsset();
  const competitors = [];
  for (let index = 0; index < COMPETITORS; index += 1) {
    competitors.push(await createCompetitor(prerequisites, fleet, index));
  }
  const ordinaryBefore = await ordinaryDispatchSideEffects();
  const outcomes = await releaseTogether(competitors.map((competitor, index) => () =>
    assignMbtBinFrontLeg({
      actor: ACTOR,
      planId: competitor.planId,
      planDate: competitor.date,
      loadId: competitor.loadId,
      visitId: competitor.deliveryVisitId,
      expectedVisitRevision: 1,
      expectedPlanRevision: 1,
      assetAssignments: [{
        reservationSlot: "outgoing",
        assetId: asset.assetId,
        expectedStateRevision: 1
      }],
      reason: `P3 seam race competitor ${index + 1}`,
      idempotencyKey: `p3-seam-race-${index}-${crypto.randomUUID()}`,
      correlationId: `p3-seam-race-corr-${index}-${crypto.randomUUID()}`,
      requestId: `p3-seam-race-req-${index}-${crypto.randomUUID()}`
    }, { capability: enabledBinDispatchBoundary })
  ));
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, COMPETITORS - 1, JSON.stringify(outcomes));
  assert.deepEqual([...new Set(losers.map(({ reason }) => reason?.code))], ["MBT_BIN_ASSET_MISMATCH"]);

  const durable = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_service_visits
         WHERE service_visit_id = ANY($1::uuid[]) AND status = 'planned'
           AND expected_asset_id = $2 AND outgoing_asset_id = $2) AS planned_bound,
       (SELECT count(*)::int FROM mbt_service_visits
         WHERE service_visit_id = ANY($3::uuid[]) AND status = 'tentative'
           AND expected_asset_id = $2 AND revision = 2) AS successor_bound,
       (SELECT count(*)::int FROM mbt_service_visits
         WHERE service_visit_id = ANY($1::uuid[]) AND status = 'ready'
           AND expected_asset_id IS NULL AND outgoing_asset_id IS NULL) AS ready_unbound,
       (SELECT count(*)::int FROM mbt_bin_asset_reservations
         WHERE asset_id = $2 AND released_at IS NULL) AS reservations,
       (SELECT revision::int FROM mbt_bin_asset_state WHERE asset_id = $2) AS asset_revision`,
    [
      competitors.map(({ deliveryVisitId }) => deliveryVisitId),
      asset.assetId,
      competitors.map(({ returnVisitId }) => returnVisitId)
    ]
  );
  assert.deepEqual(durable.rows[0], {
    planned_bound: 1,
    successor_bound: 1,
    ready_unbound: COMPETITORS - 1,
    reservations: 1,
    asset_revision: 2
  });
  assert.deepEqual(await ordinaryDispatchSideEffects(), ordinaryBefore);
});

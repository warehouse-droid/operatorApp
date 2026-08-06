import crypto from "node:crypto";

import { query, withTransaction } from "../../../src/db.js";
import {
  BIN_DISPATCH_BIN_TYPE_ID,
  BIN_DISPATCH_YARD_CODE,
  BIN_DISPATCH_YARD_ID,
  binAssignmentCommand,
  binDispatchPlanDate,
  createBinDispatchFixture,
  enabledBinDispatchBoundary
} from "./bin-dispatch-fixtures.js";

const binDispatch = await import("../../../src/mbt/bin-dispatch-service.js");
let nextScenarioDateOffset = 8_000 + crypto.randomInt(0, 2_000);

/** @param {string} value */
function compact(value) {
  return value.replaceAll("-", "");
}

/**
 * Materialize the assigned Dispatch stop group into the raw Driver projection
 * used by production before server-owned BIN enrichment.
 * @param {Record<string, any>} fixture
 * @param {Record<string, any>[]} assetAssignments
 */
async function assignAndProject(fixture, assetAssignments) {
  const assignment = await binDispatch.assignMbtBinFrontLeg(
    binAssignmentCommand(fixture, `driver-${fixture.scenario}`, { assetAssignments }),
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
  const truck = plan.rows[0].trucks.find(
    (/** @type {Record<string, any>} */ candidate) => String(candidate.id) === fixture.binTruckId
  );
  const load = truck.loads.find(
    (/** @type {Record<string, any>} */ candidate) => candidate.id === fixture.binLoadIds[0]
  );
  const jobs = load.stops
    .filter((/** @type {Record<string, any>} */ stop) => stop?.mbt?.visitId === fixture.frontVisitId)
    .map((/** @type {Record<string, any>} */ stop, index) => ({
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
      stopType: ["pick", "pickup"].includes(String(stop.type)) ? "pickup" : "dropoff",
      location: stop.yardCode || stop.dumpSiteId || "Synthetic customer site",
      address: stop.yardCode || "100 Test Route, Toronto, ON",
      requiredPhotos: (stop.evidenceRequirements || [])
        .filter((/** @type {Record<string, any>} */ requirement) => requirement.type === "photo")
        .reduce((sum, /** @type {Record<string, any>} */ requirement) => sum + Number(requirement.minimumCount), 0),
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

/** @param {Record<string, any>} fixture */
async function moveFixtureAssetToCustomer(fixture) {
  const movementId = crypto.randomUUID();
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         before_location_reference, after_location_kind,
         after_location_reference, from_yard_id, to_customer_site_profile_id,
         source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 2, 'synthetic_pre_pilot_delivery',
         'available', 'at_customer', 'yard', $3, 'customer_site',
         $4, $5, $6, 'p3_driver_scenario_fixture', 'system',
         'p3-driver-scenario-test', $7::timestamptz
       )`,
      [
        movementId,
        fixture.assetId,
        BIN_DISPATCH_YARD_CODE,
        fixture.siteProfileId,
        BIN_DISPATCH_YARD_ID,
        fixture.siteProfileId,
        `${fixture.planDate}T05:00:00.000Z`
      ]
    );
    await query(
      `UPDATE mbt_bin_asset_state
          SET lifecycle_status = 'at_customer', location_kind = 'customer_site',
              location_reference = $2::text, yard_id = NULL,
              customer_site_profile_id = $2::uuid, dump_site_id = NULL,
              truck_id = NULL, last_movement_id = $3, revision = 2,
              changed_at = $4::timestamptz
        WHERE asset_id = $1`,
      [fixture.assetId, fixture.siteProfileId, movementId, `${fixture.planDate}T05:00:00.000Z`]
    );
  });
  return { ...fixture, assetStateRevision: 2 };
}

/**
 * Assigned three-stop loaded-pickup/dump/return scenario for P3-F21.
 * All data and receipt identities are synthetic.
 */
export async function createLoadedDumpDriverBinFixture() {
  let fixture = await createBinDispatchFixture({
    label: "driver-loaded-dump",
    planDate: binDispatchPlanDate(nextScenarioDateOffset++)
  });
  fixture = await moveFixtureAssetToCustomer(fixture);
  const dumpSiteId = crypto.randomUUID();
  const materialId = crypto.randomUUID();
  const suffix = compact(crypto.randomUUID());
  const pickupStepId = crypto.randomUUID();
  const dumpStepId = crypto.randomUUID();
  const returnStepId = crypto.randomUUID();
  const stops = [
    {
      stopId: `${fixture.frontReference}-PICKUP`, sequence: 1,
      actionCode: "pickup_loaded_bin", stopKind: "pickup",
      locationRole: "customer_site", siteProfileId: fixture.siteProfileId,
      assetId: fixture.assetId
    },
    {
      stopId: `${fixture.frontReference}-DUMP`, sequence: 2,
      actionCode: "dump_bin", stopKind: "drop",
      locationRole: "dump_site", dumpSiteId, materialId,
      assetId: fixture.assetId
    },
    {
      stopId: `${fixture.frontReference}-RETURN`, sequence: 3,
      actionCode: "return_bin", stopKind: "drop",
      locationRole: "return_yard", yardId: BIN_DISPATCH_YARD_ID,
      yardCode: BIN_DISPATCH_YARD_CODE, assetId: fixture.assetId
    }
  ];
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_materials (
         material_id, material_code, display_name, description,
         created_by, updated_by
       ) VALUES ($1, $2, $3, 'Synthetic clean fill', 'p3-test', 'p3-test')`,
      [materialId, `P3-MAT-${suffix.slice(0, 12)}`, `Synthetic material ${suffix.slice(0, 8)}`]
    );
    await query(
      `INSERT INTO mbt_dump_sites (
         dump_site_id, dump_site_code, display_name, address_line_1,
         city, region, postal_code, created_by, updated_by
       ) VALUES ($1, $2, $3, '500 Test Dump Road', 'Toronto', 'ON',
                 'M1M 1M1', 'p3-test', 'p3-test')`,
      [dumpSiteId, `P3-DUMP-${suffix.slice(0, 12)}`, `Synthetic dump ${suffix.slice(0, 8)}`]
    );
    await query(
      `INSERT INTO mbt_dump_site_materials (
         dump_site_material_id, dump_site_id, material_id, accepted,
         scale_ticket_required, created_by, updated_by
       ) VALUES ($1, $2, $3, true, true, 'p3-test', 'p3-test')`,
      [crypto.randomUUID(), dumpSiteId, materialId]
    );
    await query("DELETE FROM mbt_visit_evidence_requirements WHERE service_visit_id = $1", [fixture.frontVisitId]);
    await query("DELETE FROM mbt_visit_steps WHERE service_visit_id = $1", [fixture.frontVisitId]);
    await query(
      `UPDATE mbt_service_visits
          SET service_action = 'loaded_pickup_dump', expected_asset_id = $2,
              outgoing_asset_id = $2, incoming_asset_id = NULL,
              dump_site_id = $3, material_id = $4,
              service_snapshot = $5::jsonb
        WHERE service_visit_id = $1`,
      [
        fixture.frontVisitId,
        fixture.assetId,
        dumpSiteId,
        materialId,
        JSON.stringify({
          schemaVersion: "mbt-bin-service-snapshot-v1",
          predecessorVisitId: null,
          mandatoryStops: stops,
          evidenceRequirements: [
            { code: "loaded_bin_scan", type: "bin_scan", minimumCount: 1 },
            { code: "loaded_condition_photo", type: "photo", minimumCount: 1 },
            { code: "dump_receipt", type: "receipt", minimumCount: 1 },
            { code: "dump_receipt_photo", type: "photo", minimumCount: 1 },
            { code: "return_condition_photo", type: "photo", minimumCount: 1 }
          ]
        })
      ]
    );
    await query(
      `INSERT INTO mbt_visit_steps (
         visit_step_id, service_visit_id, sequence_number, action_code,
         display_name, location_role, expected_asset_id
       ) VALUES
         ($1, $4, 0, 'pickup_loaded_bin', 'Pick up loaded 14YD bin', 'customer_site', $5),
         ($2, $4, 1, 'dump_bin', 'Dump loaded 14YD bin', 'dump_site', $5),
         ($3, $4, 2, 'return_bin', 'Return 14YD bin to yard', 'return_yard', $5)`,
      [pickupStepId, dumpStepId, returnStepId, fixture.frontVisitId, fixture.assetId]
    );
    await query(
      `INSERT INTO mbt_visit_evidence_requirements (
         visit_evidence_requirement_id, service_visit_id, visit_step_id,
         evidence_code, evidence_type, minimum_count, required
       ) VALUES
         ($1, $6, $7, 'loaded_bin_scan', 'bin_scan', 1, true),
         ($2, $6, $7, 'loaded_condition_photo', 'photo', 1, true),
         ($3, $6, $8, 'dump_receipt', 'receipt', 1, true),
         ($4, $6, $8, 'dump_receipt_photo', 'photo', 1, true),
         ($5, $6, $9, 'return_condition_photo', 'photo', 1, true)`,
      [
        crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
        crypto.randomUUID(), crypto.randomUUID(), fixture.frontVisitId,
        pickupStepId, dumpStepId, returnStepId
      ]
    );
  });
  return assignAndProject(
    { ...fixture, scenario: "loaded-dump", frontStops: stops, dumpSiteId, materialId },
    [{
      reservationSlot: "outgoing",
      assetId: fixture.assetId,
      expectedStateRevision: fixture.assetStateRevision
    }]
  );
}

/**
 * Assigned collect-and-swap exchange scenario for P3-F22. The empty outgoing
 * asset and collected incoming asset have independent reservation identities.
 */
export async function createExchangeDriverBinFixture() {
  const fixture = await createBinDispatchFixture({
    label: "driver-exchange",
    planDate: binDispatchPlanDate(nextScenarioDateOffset++)
  });
  const incomingAssetId = crypto.randomUUID();
  const incomingMovementId = crypto.randomUUID();
  const incomingAssetCode = `P3-SWAP-${fixture.suffix.slice(0, 16)}`;
  const collectStepId = crypto.randomUUID();
  const exchangeStepId = crypto.randomUUID();
  const stops = [
    {
      stopId: `${fixture.frontReference}-COLLECT`, sequence: 1,
      actionCode: "collect_empty_bin", stopKind: "pickup",
      locationRole: "origin_yard", yardId: BIN_DISPATCH_YARD_ID,
      yardCode: BIN_DISPATCH_YARD_CODE, assetId: fixture.assetId
    },
    {
      stopId: `${fixture.frontReference}-EXCHANGE`, sequence: 2,
      actionCode: "exchange_bin", stopKind: "drop",
      locationRole: "customer_site", siteProfileId: fixture.siteProfileId,
      outgoingAssetId: fixture.assetId, incomingAssetId
    }
  ];
  await withTransaction(async () => {
    await query(
      `INSERT INTO mbt_bin_assets (
         asset_id, asset_code, qr_code, bin_type_id, home_yard_id,
         created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, 'p3-test', 'p3-test')`,
      [
        incomingAssetId,
        incomingAssetCode,
        `QR-${fixture.suffix}-SWAP`,
        BIN_DISPATCH_BIN_TYPE_ID,
        BIN_DISPATCH_YARD_ID
      ]
    );
    await query(
      `INSERT INTO mbt_bin_movements (
         movement_id, asset_id, asset_sequence, movement_type,
         before_status, after_status, before_location_kind,
         after_location_kind, after_location_reference,
         to_customer_site_profile_id, source, actor_type, actor_id, occurred_at
       ) VALUES (
         $1, $2, 1, 'synthetic_customer_asset', NULL, 'at_customer', NULL,
         'customer_site', $3::text, $3::uuid, 'p3_driver_scenario_fixture', 'system',
         'p3-driver-scenario-test', $4::timestamptz
       )`,
      [incomingMovementId, incomingAssetId, fixture.siteProfileId, `${fixture.planDate}T05:00:00.000Z`]
    );
    await query(
      `INSERT INTO mbt_bin_asset_state (
         asset_id, lifecycle_status, location_kind, location_reference,
         customer_site_profile_id, last_movement_id, revision, changed_at
       ) VALUES ($1, 'at_customer', 'customer_site', $2::text, $2::uuid, $3, 1, $4::timestamptz)`,
      [incomingAssetId, fixture.siteProfileId, incomingMovementId, `${fixture.planDate}T05:00:00.000Z`]
    );
    await query("DELETE FROM mbt_visit_evidence_requirements WHERE service_visit_id = $1", [fixture.frontVisitId]);
    await query("DELETE FROM mbt_visit_steps WHERE service_visit_id = $1", [fixture.frontVisitId]);
    await query(
      `UPDATE mbt_service_visits
          SET service_action = 'exchange', expected_asset_id = $2,
              outgoing_asset_id = $2, incoming_asset_id = $3,
              service_snapshot = $4::jsonb
        WHERE service_visit_id = $1`,
      [
        fixture.frontVisitId,
        fixture.assetId,
        incomingAssetId,
        JSON.stringify({
          schemaVersion: "mbt-bin-service-snapshot-v1",
          predecessorVisitId: null,
          mandatoryStops: stops,
          evidenceRequirements: [
            { code: "collect_outgoing_scan", type: "bin_scan", minimumCount: 1 },
            { code: "exchange_outgoing_scan", type: "bin_scan", minimumCount: 1 },
            { code: "exchange_incoming_scan", type: "bin_scan", minimumCount: 1 },
            { code: "exchange_outgoing_photo", type: "photo", minimumCount: 1 },
            { code: "exchange_incoming_photo", type: "photo", minimumCount: 1 }
          ]
        })
      ]
    );
    await query(
      `INSERT INTO mbt_visit_steps (
         visit_step_id, service_visit_id, sequence_number, action_code,
         display_name, location_role, expected_asset_id
       ) VALUES
         ($1, $3, 0, 'collect_empty_bin', 'Collect empty exchange bin', 'origin_yard', $4),
         ($2, $3, 1, 'exchange_bin', 'Exchange 14YD bins', 'customer_site', $4)`,
      [collectStepId, exchangeStepId, fixture.frontVisitId, fixture.assetId]
    );
    await query(
      `INSERT INTO mbt_visit_evidence_requirements (
         visit_evidence_requirement_id, service_visit_id, visit_step_id,
         evidence_code, evidence_type, minimum_count, required
       ) VALUES
         ($1, $6, $7, 'collect_outgoing_scan', 'bin_scan', 1, true),
         ($2, $6, $8, 'exchange_outgoing_scan', 'bin_scan', 1, true),
         ($3, $6, $8, 'exchange_incoming_scan', 'bin_scan', 1, true),
         ($4, $6, $8, 'exchange_outgoing_photo', 'photo', 1, true),
         ($5, $6, $8, 'exchange_incoming_photo', 'photo', 1, true)`,
      [
        crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
        crypto.randomUUID(), crypto.randomUUID(), fixture.frontVisitId,
        collectStepId, exchangeStepId
      ]
    );
  });
  return assignAndProject(
    {
      ...fixture,
      scenario: "exchange",
      frontStops: stops,
      incomingAssetId,
      incomingAssetCode
    },
    [
      {
        reservationSlot: "outgoing",
        assetId: fixture.assetId,
        expectedStateRevision: fixture.assetStateRevision
      },
      {
        reservationSlot: "incoming",
        assetId: incomingAssetId,
        expectedStateRevision: 1
      }
    ]
  );
}

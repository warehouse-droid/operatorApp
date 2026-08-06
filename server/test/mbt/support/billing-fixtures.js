// @ts-check

import crypto from "node:crypto";

import { createAssetFixture } from "./asset-fixtures.js";

/** @typedef {import("pg").PoolClient} PoolClient */

/**
 * Build a synthetic, local-only P3.10 graph. It creates no chain, deposit,
 * outbox, attempt, notification, or external transport identity.
 *
 * @param {PoolClient} client
 * @param {{completed?: boolean}} [options]
 */
export async function createBillingFixture(client, options = {}) {
  const asset = await createAssetFixture(client, { assetCount: 1, visitCount: 1 });
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const visitId = asset.visitIds[0];
  const movementId = asset.assets[0].initialMovementId;
  const billingRateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  const rateDistanceBandId = crypto.randomUUID();
  const rentalComponentId = crypto.randomUUID();
  const dumpSiteId = crypto.randomUUID();
  const materialId = crypto.randomUUID();
  const dumpSiteMaterialId = crypto.randomUUID();
  const dumpTariffId = crypto.randomUUID();
  const distanceSnapshotId = crypto.randomUUID();
  const visitStepId = crypto.randomUUID();
  const visitRequirementId = crypto.randomUUID();
  const receiptPhotoEvidenceId = crypto.randomUUID();
  const dumpReceiptId = crypto.randomUUID();
  const billingCaseId = crypto.randomUUID();

  await client.query(
    `INSERT INTO mbt_materials (
       material_id, material_code, display_name, created_by, updated_by
     ) VALUES ($1, $2, $3, 'p3.10-test', 'p3.10-test')`,
    [materialId, `P310-MAT-${suffix}`, `Synthetic P3.10 material ${suffix}`]
  );
  await client.query(
    `INSERT INTO mbt_dump_sites (
       dump_site_id, dump_site_code, display_name, created_by, updated_by
     ) VALUES ($1, $2, $3, 'p3.10-test', 'p3.10-test')`,
    [dumpSiteId, `P310-DUMP-${suffix}`, `Synthetic P3.10 dump ${suffix}`]
  );
  await client.query(
    `INSERT INTO mbt_dump_site_materials (
       dump_site_material_id, dump_site_id, material_id, created_by, updated_by
     ) VALUES ($1, $2, $3, 'p3.10-test', 'p3.10-test')`,
    [dumpSiteMaterialId, dumpSiteId, materialId]
  );
  await client.query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name,
       currency, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', 'p3.10-test', 'p3.10-test')`,
    [
      billingRateCardId,
      `P310-RATE-${suffix}`,
      `Synthetic P3.10 billing rate ${suffix}`
    ]
  );
  await client.query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', '{}'::jsonb, 'p3.10-test', 'p3.10-test')`,
    [rateCardVersionId, billingRateCardId]
  );
  await client.query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code,
       bin_type_id, sequence_number, minimum_metres, maximum_metres,
       amount_minor, currency, description
     ) VALUES (
       $1, $2, 'delivery', '00000000-0000-4000-8000-000000000020',
       0, 0, NULL, 12000, 'CAD', 'Synthetic P3.10 transport'
     )`,
    [rateDistanceBandId, rateCardVersionId]
  );
  await client.query(
    `INSERT INTO mbt_rate_components (
       rate_component_id, rate_card_version_id, component_code,
       component_kind, service_code, bin_type_id, rate_basis,
       amount_minor, currency, taxable, active, description
     ) VALUES (
       $1, $2, 'rental_daily', 'rental', 'delivery',
       '00000000-0000-4000-8000-000000000020', 'per_day',
       700, 'CAD', true, true, 'Synthetic daily rental'
     )`,
    [rentalComponentId, rateCardVersionId]
  );
  await client.query(
    `INSERT INTO mbt_dump_tariffs (
       dump_tariff_id, rate_card_version_id, dump_site_id, material_id,
       tariff_code, pricing_basis, unit_of_measure, amount_minor,
       minimum_amount_minor, currency, active, description
     ) VALUES (
       $1, $2, $3, $4, 'synthetic_tonne', 'per_quantity', 'TONNE',
       2500, 5000, 'CAD', true, 'Synthetic P3.10 dump tariff'
     )`,
    [dumpTariffId, rateCardVersionId, dumpSiteId, materialId]
  );
  await client.query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = 'p3.10-test', updated_at = now()
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  await client.query(
    `UPDATE mbt_contracts
        SET rate_card_version_id = $2,
            tax_snapshot = '{"code":"ON_HST_13","basisPoints":1300}'::jsonb,
            pricing_snapshot = jsonb_build_object('serviceCode', 'delivery'),
            revision = revision + 1,
            updated_by = 'p3.10-test',
            updated_at = now()
      WHERE contract_id = $1`,
    [asset.contractId, rateCardVersionId]
  );
  await client.query(
    `INSERT INTO mbt_distance_snapshots (
       distance_snapshot_id, subject_type, subject_id, rate_card_version_id,
       rate_distance_band_id, provider, provider_metres, route_hash,
       origin_snapshot, destination_snapshot, route_snapshot,
       calculated_amount_minor, currency
     ) VALUES (
       $1, 'visit', $2, $3, $4, 'synthetic_route_engine', 12500, $5,
       $6::jsonb, $7::jsonb, $8::jsonb, 12000, 'CAD'
     )`,
    [
      distanceSnapshotId,
      visitId,
      rateCardVersionId,
      rateDistanceBandId,
      "c".repeat(64),
      JSON.stringify({ kind: "yard", code: asset.yardCode }),
      JSON.stringify({ kind: "customer_site", id: asset.customerSiteProfileId }),
      JSON.stringify({ synthetic: true })
    ]
  );
  await client.query(
    `INSERT INTO mbt_visit_steps (
       visit_step_id, service_visit_id, template_step_id, sequence_number,
       action_code, display_name, location_role, status, started_at, completed_at
     ) VALUES (
       $1, $2, $3, 0, 'dump_bin', 'Synthetic dump', 'dump_site',
       'completed', '2038-01-01T10:00:00.000Z', '2038-01-01T11:00:00.000Z'
     )`,
    [visitStepId, visitId, asset.templateStepId]
  );
  await client.query(
    `INSERT INTO mbt_visit_evidence_requirements (
       visit_evidence_requirement_id, service_visit_id, visit_step_id,
       evidence_code, evidence_type, minimum_count, required, status
     ) VALUES ($1, $2, $3, 'dump_receipt_photo', 'photo', 1, true, 'satisfied')`,
    [visitRequirementId, visitId, visitStepId]
  );
  await client.query(
    `INSERT INTO mbt_evidence (
       evidence_id, service_visit_id, visit_step_id,
       visit_evidence_requirement_id, evidence_type, storage_provider,
       storage_key, content_sha256, mime_type, size_bytes, captured_at,
       recorded_at, captured_by_type, captured_by_id, source,
       review_status, reviewed_by, reviewed_at, metadata
     ) VALUES (
       $1, $2, $3, $4, 'photo', 'synthetic', $5, $6, 'image/jpeg', 128,
       '2038-01-01T10:55:00.000Z', '2038-01-01T11:00:00.000Z',
       'driver', 'synthetic-driver', 'p3.10-test', 'accepted',
       'p3.10-test', '2038-01-01T11:01:00.000Z', '{}'::jsonb
     )`,
    [receiptPhotoEvidenceId, visitId, visitStepId, visitRequirementId, `p310/${suffix}.jpg`, "d".repeat(64)]
  );
  await client.query(
    `INSERT INTO mbt_dump_receipts (
       dump_receipt_id, source_driver_event_id, service_visit_id,
       visit_step_id, dump_site_id, material_id, ticket_number, quantity,
       unit_of_measure, subtotal_minor, tax_minor, total_minor, currency,
       receipt_photo_evidence_id, captured_at, server_received_at,
       recorded_by_driver_login, receipt_snapshot
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 2.000000, 'TONNE',
       4000, 200, 4200, 'CAD', $8,
       '2038-01-01T10:56:00.000Z', '2038-01-01T11:00:00.000Z',
       'synthetic-driver', $9::jsonb
     )`,
    [
      dumpReceiptId,
      crypto.randomUUID(),
      visitId,
      visitStepId,
      dumpSiteId,
      materialId,
      `SYNTHETIC-${suffix}`,
      receiptPhotoEvidenceId,
      JSON.stringify({ synthetic: true, fixture: suffix })
    ]
  );
  if (options.completed !== false) {
    await client.query(
      `UPDATE mbt_service_visits
          SET status = 'completed',
              actual_started_at = '2038-01-01T10:00:00.000Z',
              actual_completed_at = '2038-01-01T11:00:00.000Z',
              revision = revision + 1,
              updated_by = 'p3.10-test',
              updated_at = now()
        WHERE service_visit_id = $1`,
      [visitId]
    );
  }
  const contract = await client.query(
    `SELECT customer_netsuite_id::text AS customer_netsuite_id
       FROM mbt_contracts
      WHERE contract_id = $1`,
    [asset.contractId]
  );
  const movement = await client.query(
    `SELECT occurred_at
       FROM mbt_bin_movements
      WHERE movement_id = $1`,
    [movementId]
  );
  await client.query(
    `INSERT INTO mbt_billing_cases (
       billing_case_id, case_type, contract_id, service_visit_id,
       customer_netsuite_id, status, currency, posting_mode,
       current_version_number, revision, created_by, updated_by
     ) VALUES (
       $1, 'mbt_contract', $2, $3, $4, 'open', 'CAD', 'local_only',
       0, 1, 'p3.10-test', 'p3.10-test'
     )`,
    [billingCaseId, asset.contractId, visitId, contract.rows[0].customer_netsuite_id]
  );

  return {
    ...asset,
    visitId,
    movementId,
    rateCardVersionId,
    rateDistanceBandId,
    rentalComponentId,
    dumpSiteId,
    materialId,
    dumpTariffId,
    distanceSnapshotId,
    dumpReceiptId,
    billingCaseId,
    customerNetsuiteId: String(contract.rows[0].customer_netsuite_id),
    movementManualSnapshot: {
      assetId: asset.assets[0].assetId,
      assetSequence: 1,
      beforeStatus: null,
      afterStatus: "available",
      beforeLocationKind: null,
      beforeLocationReference: null,
      afterLocationKind: "yard",
      afterLocationReference: asset.yardCode,
      truckId: null,
      driverId: null,
      visitId: null,
      occurredAt: new Date(movement.rows[0].occurred_at).toISOString()
    },
    receiptManualSnapshot: {
      ticketNumber: `SYNTHETIC-${suffix}`,
      dumpSiteId,
      materialId,
      weight: null,
      quantity: "2.000000",
      unitOfMeasure: "TONNE",
      subtotalMinor: 4_000,
      taxMinor: 200,
      totalMinor: 4_200,
      currency: "CAD"
    },
    distanceManualSnapshot: {
      origin: { kind: "yard", code: asset.yardCode },
      destination: { kind: "customer_site", id: asset.customerSiteProfileId },
      provider: "synthetic_route_engine",
      rawMetres: 12_500,
      selectedBandId: rateDistanceBandId,
      amountMinor: 12_000,
      currency: "CAD"
    }
  };
}

/** @param {string} identity @param {string[]} [roles] */
export function billingActor(identity, roles = ["mbt_billing"]) {
  return { operatorId: `p3.10-${identity}`, roles };
}

/** @param {ReturnType<typeof createBillingFixture> extends Promise<infer T> ? T : never} fixture @param {string} identity */
export function billingCalculationCommand(fixture, identity) {
  return {
    actor: billingActor(identity),
    billingCaseId: fixture.billingCaseId,
    expectedRevision: 1,
    serviceVisitId: fixture.visitId,
    distanceSnapshotId: fixture.distanceSnapshotId,
    dumpReceiptId: fixture.dumpReceiptId,
    componentQuantities: { rental_daily: "3.000000" },
    customPrices: [],
    reason: "Synthetic P3.10 calculation",
    idempotencyKey: `p3.10-calculate-${identity}`,
    correlationId: `p3.10-correlation-${identity}`,
    requestId: `p3.10-request-${identity}`
  };
}

// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  listMbbsBillingCandidates,
  previewMbbsBillingCandidate
} from "../../../src/mbt/mbbs-billing-candidate-service.js";

const ACTOR = Object.freeze({ operatorId: "mbbs-candidate-test", roles: Object.freeze(["admin"]) });

after(closeDb);

async function installRealMbbsRates() {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_local_item_settings (
       item_code, display_name, description, item_type, rental_period_days,
       category, bin_type_id, pricing_mode, netsuite_mapping_local_key,
       system_owned, applicable_service_types, applicable_legacy_source_types,
       charge_basis, density_lbs_per_yard, active, revision, created_by, updated_by
     ) VALUES (
       'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS', 'Local MBBS delivery charge.',
       'delivery_fee', NULL, 'cross_charge', NULL, 'rate_card',
       'delivery_charge_mbbs', false, ARRAY['delivery']::text[],
       ARRAY['SO','TO','PO','VRMA']::text[], 'distance', NULL, true, 1,
       'mbbs-candidate-test', 'mbbs-candidate-test'
     ) ON CONFLICT (item_code) DO NOTHING`
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
     ) VALUES ($1, 'DELIVERY_CHARGE_MBBS', $2, 'CAD', 'mbbs-candidate-test', 'mbbs-candidate-test')`,
    [rateCardId, `MBBS candidate real rates ${suffix}`]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', '{}'::jsonb, 'mbbs-candidate-test', 'mbbs-candidate-test')`,
    [rateCardVersionId, rateCardId]
  );
  const bands = [
    [0, 0, 30_000, 20_000, "flat"],
    [1, 30_000, 50_000, 25_000, "flat"],
    [2, 50_000, 65_000, 30_000, "flat"],
    [3, 65_000, 75_000, 35_000, "flat"],
    [4, 75_000, null, 700, "per_km"]
  ];
  for (const [sequence, minimum, maximum, amount, basis] of bands) {
    await query(
      `INSERT INTO mbt_rate_distance_bands (
         rate_distance_band_id, rate_card_version_id, item_code,
         service_code, bin_type_id, sequence_number, minimum_metres,
         maximum_metres, amount_minor, currency, description,
         pricing_basis, boundary_rule, origin_yard_codes
       ) VALUES (
         $1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', NULL,
         $3, $4, $5, $6, 'CAD', 'Real MBBS regression band',
         $7, 'upper_inclusive', ARRAY['2967','3445']::text[]
       )`,
      [crypto.randomUUID(), rateCardVersionId, sequence, minimum, maximum, amount, basis]
    );
  }
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = 'mbbs-candidate-test', updated_at = now()
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  return rateCardVersionId;
}

async function localIsolationCounts() {
  const result = await query(
    `SELECT
       (SELECT count(*)::int FROM mbt_mbbs_completed_load_snapshots) AS snapshots,
       (SELECT count(*)::int FROM mbt_cross_charge_cases) AS cases,
       (SELECT count(*)::int FROM mbt_netsuite_outbox) AS outbox,
       (SELECT count(*)::int FROM mbt_netsuite_sales_order_chain) AS chains`
  );
  return result.rows[0];
}

test("completed Driver PWA loads preview the active DELIVERY_CHARGE_MBBS band without operational writes", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const rateCardVersionId = await installRealMbbsRates();
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const orderRef = `SOA${suffix.slice(0, 8)}`;
      const loadId = `LOAD-${suffix}`;
      const salesOrderId = 9_500_000_000 + crypto.randomInt(100_000);
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, fulfillment_status, fulfilled_at, outbound_location,
           dispatch_address, netsuite_active, synced_at
         ) VALUES ($1, $2, 'fulfilled', now(), '2967', $3, true, now())`,
        [salesOrderId, orderRef, "100 Queen Street West, Toronto, ON"]
      );
      await query(
        `INSERT INTO driver_job_records (
           job_id, plan_date, driver_login, truck_id, load_id, load_name,
           stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
         ) VALUES
           ($1, '2038-08-10', 'mbbs-driver', '101', $3, 'Candidate load',
            'PICK', 'pickup', $4::jsonb, 'complete', $5::timestamptz, $6::timestamptz, $7::jsonb),
           ($2, '2038-08-10', 'mbbs-driver', '101', $3, 'Candidate load',
            'DROP', 'dropoff', $4::jsonb, 'complete', $6::timestamptz, $8::timestamptz, $9::jsonb)`,
        [
          `JOB-PICK-${suffix}`,
          `JOB-DROP-${suffix}`,
          loadId,
          JSON.stringify([orderRef]),
          "2038-08-10T10:00:00.000Z",
          "2038-08-10T10:20:00.000Z",
          JSON.stringify({ address: "2967 Kennedy Road, Toronto, ON", pickupLocation: "2967", orderTypes: ["SO"] }),
          "2038-08-10T11:20:00.000Z",
          JSON.stringify({ address: "100 Queen Street West, Toronto, ON", dropAddress: "100 Queen Street West, Toronto, ON", orderTypes: ["SO"] })
        ]
      );
      const starvationBase = 9_700_000_000 + (crypto.randomInt(100_000) * 1_000);
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, fulfillment_status, fulfilled_at,
           outbound_location, dispatch_address, netsuite_active, synced_at
         )
         SELECT $1::bigint + series,
                $2 || series::text,
                'fulfilled',
                '2040-08-10T12:00:00.000Z'::timestamptz,
                'UNMAPPED',
                '1 Incomplete Evidence Road, Toronto, ON',
                true,
                '2040-08-10T12:00:00.000Z'::timestamptz
           FROM generate_series(1, 205) AS series`,
        [starvationBase, `SO-UNMAPPED-${suffix}-`]
      );
      const before = await localIsolationCounts();
      const listed = await listMbbsBillingCandidates({ actor: ACTOR, limit: 200 });
      const candidate = listed.items.find((item) => item.physicalLoadId === loadId);
      assert.ok(
        candidate,
        "a ready Driver PWA candidate must not be starved by newer incomplete Sales Orders"
      );
      assert.equal(candidate?.sourceSystem, "driver_pwa");
      assert.equal(candidate?.chargeable, true);
      assert.deepEqual(candidate?.references, [{ sourceType: "SO", rootReference: orderRef }]);
      const salesOrderCandidate = listed.items.find((item) => item.sourceSystem === "sales_order");
      assert.equal(salesOrderCandidate?.sourceSystem, "sales_order");
      assert.equal(salesOrderCandidate?.references[0]?.sourceType, "SO");

      const calls = [];
      const preview = await previewMbbsBillingCandidate({
        actor: ACTOR,
        candidateId: candidate.candidateId
      }, {
        async resolveDistance(input) {
          calls.push(input);
          return {
            provider: "synthetic_read_only",
            providerMetres: 30_001,
            routeHash: "a".repeat(64),
            originSnapshot: { kind: "yard", yardCode: "2967" },
            destinationSnapshot: { kind: "address" },
            routeSnapshot: { synthetic: true }
          };
        }
      });
      assert.equal(calls[0].originYardCode, "2967");
      assert.equal(preview.rateCardVersionId, rateCardVersionId);
      assert.equal(preview.distanceMetres, 30_001);
      assert.equal(preview.selectedBand.minimumMetres, 30_000);
      assert.equal(preview.charge.amountMinor, 25_000);
      assert.equal(preview.charge.itemCode, "DELIVERY_CHARGE_MBBS");
      assert.equal(preview.postingMode, "local_only_preview");
      assert.equal(preview.externalWork, null);
      assert.deepEqual(await localIsolationCounts(), before);
    });
  } finally {
    await rollback.rollback();
  }
});

test("completed reconciliation orders use the actual-metre per-km band and remain read-only", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await installRealMbbsRates();
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const transferId = 9_600_000_000 + crypto.randomInt(100_000);
      const orderRef = `TO${suffix.slice(0, 8)}`;
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, from_location_id, from_location,
           to_location_id, to_location, fulfillment_status, fulfilled_at,
           netsuite_active, synced_at
         ) VALUES ($1, $2, 28, '2967', 1, '3445', 'fulfilled', now(), true, now())`,
        [transferId, orderRef]
      );
      const state = await query(
        `INSERT INTO scm_reconciliation_order_state (
           order_kind, source_order_netsuite_id, source_order_ref,
           application_status, reconciliation_status, source_location_id,
           source_location, destination_location_id, destination_location,
           order_snapshot, completed_at
         ) VALUES (
           'TO', $1, $2, 'Completed', 'ok', 28, '2967', 1, '3445',
           $3::jsonb, '2038-08-10T13:00:00.000Z'
         ) RETURNING id`,
        [transferId, orderRef, JSON.stringify({ sourceLocation: "2967", destinationLocation: "3445" })]
      );
      const before = await localIsolationCounts();
      const listed = await listMbbsBillingCandidates({ actor: ACTOR, limit: 200 });
      const candidate = listed.items.find((item) => item.sourceRecordId === String(state.rows[0].id));
      assert.equal(candidate?.sourceSystem, "reconciliation");
      assert.deepEqual(candidate?.references, [{ sourceType: "TO", rootReference: orderRef }]);

      const preview = await previewMbbsBillingCandidate({
        actor: ACTOR,
        candidateId: candidate.candidateId
      }, {
        async resolveDistance() {
          return {
            provider: "synthetic_read_only",
            providerMetres: 75_001,
            routeHash: "b".repeat(64),
            originSnapshot: { kind: "yard", yardCode: "2967" },
            destinationSnapshot: { kind: "yard", yardCode: "3445" },
            routeSnapshot: { synthetic: true }
          };
        }
      });
      assert.equal(preview.selectedBand.pricingBasis, "per_km");
      assert.equal(preview.charge.amountMinor, 52_501);
      assert.deepEqual(await localIsolationCounts(), before);
    });
  } finally {
    await rollback.rollback();
  }
});

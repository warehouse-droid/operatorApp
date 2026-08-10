// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";
import { generateMbbsShadowBillingFromSnapshots } from "../../../src/mbt/shadow-billing-service.js";
import { billingActor, createBillingFixture } from "../support/billing-fixtures.js";

after(closeDb);

test("MBBS shadow billing owns the exact active distance-band item instead of the legacy fallback", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const fixture = await createBillingFixture(/** @type {any} */ ({ query }));
      const suffix = crypto.randomUUID().replaceAll("-", "");
      const rateCardId = crypto.randomUUID();
      const rateCardVersionId = crypto.randomUUID();
      const rateDistanceBandId = crypto.randomUUID();
      const completedLoadSnapshotId = crypto.randomUUID();
      const physicalLoadId = `MBBS-ACTIVE-ITEM-${suffix}`;
      const completedAt = "2038-08-10T12:00:00.000Z";
      const references = [{ sourceType: "TO", rootReference: `TO-${suffix}` }];
      const sourceSnapshot = {
        schemaVersion: "mbbs-completed-load-snapshot-v1",
        completed: true,
        physicalLoadId,
        completedAt,
        evidenceIdentity: completedLoadSnapshotId
      };

      await query(
        `INSERT INTO mbt_local_item_settings (
           item_code, display_name, description, item_type, rental_period_days,
           category, bin_type_id, pricing_mode, netsuite_mapping_local_key,
           system_owned, applicable_service_types, applicable_legacy_source_types,
           charge_basis, density_lbs_per_yard, active, revision, created_by, updated_by
         ) VALUES (
           'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS',
           'Local MBBS delivery charge selected by the active rate band.',
           'delivery_fee', NULL, 'cross_charge', NULL, 'rate_card',
           'delivery_charge_mbbs', false, ARRAY['delivery']::text[],
           ARRAY['SO','TO','PO','VRMA']::text[], 'distance', NULL, true, 1, 'mbbs-test', 'mbbs-test'
         ) ON CONFLICT (item_code) DO NOTHING`
      );
      await query(
        `INSERT INTO mbt_rate_cards (
           rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
         ) VALUES ($1, 'DELIVERY_CHARGE_MBBS', $2, 'CAD', 'mbbs-test', 'mbbs-test')`,
        [rateCardId, `MBBS active item regression ${suffix}`]
      );
      await query(
        `INSERT INTO mbt_rate_card_versions (
           rate_card_version_id, rate_card_id, version_number, status,
           validation_snapshot, created_by, updated_by
         ) VALUES ($1, $2, 1, 'draft', '{}'::jsonb, 'mbbs-test', 'mbbs-test')`,
        [rateCardVersionId, rateCardId]
      );
      await query(
        `INSERT INTO mbt_rate_distance_bands (
           rate_distance_band_id, rate_card_version_id, item_code,
           service_code, bin_type_id, sequence_number, minimum_metres,
           maximum_metres, amount_minor, currency, description,
           pricing_basis, boundary_rule, origin_yard_codes
         ) VALUES (
           $1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', NULL,
           0, 0, NULL, 20000, 'CAD', 'MBBS local delivery',
           'flat', 'upper_inclusive', ARRAY[]::text[]
         )`,
        [rateDistanceBandId, rateCardVersionId]
      );
      await query(
        `UPDATE mbt_rate_card_versions
            SET status = 'active', effective_from = now(), activated_at = now(),
                revision = revision + 1, updated_by = 'mbbs-test', updated_at = now()
          WHERE rate_card_version_id = $1`,
        [rateCardVersionId]
      );
      await query(
        `INSERT INTO mbt_mbbs_completed_load_snapshots (
           completed_load_snapshot_id, source_system, source_plan_id,
           source_plan_revision, plan_date, physical_load_id, completed_at,
           truck_id, driver_id, calculated_metres, shared_total_minor, currency,
           source_references, source_snapshot, source_snapshot_hash, created_by
         ) VALUES (
           $1, 'dispatch', $2, 1, '2038-08-10', $3, $4::timestamptz,
           $5, $6, 30000, 20000, 'CAD', $7::jsonb, $8::jsonb, $9, 'mbbs-test'
         )`,
        [
          completedLoadSnapshotId,
          `MBBS-PLAN-${suffix}`,
          physicalLoadId,
          completedAt,
          fixture.truckId,
          fixture.driverId,
          JSON.stringify(references),
          JSON.stringify(sourceSnapshot),
          canonicalSha256(sourceSnapshot)
        ]
      );

      const generated = await generateMbbsShadowBillingFromSnapshots({
        actor: billingActor(`active-item-${suffix}`),
        customerNetsuiteId: fixture.customerNetsuiteId,
        rateCardVersionId,
        rateDistanceBandId,
        completedLoadSnapshotIds: [completedLoadSnapshotId],
        currency: "CAD",
        reason: "Use the exact active MBBS rate-owned item",
        idempotencyKey: `mbbs-active-item-${suffix}`,
        correlationId: `mbbs-active-item-correlation-${suffix}`,
        requestId: `mbbs-active-item-request-${suffix}`
      });
      const line = await query(
        `SELECT local_item_code, net_amount_minor::int AS net_amount_minor
           FROM mbt_billing_lines WHERE billing_version_id = $1`,
        [generated.body.cases[0].billingVersionId]
      );
      assert.deepEqual(line.rows, [{
        local_item_code: "DELIVERY_CHARGE_MBBS",
        net_amount_minor: 20_000
      }]);
      assert.equal(generated.body.postingMode, "local_only");
    });
  } finally {
    await rollback.rollback();
  }
});

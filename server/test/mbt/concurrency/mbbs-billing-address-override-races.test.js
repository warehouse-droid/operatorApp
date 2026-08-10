// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import {
  listMbbsBillingCandidates,
  setMbbsBillingCandidateAddressOverride
} from "../../../src/mbt/mbbs-billing-candidate-service.js";
import { MbtError } from "../../../src/mbt/errors.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "").toUpperCase();
const ACTOR = Object.freeze({
  operatorId: `mbbs-address-race-${RUN_ID}`,
  roles: Object.freeze(["mbt_billing"])
});

after(closeDb);

async function installRateAndMissingAddressOrder() {
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  const netsuiteId = 9_840_000_000 + crypto.randomInt(100_000);
  const tranid = `SO-ADDRESS-RACE-${RUN_ID}`;
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
       ARRAY['SO','TO','PO','VRMA']::text[], 'distance', NULL, true, 1, $1, $1
     ) ON CONFLICT (item_code) DO NOTHING`,
    [ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', $4, $4)`,
    [rateCardId, `MBBS_ADDRESS_RACE_${RUN_ID}`, `MBBS address race ${RUN_ID}`, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', '{}'::jsonb, $3, $3)`,
    [rateCardVersionId, rateCardId, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, item_code,
       service_code, bin_type_id, sequence_number, minimum_metres,
       maximum_metres, amount_minor, currency, description,
       pricing_basis, boundary_rule, origin_yard_codes
     ) VALUES (
       $1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', NULL,
       0, 0, NULL, 12345, 'CAD', 'Concurrent address regression',
       'flat', 'upper_inclusive', ARRAY['2967']::text[]
     )`,
    [crypto.randomUUID(), rateCardVersionId]
  );
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = $2, updated_at = now()
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId, ACTOR.operatorId]
  );
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, fulfillment_status, fulfilled_at, outbound_location,
       dispatch_address, netsuite_active, synced_at
     ) VALUES ($1, $2, 'fulfilled', '2040-02-15T15:00:00.000Z', '2967', NULL, true,
       '2040-02-15T15:00:00.000Z')`,
    [netsuiteId, tranid]
  );
  return { netsuiteId, tranid };
}

test("concurrent billing-only address corrections produce one revision winner and never update the Sales Order", async () => {
  const fixture = await installRateAndMissingAddressOrder();
  const listed = await listMbbsBillingCandidates({
    actor: ACTOR,
    completedMonth: "2040-02",
    limit: 1000
  });
  const candidate = listed.items.find(
    (item) => item.references[0]?.rootReference === fixture.tranid
  );
  assert.ok(candidate);
  assert.equal(candidate.chargeable, false);

  const attempts = Array.from({ length: 8 }, (_, index) => (
    setMbbsBillingCandidateAddressOverride({
      actor: ACTOR,
      candidateId: candidate.candidateId,
      completedMonth: "2040-02",
      destinationAddressText: `${100 + index} Concurrent Street, Toronto, ON M5H 2N2`,
      expectedRevision: 0,
      reason: `Concurrent billing address correction ${index}`,
      idempotencyKey: `mbbs-address-race-${RUN_ID}-${index}`,
      correlationId: `mbbs-address-race-correlation-${RUN_ID}-${index}`,
      requestId: `mbbs-address-race-request-${RUN_ID}-${index}`
    })
  ));
  const outcomes = await Promise.allSettled(attempts);
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.equal(losers.length, 7, JSON.stringify(outcomes));
  assert.ok(losers.every((outcome) => (
    outcome.reason instanceof MbtError
      && outcome.reason.status === 409
      && outcome.reason.code === "MBT_BILLING_ADDRESS_OVERRIDE_REVISION_CONFLICT"
  )));

  const winnerAddress = winners[0].value.body.destinationAddressText;
  const evidence = await query(
    `SELECT
       (SELECT dispatch_address FROM sales_orders WHERE netsuite_id = $1) AS source_address,
       (SELECT count(*)::int FROM mbt_mbbs_billing_address_overrides
         WHERE candidate_id = $2) AS override_count,
       (SELECT max(revision)::int FROM mbt_mbbs_billing_address_overrides
         WHERE candidate_id = $2) AS revision,
       (SELECT max(destination_address_text) FROM mbt_mbbs_billing_address_overrides
         WHERE candidate_id = $2) AS destination_address,
       (SELECT count(*)::int FROM mbt_audit_events
         WHERE action = 'mbt.billing.mbbs_candidate_address.overridden'
           AND entity_id = $2) AS audit_count,
       (SELECT count(*)::int FROM mbt_command_receipts
         WHERE command_name = 'mbt.billing.mbbs_candidate_address.override'
           AND actor_operator_id = $3) AS receipt_count`,
    [fixture.netsuiteId, candidate.candidateId, ACTOR.operatorId]
  );
  assert.deepEqual(evidence.rows[0], {
    source_address: null,
    override_count: 1,
    revision: 1,
    destination_address: winnerAddress,
    audit_count: 1,
    receipt_count: 1
  });
});

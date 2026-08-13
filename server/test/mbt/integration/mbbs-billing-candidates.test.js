// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import {
  listMbbsBillingCandidates,
  previewMbbsBillingCandidate,
  previewMbbsBillingCandidatesBatch,
  setMbbsBillingCandidateAddressOverride
} from "../../../src/mbt/mbbs-billing-candidate-service.js";

const ACTOR = Object.freeze({ operatorId: "mbbs-candidate-test", roles: Object.freeze(["admin"]) });

after(closeDb);

async function installRealMbbsRates({
  rateCardCode = "DELIVERY_CHARGE_MBBS",
  displayName,
  amountsMinor = [20_000, 25_000, 30_000, 35_000, 700],
  originYardCodes = ["2967", "3445"]
} = {}) {
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
     ) VALUES ($1, $2, $3, 'CAD', 'mbbs-candidate-test', 'mbbs-candidate-test')`,
    [rateCardId, rateCardCode, displayName || `MBBS candidate real rates ${suffix}`]
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
  for (const [sequence, minimum, maximum, _amount, basis] of bands) {
    await query(
      `INSERT INTO mbt_rate_distance_bands (
         rate_distance_band_id, rate_card_version_id, item_code,
         service_code, bin_type_id, sequence_number, minimum_metres,
         maximum_metres, amount_minor, currency, description,
         pricing_basis, boundary_rule, origin_yard_codes
       ) VALUES (
         $1, $2, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', NULL,
         $3, $4, $5, $6, 'CAD', 'Real MBBS regression band',
         $7, 'upper_inclusive', $8::text[]
       )`,
      [
        crypto.randomUUID(),
        rateCardVersionId,
        sequence,
        minimum,
        maximum,
        amountsMinor[sequence],
        basis,
        originYardCodes
      ]
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

async function installFulfilledSalesOrder({ netsuiteId, tranid, completedAt, dispatchAddress }) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, fulfillment_status, fulfilled_at, outbound_location,
       sales_order_type, dispatch_address, netsuite_active, synced_at
     ) VALUES ($1, $2, 'fulfilled', $3::timestamptz, '2967', 'Delivery', $4, true, $3::timestamptz)`,
    [netsuiteId, tranid, completedAt, dispatchAddress]
  );
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
           sales_order_type, dispatch_address, netsuite_active, synced_at
         ) VALUES ($1, $2, 'fulfilled', now(), '2967', 'Delivery', $3, true, now())`,
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
           outbound_location, sales_order_type, dispatch_address, netsuite_active, synced_at
         )
         SELECT $1::bigint + series,
                $2 || series::text,
                'fulfilled',
                '2040-08-10T12:00:00.000Z'::timestamptz,
                'UNMAPPED',
                'Delivery',
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
        candidateId: candidate.candidateId,
        rateCardVersionId
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
      const rateCardVersionId = await installRealMbbsRates();
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
        candidateId: candidate.candidateId,
        rateCardVersionId
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

test("completed-month filtering uses Toronto boundaries and exposes every eligible active MBBS rate card", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const standardVersionId = await installRealMbbsRates({ displayName: "Standard MBBS delivery" });
      const premiumCode = `MBBS_PREMIUM_${suffix}`;
      const premiumVersionId = await installRealMbbsRates({
        rateCardCode: premiumCode,
        displayName: "Premium MBBS delivery",
        amountsMinor: [41_000, 42_000, 43_000, 44_000, 900],
        originYardCodes: ["3445"]
      });
      const inactiveCode = `MBBS_INACTIVE_${suffix}`;
      const inactiveVersionId = await installRealMbbsRates({
        rateCardCode: inactiveCode,
        displayName: "Inactive MBBS delivery"
      });
      await query("UPDATE mbt_rate_cards SET active = false WHERE rate_card_code = $1", [inactiveCode]);

      const base = 9_810_000_000 + (crypto.randomInt(100_000) * 10);
      const orders = [
        [base + 1, `SO-BEFORE-${suffix}`, "2038-03-01T04:59:59.999Z", "Before Toronto March"],
        [base + 2, `SO-START-${suffix}`, "2038-03-01T05:00:00.000Z", "Start Toronto March"],
        [base + 3, `SO-END-${suffix}`, "2038-04-01T03:59:59.999Z", "End Toronto March"],
        [base + 4, `SO-AFTER-${suffix}`, "2038-04-01T04:00:00.000Z", "After Toronto March"]
      ];
      for (const [netsuiteId, tranid, completedAt, dispatchAddress] of orders) {
        await installFulfilledSalesOrder({ netsuiteId, tranid, completedAt, dispatchAddress });
      }

      const listed = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedMonth: "2038-03",
        limit: 201
      });
      const references = listed.items
        .flatMap((item) => item.references)
        .map((reference) => reference.rootReference)
        .filter((reference) => reference.endsWith(suffix));
      assert.deepEqual(references.sort(), [`SO-END-${suffix}`, `SO-START-${suffix}`].sort());
      assert.equal(listed.completedMonth, "2038-03");
      assert.deepEqual(
        listed.rateOptions
          .filter((option) => [standardVersionId, premiumVersionId, inactiveVersionId]
            .includes(option.rateCardVersionId))
          .map((option) => ({
            rateCardVersionId: option.rateCardVersionId,
            rateCardCode: option.rateCardCode,
            displayName: option.displayName,
            versionNumber: option.versionNumber,
            currency: option.currency
          })),
        [
          {
            rateCardVersionId: premiumVersionId,
            rateCardCode: premiumCode,
            displayName: "Premium MBBS delivery",
            versionNumber: 1,
            currency: "CAD"
          },
          {
            rateCardVersionId: standardVersionId,
            rateCardCode: "DELIVERY_CHARGE_MBBS",
            displayName: "Standard MBBS delivery",
            versionNumber: 1,
            currency: "CAD"
          }
        ]
      );

      const selectedCandidate = listed.items.find(
        (item) => item.references[0]?.rootReference === `SO-START-${suffix}`
      );
      assert.equal(selectedCandidate.chargeable, true, "another active graph keeps the candidate selectable");
      let premiumResolverCalls = 0;
      const premiumPreview = await previewMbbsBillingCandidate({
        actor: ACTOR,
        candidateId: selectedCandidate.candidateId,
        completedMonth: "2038-03",
        rateCardVersionId: premiumVersionId
      }, {
        async resolveDistance() {
          premiumResolverCalls += 1;
          return { providerMetres: 30_001 };
        }
      });
      assert.equal(premiumPreview.charge.amountMinor, 42_000);
      assert.equal(premiumResolverCalls, 1, "a retained two-address route uses the explicitly selected rate");

      const premiumBatch = await previewMbbsBillingCandidatesBatch({
        actor: ACTOR,
        candidateIds: [selectedCandidate.candidateId],
        completedMonth: "2038-03",
        rateCardVersionId: premiumVersionId
      }, {
        async resolveDistance() {
          premiumResolverCalls += 1;
          return { providerMetres: 30_001 };
        }
      });
      assert.equal(premiumBatch.failureCount, 0);
      assert.equal(premiumBatch.results[0].charge.amountMinor, 42_000);
      assert.equal(premiumResolverCalls, 2);

      const preview = await previewMbbsBillingCandidate({
        actor: ACTOR,
        candidateId: selectedCandidate.candidateId,
        completedMonth: "2038-03",
        rateCardVersionId: standardVersionId
      }, {
        async resolveDistance() {
          return { providerMetres: 30_001 };
        }
      });
      assert.equal(preview.rateCardVersionId, standardVersionId);
      assert.equal(preview.charge.amountMinor, 25_000);

      await assert.rejects(
        listMbbsBillingCandidates({ actor: ACTOR, completedMonth: "2038-3", limit: 25 }),
        (error) => error?.code === "MBT_BILLING_COMPLETED_MONTH_INVALID"
      );
      await assert.rejects(
        previewMbbsBillingCandidate({
          actor: ACTOR,
          candidateId: selectedCandidate.candidateId,
          completedMonth: "2038-03"
        }, { async resolveDistance() { return { providerMetres: 30_001 }; } }),
        (error) => error?.code === "MBT_MBBS_RATE_SELECTION_REQUIRED"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

test("a missing destination can be fixed by an audited billing-only override without changing operational evidence", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const rateCardVersionId = await installRealMbbsRates({ displayName: "Address override MBBS delivery" });
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const netsuiteId = 9_815_000_000 + crypto.randomInt(100_000);
      const tranid = `SO-MISSING-${suffix}`;
      await installFulfilledSalesOrder({
        netsuiteId,
        tranid,
        completedAt: "2038-06-15T15:00:00.000Z",
        dispatchAddress: null
      });
      const initial = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedMonth: "2038-06",
        limit: 200
      });
      const candidate = initial.items.find((item) => item.references[0]?.rootReference === tranid);
      assert.equal(candidate?.chargeable, false);
      assert.match(candidate?.reason || "", /dispatch address/iu);
      assert.equal(candidate?.addressOverride, null);

      const command = {
        actor: ACTOR,
        candidateId: candidate.candidateId,
        completedMonth: "2038-06",
        destinationAddressText: "200 King Street West, Toronto, ON M5H 3T4",
        expectedRevision: 0,
        reason: "Customer confirmed the billing route destination",
        idempotencyKey: `address-${suffix}`,
        correlationId: `correlation-${suffix}`,
        requestId: `request-${suffix}`
      };
      const saved = await setMbbsBillingCandidateAddressOverride(command);
      assert.equal(saved.status, 200);
      assert.equal(saved.replayed, false);
      assert.equal(saved.body.candidateId, candidate.candidateId);
      assert.equal(saved.body.destinationAddressText, command.destinationAddressText);
      assert.equal(saved.body.revision, 1);
      assert.equal(saved.body.postingMode, "local_only");

      const listed = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedMonth: "2038-06",
        limit: 200
      });
      const corrected = listed.items.find((item) => item.candidateId === candidate.candidateId);
      assert.equal(corrected?.chargeable, true);
      assert.equal(corrected?.destinationLabel, command.destinationAddressText);
      assert.deepEqual(corrected?.addressOverride, {
        destinationAddressText: command.destinationAddressText,
        revision: 1,
        updatedBy: ACTOR.operatorId,
        updatedAt: corrected.addressOverride.updatedAt
      });
      assert.match(corrected?.addressOverride.updatedAt || "", /^20[0-9]{2}-/u);

      let resolvedInput;
      const preview = await previewMbbsBillingCandidate({
        actor: ACTOR,
        candidateId: candidate.candidateId,
        completedMonth: "2038-06",
        rateCardVersionId
      }, {
        async resolveDistance(input) {
          resolvedInput = input;
          return { providerMetres: 30_001 };
        }
      });
      assert.equal(resolvedInput.destinationAddressText, command.destinationAddressText);
      assert.equal(preview.charge.amountMinor, 25_000);

      const evidence = await query(
        `SELECT
           (SELECT dispatch_address FROM sales_orders WHERE netsuite_id = $1) AS source_address,
           (SELECT count(*)::int FROM mbt_mbbs_billing_address_overrides WHERE candidate_id = $2) AS override_count,
           (SELECT count(*)::int FROM mbt_audit_events
             WHERE action = 'mbt.billing.mbbs_candidate_address.overridden' AND entity_id = $2) AS audit_count,
           (SELECT count(*)::int FROM mbt_command_receipts
             WHERE command_name = 'mbt.billing.mbbs_candidate_address.override'
               AND actor_operator_id = $3 AND idempotency_key = $4) AS receipt_count`,
        [netsuiteId, candidate.candidateId, ACTOR.operatorId, command.idempotencyKey]
      );
      assert.deepEqual(evidence.rows[0], {
        source_address: null,
        override_count: 1,
        audit_count: 1,
        receipt_count: 1
      });

      const replay = await setMbbsBillingCandidateAddressOverride(command);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.body, saved.body);
      await assert.rejects(
        setMbbsBillingCandidateAddressOverride({
          ...command,
          destinationAddressText: "300 Front Street West, Toronto, ON",
          idempotencyKey: `stale-address-${suffix}`
        }),
        (error) => error?.code === "MBT_BILLING_ADDRESS_OVERRIDE_REVISION_CONFLICT"
      );
      const replayEvidence = await query(
        `SELECT
           (SELECT count(*)::int FROM mbt_mbbs_billing_address_overrides WHERE candidate_id = $1) AS override_count,
           (SELECT count(*)::int FROM mbt_audit_events
             WHERE action = 'mbt.billing.mbbs_candidate_address.overridden' AND entity_id = $1) AS audit_count`,
        [candidate.candidateId]
      );
      assert.deepEqual(replayEvidence.rows[0], { override_count: 1, audit_count: 1 });
    });
  } finally {
    await rollback.rollback();
  }
});

test("a selected rate calculates 100 completed orders as one bounded read-only batch with per-row failures", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await installRealMbbsRates({ displayName: "Standard MBBS delivery" });
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const batchVersionId = await installRealMbbsRates({
        rateCardCode: `MBBS_BATCH_${suffix}`,
        displayName: "Batch-selected MBBS delivery",
        amountsMinor: [41_000, 42_000, 43_000, 44_000, 900]
      });
      const base = 9_820_000_000 + (crypto.randomInt(100_000) * 1_000);
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, fulfillment_status, fulfilled_at, outbound_location,
           sales_order_type, dispatch_address, netsuite_active, synced_at
         )
         SELECT $1::bigint + series,
                $2 || lpad(series::text, 3, '0'),
                'fulfilled',
                '2039-07-15T14:00:00.000Z'::timestamptz + (series * interval '1 minute'),
                '2967',
                'Delivery',
                'MBBS Batch ' || series::text || ', Toronto, ON',
                true,
                '2039-07-15T14:00:00.000Z'::timestamptz + (series * interval '1 minute')
           FROM generate_series(1, 100) AS series`,
        [base, `SO-BATCH-${suffix}-`]
      );
      const listed = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedMonth: "2039-07",
        limit: 200
      });
      const selected = listed.items.filter(
        (item) => item.references[0]?.rootReference.startsWith(`SO-BATCH-${suffix}-`)
      );
      assert.equal(selected.length, 100);
      const candidateIds = selected.map((candidate) => candidate.candidateId).reverse();
      const before = await localIsolationCounts();
      let inFlight = 0;
      let maximumInFlight = 0;
      let distanceCalls = 0;
      const distances = [30_000, 30_001, 50_001, 65_001, 75_001];

      const batch = await previewMbbsBillingCandidatesBatch({
        actor: ACTOR,
        candidateIds,
        completedMonth: "2039-07",
        rateCardVersionId: batchVersionId
      }, {
        async resolveDistance(input) {
          distanceCalls += 1;
          inFlight += 1;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          try {
            await Promise.resolve();
            const index = Number(/MBBS Batch ([0-9]+)/u.exec(input.destinationAddressText)?.[1]);
            if (index === 17) {
              throw new Error("Synthetic route lookup failure");
            }
            return { provider: "synthetic_read_only", providerMetres: distances[index % distances.length] };
          } finally {
            inFlight -= 1;
          }
        }
      });

      assert.equal(batch.schemaVersion, "mbbs-billing-candidate-batch-preview-v1");
      assert.equal(batch.postingMode, "local_only_preview");
      assert.equal(batch.externalWork, null);
      assert.equal(batch.completedMonth, "2039-07");
      assert.equal(batch.rateCardVersionId, batchVersionId);
      assert.equal(batch.requestedCount, 100);
      assert.equal(batch.successCount, 99);
      assert.equal(batch.failureCount, 1);
      assert.deepEqual(batch.results.map((result) => result.candidateId), candidateIds);
      assert.equal(batch.results.filter((result) => result.status === "calculated").length, 99);
      assert.equal(batch.results.filter((result) => result.status === "failed").length, 1);
      assert.equal(batch.results.find((result) => result.status === "failed")?.error.code, "MBT_MBBS_DISTANCE_LOOKUP_FAILED");
      assert.deepEqual(
        [...new Set(batch.results
          .filter((result) => result.status === "calculated")
          .map((result) => result.charge.amountMinor))].sort((left, right) => left - right),
        [41_000, 42_000, 43_000, 44_000, 67_501]
      );
      assert.equal(distanceCalls, 100);
      assert.ok(maximumInFlight > 1, "the batch should make safe parallel progress");
      assert.ok(maximumInFlight <= 5, "distance resolution concurrency must stay bounded");
      assert.deepEqual(await localIsolationCounts(), before);

      await assert.rejects(
        previewMbbsBillingCandidatesBatch({
          actor: ACTOR,
          candidateIds: [candidateIds[0], candidateIds[0]],
          completedMonth: "2039-07",
          rateCardVersionId: batchVersionId
        }, { async resolveDistance() { return { providerMetres: 1 }; } }),
        (error) => error?.code === "MBT_BILLING_CANDIDATE_BATCH_DUPLICATE"
      );
      await assert.rejects(
        previewMbbsBillingCandidatesBatch({
          actor: ACTOR,
          candidateIds: [],
          completedMonth: "2039-07",
          rateCardVersionId: batchVersionId
        }, { async resolveDistance() { return { providerMetres: 1 }; } }),
        (error) => error?.code === "MBT_BILLING_CANDIDATE_BATCH_INVALID"
      );
      await assert.rejects(
        previewMbbsBillingCandidatesBatch({
          actor: ACTOR,
          candidateIds: Array.from({ length: 101 }, () => candidateIds[0]),
          completedMonth: "2039-07",
          rateCardVersionId: batchVersionId
        }, { async resolveDistance() { return { providerMetres: 1 }; } }),
        (error) => error?.code === "MBT_BILLING_CANDIDATE_BATCH_INVALID"
      );
    });
  } finally {
    await rollback.rollback();
  }
});

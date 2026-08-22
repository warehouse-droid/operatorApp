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
      const candidate = listed.items.find((item) => (
        item.sourceSystem === "driver_pwa" && item.driverLoadIds.includes(loadId)
      ));
      assert.ok(
        candidate,
        "a ready Driver PWA candidate must not be starved by newer incomplete Sales Orders"
      );
      assert.equal(candidate?.sourceSystem, "driver_pwa");
      assert.equal(candidate?.chargeable, true);
      assert.deepEqual(candidate?.references, [{ sourceType: "SO", rootReference: orderRef }]);
      assert.deepEqual(candidate?.driverLoadNumbers, ["Candidate load"]);
      assert.equal(candidate?.billingRule, "so_order");
      assert.match(candidate?.relationship.summary, /charged independently/i);
      const duplicateSalesOrderCandidate = listed.items.find((item) => (
        item.sourceSystem === "sales_order"
        && item.references.some((reference) => reference.rootReference === orderRef)
      ));
      assert.equal(duplicateSalesOrderCandidate, undefined);

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
    // eslint-disable-next-line complexity
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
      assert.equal(candidate?.chargeable, true);
      assert.match(candidate?.reason || "", /dispatch address/iu);
      assert.match(candidate?.automaticRateWarning || "", /dispatch address/iu);
      assert.equal(candidate?.addressOverride, null);

      const command = {
        actor: ACTOR,
        candidateId: candidate.candidateId,
        completedMonth: "2038-06",
        originAddressText: "150 Clark Boulevard, Brampton, ON L6T 4A8",
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
      assert.equal(saved.body.originAddressText, command.originAddressText);
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
      assert.equal(corrected?.automaticRateWarning, null);
      assert.equal(corrected?.originLabel, command.originAddressText);
      assert.equal(corrected?.destinationLabel, command.destinationAddressText);
      assert.deepEqual(corrected?.addressOverride, {
        originAddressText: command.originAddressText,
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
      assert.equal(resolvedInput.originAddressText, command.originAddressText);
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

test("a selected rate calculates 100 completed orders and retains an unroutable row for manual billing", async () => {
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
      assert.equal(batch.successCount, 100);
      assert.equal(batch.manualRequiredCount, 1);
      assert.equal(batch.failureCount, 0);
      assert.deepEqual(batch.results.map((result) => result.candidateId), candidateIds);
      assert.equal(batch.results.filter((result) => result.status === "calculated").length, 99);
      assert.equal(batch.results.filter((result) => result.status === "manual_required").length, 1);
      assert.equal(batch.results.find((result) => result.status === "manual_required")?.automaticRate.code, "MBT_MBBS_DISTANCE_LOOKUP_FAILED");
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

test("an authoritative historical SO group is one charge with child evidence and never routes through its placeholder", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const rateCardVersionId = await installRealMbbsRates();
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const base = 9_850_000_000 + (crypto.randomInt(10_000) * 10);
      const salesRefs = [`SOA${suffix.slice(0, 7)}`, `SOM${suffix.slice(7, 14)}`];
      const groupRef = `GOA-${suffix.slice(0, 7)}-${suffix.slice(7, 14)}`;
      const transferRef = `TOB${suffix.slice(14, 21)}`;
      const purchaseRefs = [`#${suffix.slice(21, 27)}A`, `#${suffix.slice(21, 27)}B`];
      const loadId = `MIXED-${suffix}`;
      const splitLoadId = `MIXED-SPLIT-${suffix}`;
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, fulfillment_status, outbound_location,
           sales_order_type, dispatch_address, netsuite_active, synced_at
         ) VALUES
           ($1, $2, 'not_fulfilled', '12441', 'Delivery', $3, true, now()),
           ($4, $5, 'not_fulfilled', '12441', 'Delivery', $6, true, now())`,
        [base + 1, salesRefs[0], "1 Alpha Street, Toronto, ON", base + 2, salesRefs[1], "2 Bravo Street, Toronto, ON"]
      );
      const plan = await query(
        `INSERT INTO dispatch_plans (plan_date, status, note)
         VALUES ('2038-11-10', 'confirmed', $1)
         RETURNING id::text`,
        [`MBBS grouped billing ${suffix}`]
      );
      await query(
        `INSERT INTO dispatch_delivery_groups (
           group_ref, plan_id, plan_date, order_type, truck_plate, load_name, active
         ) VALUES ($1, $2::bigint, '2038-11-10', 'sales_order', 'TEST', 'Load 3', true)`,
        [groupRef, plan.rows[0].id]
      );
      for (const [position, reference] of salesRefs.entries()) {
        await query(
          `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
           VALUES ($1, $2, $3)`,
          [groupRef, reference, position]
        );
      }
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, from_location_id, from_location,
           to_location_id, to_location, fulfillment_status, netsuite_active, synced_at
         ) VALUES ($1, $2, 15, '12441', 5, '150', 'fulfilled', true, now())`,
        [base + 3, transferRef]
      );
      const vendorYard = `Mixed Vendor ${suffix}`;
      const vendorAddress = "1273 North Service Rd E, Oakville, ON";
      await query(
        `INSERT INTO dispatch_vendor_yards (vendor, yard, aliases, address, active)
         VALUES ($1, $1, '', $2, true)`,
        [vendorYard, vendorAddress]
      );
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, dispatch_ref, vendor, dispatch_vendor_yard,
           destination_location_id, destination_location, receipt_status,
           netsuite_active, synced_at
         ) VALUES
           ($1, $2, $3, $7, $7, 1, '3445', 'received', true, now()),
           ($4, $5, $6, $7, $7, 1, '3445', 'received', true, now())`,
        [
          base + 4,
          `POB${suffix.slice(0, 7)}A`,
          purchaseRefs[0],
          base + 5,
          `POB${suffix.slice(0, 7)}B`,
          purchaseRefs[1],
          vendorYard
        ]
      );
      const order = (orderRef, orderType, source = "delivery") => ({ orderRef, orderType, source });
      const records = [
        [loadId, "Load 3", "yard-pick", "pickup", [...salesRefs, transferRef], "12441 Woodbine Avenue", [
          order(salesRefs[0], "SALES_ORDER"),
          order(salesRefs[1], "SALES_ORDER"),
          order(transferRef, "TRANSFER_ORDER")
        ]],
        [loadId, "Load 3", "grouped-so", "dropoff", salesRefs, groupRef, [
          order(salesRefs[0], "SALES_ORDER"), order(salesRefs[1], "SALES_ORDER")
        ]],
        [loadId, "Load 3", "to-drop", "dropoff", [transferRef], "150 Clark Boulevard", [order(transferRef, "TRANSFER_ORDER")]],
        [loadId, "Load 3", "vendor-pick-a", "pickup", [purchaseRefs[0]], vendorAddress, [order(purchaseRefs[0], "PURCHASE_ORDER", "receiving")]],
        [loadId, "Load 3", "po-drop-a", "dropoff", [purchaseRefs[0]], "3445 Kennedy Road", [order(purchaseRefs[0], "PURCHASE_ORDER", "receiving")]],
        [splitLoadId, "Load 4", "vendor-pick-b", "pickup", [purchaseRefs[1]], vendorAddress, [order(purchaseRefs[1], "PURCHASE_ORDER", "receiving")]],
        [splitLoadId, "Load 4", "po-drop-b", "dropoff", [purchaseRefs[1]], "3445 Kennedy Road", [order(purchaseRefs[1], "PURCHASE_ORDER", "receiving")]]
      ];
      for (const [index, [recordLoadId, loadName, stopId, stopType, orderRefs, address, orders]] of records.entries()) {
        await query(
          `INSERT INTO driver_job_records (
             job_id, plan_id, plan_date, driver_login, truck_id, load_id, load_name,
             stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
           ) VALUES ($1, $2::bigint, '2038-11-10', 'mixed-driver', '101', $3, $4,
                     $5, $6, $7::jsonb, 'complete',
                     ('2038-11-10T10:00:00Z'::timestamptz + ($8 * interval '10 minutes')),
                     ('2038-11-10T10:05:00Z'::timestamptz + ($8 * interval '10 minutes')),
                     $9::jsonb)`,
          [
            `JOB-${suffix}-${index}`,
            plan.rows[0].id,
            recordLoadId,
            loadName,
            stopId,
            stopType,
            JSON.stringify(orderRefs),
            index,
            JSON.stringify({ address, orders, physicalVisitStopIds: [stopId] })
          ]
        );
      }
      const listed = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedDate: "2038-11-10",
        search: suffix.slice(0, 7),
        limit: 100
      });
      const retainedLoadIds = new Set([loadId, splitLoadId]);
      const driverCandidates = listed.items.filter((candidate) => candidate.driverLoadIds?.some((id) => retainedLoadIds.has(id)));
      assert.equal(driverCandidates.length, 4);
      assert.deepEqual(
        driverCandidates.map((candidate) => candidate.billingRule).sort(),
        ["po_shared_leg", "po_shared_leg", "so_group", "to_replenishment"].sort()
      );
      assert.ok(driverCandidates.filter((candidate) => candidate.billingRule !== "po_shared_leg")
        .every((candidate) => candidate.references.length === 1));
      const poCandidates = driverCandidates.filter((candidate) => candidate.billingRule === "po_shared_leg");
      assert.deepEqual(
        poCandidates.flatMap((candidate) => candidate.references.map((reference) => reference.rootReference)).sort(),
        [...purchaseRefs].sort()
      );
      assert.deepEqual(poCandidates.map((candidate) => candidate.driverLoadIds).sort(), [[loadId], [splitLoadId]].sort());
      assert.deepEqual(poCandidates.map((candidate) => candidate.driverLoadNumbers[0]).sort(), ["Load 3", "Load 4"]);
      assert.ok(poCandidates.every((candidate) => /immutable Driver load/iu.test(candidate.relationship.summary || "")));
      const groupedSales = driverCandidates.find((candidate) => candidate.billingRule === "so_group");
      assert.deepEqual(groupedSales?.references, [{ sourceType: "SO", rootReference: groupRef }]);
      assert.deepEqual(groupedSales?.memberReferences, salesRefs.map((rootReference) => ({ sourceType: "SO", rootReference })));
      assert.equal(groupedSales?.destinationLabel, "1 Alpha Street, Toronto, ON");
      assert.ok(driverCandidates.every((candidate) => !candidate.routeStops.some((stop) => stop.addressText === groupRef)));
      const routeInputs = [];
      const preview = await previewMbbsBillingCandidatesBatch({
        actor: ACTOR,
        candidateIds: driverCandidates.map((candidate) => candidate.candidateId),
        completedMonth: "2038-11",
        completedDate: "2038-11-10",
        rateCardVersionId
      }, {
        async resolveDistance(input) {
          routeInputs.push(input);
          assert.doesNotMatch(JSON.stringify(input), /PLACEHOLDER/u);
          return { provider: "mixed-load-test", providerMetres: 12_000 };
        }
      });
      assert.equal(preview.successCount, 4);
      assert.equal(preview.failureCount, 0);
      assert.equal(routeInputs.length, 4);
    });
  } finally {
    await rollback.rollback();
  }
});

test("an active SCM PO group becomes one Driver billing order with all child POs retained", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const rateCardVersionId = await installRealMbbsRates();
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const base = 9_860_000_000 + (crypto.randomInt(10_000) * 10);
      const references = [`30${suffix.slice(0, 8)}`, `30${suffix.slice(8, 16)}`];
      const groupRef = `PGOB-${references.join("-")}`;
      const vendorYard = `PO Group Vendor ${suffix}`;
      const vendorAddress = "2977 Cedar Creek Road, Ayr, ON N0B 1E0";
      await query(
        `INSERT INTO dispatch_vendor_yards (vendor, yard, aliases, address, active)
         VALUES ($1, $1, '', $2, true)`,
        [vendorYard, vendorAddress]
      );
      for (const [index, reference] of references.entries()) {
        await query(
          `INSERT INTO purchase_orders (
             netsuite_id, tranid, dispatch_ref, vendor, dispatch_vendor_yard,
             destination_location_id, destination_location, receipt_status,
             netsuite_active, synced_at
           ) VALUES ($1, $2, $2, $3, $3, 1, '3445', 'received', true, now())`,
          [base + index, reference, vendorYard]
        );
      }
      const group = await query(
        `INSERT INTO scm_schedule_groups (group_ref, status, created_by, details)
         VALUES ($1, 'active', $2, $3::jsonb)
         RETURNING id::text`,
        [groupRef, ACTOR.operatorId, JSON.stringify({ memberRefs: references })]
      );
      for (const reference of references) {
        await query(
          `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
           VALUES ($1::bigint, 'PO', $2)`,
          [group.rows[0].id, reference]
        );
      }
      for (const [index, reference] of references.entries()) {
        const loadId = `PO-GROUP-${suffix}-${index}`;
        const order = [{ orderRef: reference, orderType: "PURCHASE_ORDER", source: "receiving" }];
        await query(
          `INSERT INTO driver_job_records (
             job_id, plan_date, driver_login, truck_id, load_id, load_name,
             stop_id, stop_type, order_refs, status, started_at, completed_at, job_details
           ) VALUES
             ($1, '2038-12-10', 'po-group-driver', '101', $3, $4,
              $5, 'pickup', $7::jsonb, 'complete', $8::timestamptz, $9::timestamptz, $10::jsonb),
             ($2, '2038-12-10', 'po-group-driver', '101', $3, $4,
              $6, 'dropoff', $7::jsonb, 'complete', $9::timestamptz, $11::timestamptz, $12::jsonb)`,
          [
            `JOB-PO-GROUP-PICK-${suffix}-${index}`,
            `JOB-PO-GROUP-DROP-${suffix}-${index}`,
            loadId,
            `Load ${index + 1}`,
            `PICK-${index}`,
            `DROP-${index}`,
            JSON.stringify([reference]),
            `2038-12-10T1${index}:00:00.000Z`,
            `2038-12-10T1${index}:10:00.000Z`,
            JSON.stringify({ address: vendorAddress, orders: order }),
            `2038-12-10T1${index}:30:00.000Z`,
            JSON.stringify({ address: "3445 Kennedy Road, Toronto, ON", orders: order })
          ]
        );
      }

      const listed = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedDate: "2038-12-10",
        search: suffix,
        limit: 100
      });
      const grouped = listed.items.find((candidate) =>
        candidate.sourceSystem === "driver_pwa"
        && candidate.references[0]?.rootReference === groupRef
      );
      assert.ok(grouped);
      assert.equal(grouped.billingRule, "po_group");
      assert.deepEqual(
        grouped.memberReferences.map((reference) => reference.rootReference).sort(),
        [...references].sort()
      );
      assert.deepEqual(grouped.driverLoadNumbers, ["Load 1", "Load 2"]);
      assert.equal(listed.items.some((candidate) => candidate.references.some((reference) =>
        references.includes(reference.rootReference)
      )), false);
      const preview = await previewMbbsBillingCandidatesBatch({
        actor: ACTOR,
        candidateIds: [grouped.candidateId],
        completedMonth: "2038-12",
        completedDate: "2038-12-10",
        rateCardVersionId
      }, {
        async resolveDistance() {
          return { provider: "po-group-test", providerMetres: 12_000 };
        }
      });
      assert.equal(preview.results[0].status, "calculated");
      assert.equal(preview.results[0].charge.amountMinor, 20_000);
    });
  } finally {
    await rollback.rollback();
  }
});

test("Dispatch pickup and delivery overrides both become Driver-backed billing endpoints", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const rateCardVersionId = await installRealMbbsRates();
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const base = 9_880_000_000 + (crypto.randomInt(10_000) * 10);
      const completedDate = "2041-01-15";
      const orders = [
        {
          type: "SO",
          reference: `SO-${suffix}`,
          loadId: `SO-OVERRIDE-${suffix}`,
          origin: "11 Dispatch SO Pickup Road, Toronto, ON",
          destination: "12 Dispatch SO Delivery Road, Toronto, ON",
          staleOrigin: "11 Old SO Pickup Road, Toronto, ON",
          staleDestination: "12 Old SO Delivery Road, Toronto, ON"
        },
        {
          type: "TO",
          reference: `TO-${suffix}`,
          loadId: `TO-OVERRIDE-${suffix}`,
          origin: "21 Dispatch TO Pickup Road, Toronto, ON",
          destination: "22 Dispatch TO Delivery Road, Toronto, ON",
          staleOrigin: "21 Old TO Pickup Road, Toronto, ON",
          staleDestination: "22 Old TO Delivery Road, Toronto, ON"
        },
        {
          type: "PO",
          reference: `PO-${suffix}`,
          loadId: `PO-OVERRIDE-${suffix}`,
          origin: "31 Dispatch PO Pickup Road, Toronto, ON",
          destination: "32 Dispatch PO Delivery Road, Toronto, ON",
          staleOrigin: "31 Old PO Pickup Road, Toronto, ON",
          staleDestination: "32 Old PO Delivery Road, Toronto, ON"
        }
      ];
      await query(
        `INSERT INTO sales_orders (
           netsuite_id, tranid, fulfillment_status, fulfilled_at,
           outbound_location, sales_order_type, dispatch_pickup_address,
           dispatch_address, dispatch_parse_source, netsuite_active, synced_at
         ) VALUES ($1, $2, 'fulfilled', $3::timestamptz, '2967', 'Delivery',
                   $4, $5, 'manual-dispatch-details', true, $3::timestamptz)`,
        [base + 1, orders[0].reference, `${completedDate}T15:00:00.000Z`, orders[0].origin, orders[0].destination]
      );
      await query(
        `INSERT INTO transfer_orders (
           netsuite_id, tranid, from_location_id, from_location,
           to_location_id, to_location, dispatch_pickup_address,
           dispatch_address, dispatch_parse_source, fulfillment_status,
           netsuite_active, synced_at
         ) VALUES ($1, $2, 4, '150', 5, '2967', $3, $4,
                   'manual-dispatch-details', 'fulfilled', true, now())`,
        [base + 2, orders[1].reference, orders[1].origin, orders[1].destination]
      );
      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, vendor, source_location,
           destination_location_id, destination_location, dispatch_pickup_address,
           dispatch_delivery_address, dispatch_address, receipt_status,
           dispatch_parse_source, netsuite_active, synced_at
         ) VALUES ($1, $2, $3, 'Vendor source', 1, '3445', $4, $5,
                   'Vendor default address', 'received', 'manual-dispatch-details',
                   true, now())`,
        [base + 3, orders[2].reference, `Override vendor ${suffix}`, orders[2].origin, orders[2].destination]
      );
      const orderType = {
        SO: "SALES_ORDER",
        TO: "TRANSFER_ORDER",
        PO: "PURCHASE_ORDER"
      };
      for (const [index, order] of orders.entries()) {
        const details = (address) => JSON.stringify({
          address,
          orders: [{
            orderRef: order.reference,
            orderType: orderType[order.type],
            source: order.type === "PO" ? "receiving" : "delivery"
          }]
        });
        await query(
          `INSERT INTO driver_job_records (
             job_id, plan_date, driver_login, truck_id, load_id, load_name,
             stop_id, stop_type, order_refs, status, started_at, completed_at,
             job_details
           ) VALUES
             ($1, $3::date, 'override-driver', '101', $4, $5, $6, 'pickup',
              $8::jsonb, 'complete', $9::timestamptz, $10::timestamptz, $11::jsonb),
             ($2, $3::date, 'override-driver', '101', $4, $5, $7, 'dropoff',
              $8::jsonb, 'complete', $10::timestamptz, $12::timestamptz, $13::jsonb)`,
          [
            `JOB-${order.type}-OVERRIDE-PICK-${suffix}`,
            `JOB-${order.type}-OVERRIDE-DROP-${suffix}`,
            completedDate,
            order.loadId,
            `${order.type} override load`,
            `${order.type}-PICK`,
            `${order.type}-DROP`,
            JSON.stringify([order.reference]),
            `${completedDate}T${10 + index}:00:00.000Z`,
            `${completedDate}T${10 + index}:10:00.000Z`,
            details(order.staleOrigin),
            `${completedDate}T${10 + index}:30:00.000Z`,
            details(order.staleDestination)
          ]
        );
      }

      const listed = await listMbbsBillingCandidates({
        actor: ACTOR,
        completedDate,
        search: suffix,
        limit: 100
      });
      const retained = orders.map((order) => listed.items.find((candidate) => (
        candidate.sourceSystem === "driver_pwa"
        && candidate.driverLoadIds.includes(order.loadId)
      )));
      assert.ok(retained.every(Boolean));
      for (const [index, candidate] of retained.entries()) {
        assert.equal(candidate.originLabel, orders[index].origin);
        assert.equal(candidate.destinationLabel, orders[index].destination);
      }

      const routed = [];
      const preview = await previewMbbsBillingCandidatesBatch({
        actor: ACTOR,
        candidateIds: retained.map((candidate) => candidate.candidateId),
        completedMonth: "2041-01",
        completedDate,
        rateCardVersionId
      }, {
        async resolveDistance(input) {
          routed.push(input);
          return { provider: "dispatch-override-test", providerMetres: 12_000 };
        }
      });
      assert.equal(preview.successCount, 3);
      assert.deepEqual(
        new Set(routed.map((input) => `${input.originAddressText} -> ${input.destinationAddressText}`)),
        new Set(orders.map((order) => `${order.origin} -> ${order.destination}`))
      );
    });
  } finally {
    await rollback.rollback();
  }
});

// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import * as candidates from "../../../src/mbt/mbbs-billing-candidate-service.js";

const ACTOR = Object.freeze({ operatorId: "mbbs-v3-test", roles: Object.freeze(["admin"]) });

after(closeDb);

async function inRollback(operation) {
  const rollback = await beginRollbackContext();
  try {
    return await rollback.run(operation);
  } finally {
    await rollback.rollback();
  }
}

async function installRateGraph({ originYardCodes = ["2967"] } = {}) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  const bandIds = [crypto.randomUUID(), crypto.randomUUID()];
  await query(
    `INSERT INTO mbt_local_item_settings (
       item_code, display_name, description, item_type, category,
       pricing_mode, netsuite_mapping_local_key, system_owned,
       applicable_service_types, applicable_legacy_source_types,
       charge_basis, active, revision, created_by, updated_by
     ) VALUES (
       'DELIVERY_CHARGE_MBBS', 'Delivery Charge MBBS', 'Local MBBS delivery charge.',
       'delivery_fee', 'cross_charge', 'rate_card', 'delivery_charge_mbbs', false,
       ARRAY['delivery']::text[], ARRAY['SO','TO','PO','VRMA']::text[],
       'distance', true, 1, 'mbbs-v3-test', 'mbbs-v3-test'
     ) ON CONFLICT (item_code) DO NOTHING`
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, currency, created_by, updated_by
     ) VALUES ($1, $2, $3, 'CAD', 'mbbs-v3-test', 'mbbs-v3-test')`,
    [rateCardId, `MBBS_V3_${suffix}`, `MBBS V3 ${suffix}`]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, activated_at, validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', NULL, NULL, '{}'::jsonb, 'mbbs-v3-test', 'mbbs-v3-test')`,
    [rateCardVersionId, rateCardId]
  );
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, item_code, service_code,
       sequence_number, minimum_metres, maximum_metres, amount_minor, currency,
       description, pricing_basis, boundary_rule, origin_yard_codes
     ) VALUES
       ($1, $3, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', 0, 0, 30000,
        20000, 'CAD', 'Short route', 'flat', 'upper_inclusive', $4::text[]),
       ($2, $3, 'DELIVERY_CHARGE_MBBS', 'mbbs_cross_charge', 1, 30000, NULL,
        25000, 'CAD', 'Long route', 'flat', 'upper_inclusive', $4::text[])`,
    [bandIds[0], bandIds[1], rateCardVersionId, originYardCodes]
  );
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_at = now()
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  return { rateCardId, rateCardVersionId, bandIds };
}

async function insertSalesOrder({ id, reference, completedAt, method, address, customer = "V3 customer" }) {
  await query(
    `INSERT INTO sales_orders (
       netsuite_id, tranid, customer, fulfillment_status, fulfilled_at,
       outbound_location, sales_order_type, dispatch_address, netsuite_active, synced_at
     ) VALUES ($1, $2, $3, 'fulfilled', $4::timestamptz,
               '2967', $5, $6, true, $4::timestamptz)`,
    [id, reference, customer, completedAt, method, address]
  );
}

async function insertCustomer({ id, suffix }) {
  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, $3, 'CAD', now(), $4, $5)`,
    [id, `V3-${suffix}`, `V3 billing customer ${suffix}`, `v3-${suffix}`, "a".repeat(64)]
  );
}

test("S2/S3: a completed PO calculates vendor-to-MBBS from two retained addresses without origin-scope rejection", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph({ originYardCodes: ["2967"] });
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const purchaseId = 9_910_000_000 + crypto.randomInt(100_000);
    const reference = `PO-V3-${suffix}`;
    const vendorYard = `V3 Vendor Yard ${suffix}`;
    const vendorAddress = "2977 Cedar Creek Road, Ayr, ON N0B 1E0";
    await query(
      `INSERT INTO dispatch_vendor_yards (
         vendor, yard, aliases, address, active
       ) VALUES ($1, $2, '', $3, true)`,
      [`V3 Vendor ${suffix}`, vendorYard, vendorAddress]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, vendor, destination_location_id, destination_location,
         dispatch_vendor_yard, dispatch_address, receipt_status, netsuite_active, synced_at
       ) VALUES ($1, $2, $3, 15, '12441', $4, '', 'received', true, now())`,
      [purchaseId, reference, `V3 Vendor ${suffix}`, vendorYard]
    );
    const state = await query(
      `INSERT INTO scm_reconciliation_order_state (
         order_kind, source_order_netsuite_id, source_order_ref,
         application_status, reconciliation_status, source_location,
         destination_location_id, destination_location, order_snapshot, completed_at
       ) VALUES (
         'PO', $1, $2, 'Completed', 'ok', $3, 15, '12441', '{}'::jsonb,
         '2039-06-10T15:00:00.000Z'
       ) RETURNING id::text`,
      [purchaseId, reference, vendorYard]
    );

    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-06-10",
      limit: 100
    });
    const candidate = listed.items.find((item) => item.sourceRecordId === state.rows[0].id);
    assert.ok(candidate);
    assert.equal(candidate.chargeable, true);
    assert.equal(candidate.reason, null);
    assert.equal(candidate.originLabel, vendorAddress);
    assert.match(candidate.destinationLabel, /12441 Woodbine Avenue/iu);
    let distanceInput;
    const preview = await candidates.previewMbbsBillingCandidate({
      actor: ACTOR,
      candidateId: candidate.candidateId,
      completedMonth: "2039-06",
      rateCardVersionId
    }, {
      async resolveDistance(input) {
        distanceInput = input;
        return { provider: "v3-test", providerMetres: 30_001 };
      }
    });
    assert.deepEqual(distanceInput, {
      originAddressText: vendorAddress,
      destinationAddressText: candidate.destinationLabel
    });
    assert.equal(preview.charge.amountMinor, 25_000);
  });
});

test("S4/S5: default candidates are Delivery plus completed custom local orders; database search may add Pick-Up", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_920_000_000 + (crypto.randomInt(10_000) * 10);
    const deliveryRef = `SO-DELIVERY-${suffix}`;
    const pickupRef = `SO-PICKUP-${suffix}`;
    const customRef = `CUSTOM-${suffix}`;
    await insertSalesOrder({
      id: base + 1,
      reference: deliveryRef,
      completedAt: "2039-07-11T15:00:00.000Z",
      method: " Delivery ",
      address: "1 Delivery Road, Toronto, ON"
    });
    await insertSalesOrder({
      id: base + 2,
      reference: pickupRef,
      completedAt: "2039-07-11T15:30:00.000Z",
      method: "Pick-Up",
      address: "2 Pickup Road, Toronto, ON",
      customer: `Searchable ${suffix}`
    });
    await query(
      `INSERT INTO dispatch_custom_orders (
         ref_number, pickup_location, dropoff_location, order_details,
         weight_lbs, status, created_by, updated_by, completed_at
       ) VALUES ($1, 'Vendor custom address', 'MBBS custom address',
                 'Completed local delivery', 1000, 'completed', $2, $2,
                 '2039-07-11T16:00:00.000Z')`,
      [customRef, ACTOR.operatorId]
    );

    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-07-11",
      limit: 100
    });
    const references = listed.items.flatMap((item) => item.references.map((reference) => reference.rootReference));
    assert.ok(references.includes(deliveryRef));
    assert.ok(references.includes(customRef));
    assert.equal(references.includes(pickupRef), false);
    const custom = listed.items.find((item) => item.references[0]?.rootReference === customRef);
    assert.ok(custom);
    assert.equal(custom.sourceSystem, "custom_order");
    assert.equal(custom.references[0]?.sourceType, "CUSTOM");
    assert.equal(custom.chargeable, true);

    const searched = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      search: suffix,
      completedDate: "2039-07-11",
      limit: 100
    });
    assert.equal(searched.searchMode, "database");
    const pickup = searched.items.find((item) => item.references[0]?.rootReference === pickupRef);
    assert.ok(pickup);
    await insertCustomer({ id: base + 9, suffix });
    const convertedPickup = await candidates.createMbbsBillingCasesFromCandidates({
      actor: ACTOR,
      candidateIds: [pickup.candidateId, custom.candidateId],
      completedMonth: "2039-07",
      completedDate: "2039-07-11",
      rateCardVersionId,
      customerNetsuiteId: String(base + 9),
      reason: "Explicitly add and bill the searched Pick-Up order",
      idempotencyKey: `mbbs-v3-pickup-${suffix}`,
      correlationId: `mbbs-v3-pickup-correlation-${suffix}`,
      requestId: `mbbs-v3-pickup-request-${suffix}`
    }, {
      async resolveDistance() {
        return { provider: "mbbs-v3-test", providerMetres: 12_000 };
      }
    });
    assert.equal(convertedPickup.body.durableCaseCount, 2);
    assert.deepEqual(
      convertedPickup.body.cases.map((entry) => entry.rootReference).sort(),
      [pickupRef, customRef].sort()
    );
    assert.equal(
      (await query("SELECT sales_order_type FROM sales_orders WHERE netsuite_id = $1", [base + 2])).rows[0].sales_order_type,
      "Pick-Up"
    );
  });
});

test("S6: exact completion-date filtering uses Toronto day boundaries and rejects inconsistent month/date", async () => {
  await inRollback(async () => {
    await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_930_000_000 + (crypto.randomInt(10_000) * 10);
    const rows = [
      [base + 1, `SO-BEFORE-${suffix}`, "2039-07-13T03:59:59.999Z"],
      [base + 2, `SO-START-${suffix}`, "2039-07-13T04:00:00.000Z"],
      [base + 3, `SO-END-${suffix}`, "2039-07-14T03:59:59.999Z"],
      [base + 4, `SO-AFTER-${suffix}`, "2039-07-14T04:00:00.000Z"]
    ];
    for (const [id, reference, completedAt] of rows) {
      await insertSalesOrder({
        id,
        reference,
        completedAt,
        method: "Delivery",
        address: `${reference} destination`
      });
    }
    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-07-13",
      limit: 100
    });
    const found = listed.items.flatMap((item) => item.references)
      .map((reference) => reference.rootReference)
      .filter((reference) => reference.endsWith(suffix));
    assert.deepEqual(found.sort(), [`SO-END-${suffix}`, `SO-START-${suffix}`].sort());
    assert.equal(listed.completedDate, "2039-07-13");
    await assert.rejects(
      candidates.listMbbsBillingCandidates({ actor: ACTOR, completedDate: "2039-02-30" }),
      (error) => error?.code === "MBT_BILLING_COMPLETED_DATE_INVALID"
    );
    await assert.rejects(
      candidates.listMbbsBillingCandidates({
        actor: ACTOR,
        completedMonth: "2039-08",
        completedDate: "2039-07-13"
      }),
      (error) => error?.code === "MBT_BILLING_COMPLETED_FILTER_CONFLICT"
    );
  });
});

test("S7-S10: successful preview results convert atomically into idempotent local-only billing cases", async () => {
  await inRollback(async () => {
    const { rateCardVersionId, bandIds } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_940_000_000 + (crypto.randomInt(10_000) * 10);
    const customerId = base + 9;
    const shortReference = `SO-V3-SHORT-${suffix}`;
    const longReference = `SO-V3-LONG-${suffix}`;
    await insertCustomer({ id: customerId, suffix });
    await insertSalesOrder({
      id: base + 1,
      reference: shortReference,
      completedAt: "2039-08-10T15:00:00.000Z",
      method: "Delivery",
      address: `Short route ${suffix}, Toronto, ON`
    });
    await insertSalesOrder({
      id: base + 2,
      reference: longReference,
      completedAt: "2039-08-10T16:00:00.000Z",
      method: "Delivery",
      address: `Long route ${suffix}, Toronto, ON`
    });
    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-08-10",
      search: suffix,
      limit: 100
    });
    const selected = listed.items.filter((candidate) => (
      [shortReference, longReference].includes(candidate.references[0]?.rootReference)
    ));
    assert.equal(selected.length, 2);
    const routeInputs = [];
    const command = {
      actor: ACTOR,
      candidateIds: selected.map((candidate) => candidate.candidateId),
      completedMonth: "2039-08",
      completedDate: "2039-08-10",
      rateCardVersionId,
      customerNetsuiteId: String(customerId),
      reason: "Convert the verified completed-order batch",
      idempotencyKey: `mbbs-v3-create-${suffix}`,
      correlationId: `mbbs-v3-correlation-${suffix}`,
      requestId: `mbbs-v3-request-${suffix}`
    };
    const dependencies = {
      async resolveDistance(input) {
        routeInputs.push(input);
        return {
          provider: "mbbs-v3-test",
          providerMetres: String(input.destinationAddressText).includes("Long route") ? 30_001 : 30_000,
          routeHash: "b".repeat(64),
          originSnapshot: { address: input.originAddressText || input.originYardCode },
          destinationSnapshot: { address: input.destinationAddressText },
          routeSnapshot: { test: true }
        };
      }
    };
    const created = await candidates.createMbbsBillingCasesFromCandidates(command, dependencies);
    assert.equal(created.status, 201);
    assert.equal(created.replayed, false);
    assert.equal(created.body.schemaVersion, "mbbs-billing-candidate-batch-create-v1");
    assert.equal(created.body.postingMode, "local_only");
    assert.equal(created.body.externalWork, null);
    assert.equal(created.body.requestedCandidateCount, 2);
    assert.equal(created.body.durableCaseCount, 2);
    assert.equal(routeInputs.length, 2);

    const durable = await query(
      `SELECT cross_charge.root_reference,
              cross_charge.rate_distance_band_id::text,
              cross_charge.allocated_amount_minor::int,
              cross_charge.source_snapshot->>'completedLoadSnapshotId' AS snapshot_id,
              billing_case.customer_netsuite_id::text,
              billing_case.posting_mode,
              version.status AS version_status,
              line.local_item_code,
              line.net_amount_minor::int
         FROM mbt_cross_charge_cases cross_charge
         JOIN mbt_billing_cases billing_case USING (cross_charge_case_id)
         JOIN mbt_billing_versions version USING (billing_case_id)
         JOIN mbt_billing_lines line USING (billing_version_id)
        WHERE cross_charge.root_reference = ANY($1::text[])
        ORDER BY cross_charge.root_reference`,
      [[shortReference, longReference]]
    );
    assert.equal(durable.rowCount, 2);
    const byReference = new Map(durable.rows.map((row) => [row.root_reference, row]));
    assert.equal(byReference.get(shortReference).rate_distance_band_id, bandIds[0]);
    assert.equal(byReference.get(shortReference).allocated_amount_minor, 20_000);
    assert.equal(byReference.get(longReference).rate_distance_band_id, bandIds[1]);
    assert.equal(byReference.get(longReference).allocated_amount_minor, 25_000);
    for (const row of durable.rows) {
      assert.ok(row.snapshot_id);
      assert.equal(row.customer_netsuite_id, String(customerId));
      assert.equal(row.posting_mode, "local_only");
      assert.equal(row.version_status, "draft");
      assert.equal(row.local_item_code, "DELIVERY_CHARGE_MBBS");
      assert.equal(row.net_amount_minor, row.allocated_amount_minor);
    }
    const boundaries = await query(
      `SELECT
         (SELECT count(*)::int
            FROM mbt_mbbs_completed_load_snapshots
           WHERE completed_load_snapshot_id = ANY($1::uuid[])
             AND source_system = 'billing_candidate') AS snapshots,
         (SELECT count(*)::int
            FROM mbt_netsuite_sales_order_chain
           WHERE cross_charge_case_id = ANY($2::uuid[])) AS chains,
         (SELECT count(*)::int
            FROM mbt_netsuite_outbox
           WHERE billing_version_id = ANY($3::uuid[])) AS outbox`,
      [
        created.body.completedLoadSnapshotIds,
        created.body.cases.map((entry) => entry.crossChargeCaseId),
        created.body.cases.map((entry) => entry.billingVersionId)
      ]
    );
    assert.deepEqual(boundaries.rows[0], { snapshots: 2, chains: 0, outbox: 0 });

    const replay = await candidates.createMbbsBillingCasesFromCandidates(command, {
      async resolveDistance() {
        throw new Error("An idempotent replay must not recalculate distance.");
      }
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, created.body);

    const converged = await candidates.createMbbsBillingCasesFromCandidates({
      ...command,
      idempotencyKey: `mbbs-v3-create-converged-${suffix}`,
      requestId: `mbbs-v3-request-converged-${suffix}`
    }, dependencies);
    assert.equal(converged.replayed, false);
    assert.equal(converged.body.generationId, created.body.generationId);
    const counts = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_mbbs_completed_load_snapshots
           WHERE completed_load_snapshot_id = ANY($1::uuid[])) AS snapshots,
         (SELECT count(*)::int FROM mbt_cross_charge_cases
           WHERE cross_charge_case_id = ANY($2::uuid[])) AS cases,
         (SELECT count(*)::int FROM mbt_billing_versions
           WHERE billing_version_id = ANY($3::uuid[])) AS versions`,
      [
        created.body.completedLoadSnapshotIds,
        created.body.cases.map((entry) => entry.crossChargeCaseId),
        created.body.cases.map((entry) => entry.billingVersionId)
      ]
    );
    assert.deepEqual(counts.rows[0], { snapshots: 2, cases: 2, versions: 2 });
    const methods = await query(
      "SELECT sales_order_type FROM sales_orders WHERE netsuite_id = ANY($1::bigint[]) ORDER BY netsuite_id",
      [[base + 1, base + 2]]
    );
    assert.deepEqual(methods.rows.map((row) => row.sales_order_type), ["Delivery", "Delivery"]);
  });
});

test("S9/S10: a mid-batch persistence failure rolls snapshots, cases, lines, receipt, and audit back together", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_950_000_000 + (crypto.randomInt(10_000) * 10);
    const customerId = base + 9;
    const references = [`SO-V3-ROLLBACK-A-${suffix}`, `SO-V3-ROLLBACK-B-${suffix}`];
    await insertCustomer({ id: customerId, suffix });
    for (const [index, reference] of references.entries()) {
      await insertSalesOrder({
        id: base + index,
        reference,
        completedAt: `2039-09-10T1${index + 5}:00:00.000Z`,
        method: "Delivery",
        address: `${reference} destination`
      });
    }
    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-09-10",
      search: suffix,
      limit: 100
    });
    const candidateIds = listed.items
      .filter((candidate) => references.includes(candidate.references[0]?.rootReference))
      .map((candidate) => candidate.candidateId);
    assert.equal(candidateIds.length, 2);
    const idempotencyKey = `mbbs-v3-rollback-${suffix}`;
    await assert.rejects(
      candidates.createMbbsBillingCasesFromCandidates({
        actor: ACTOR,
        candidateIds,
        completedMonth: "2039-09",
        completedDate: "2039-09-10",
        rateCardVersionId,
        customerNetsuiteId: String(customerId),
        reason: "Prove atomic rollback of a partial batch",
        idempotencyKey,
        correlationId: `mbbs-v3-rollback-correlation-${suffix}`,
        requestId: `mbbs-v3-rollback-request-${suffix}`
      }, {
        async resolveDistance() {
          return { provider: "mbbs-v3-test", providerMetres: 12_000 };
        },
        hooks: {
          async afterCaseInsert() {
            throw new Error("synthetic mid-batch persistence failure");
          }
        }
      }),
      /synthetic mid-batch persistence failure/u
    );
    const retained = await query(
      `SELECT
         (SELECT count(*)::int FROM mbt_mbbs_completed_load_snapshots
           WHERE source_system = 'billing_candidate' AND source_plan_id = ANY($1::text[])) AS snapshots,
         (SELECT count(*)::int FROM mbt_cross_charge_cases
           WHERE root_reference = ANY($2::text[])) AS cases,
         (SELECT count(*)::int FROM mbt_command_receipts
           WHERE actor_operator_id = $3 AND command_name = 'mbt.billing.mbbs_candidates.batch_create'
             AND idempotency_key = $4) AS receipts,
         (SELECT count(*)::int FROM mbt_audit_events
           WHERE actor_operator_id = $3 AND action = 'mbt.billing.mbbs_candidates.created'
             AND idempotency_key = $4) AS audits`,
      [candidateIds, references, ACTOR.operatorId, idempotencyKey]
    );
    assert.deepEqual(retained.rows[0], { snapshots: 0, cases: 0, receipts: 0, audits: 0 });
  });
});

test("manual adjustment and final charge are server-recalculated, tamper-checked, and frozen in every durable layer", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_960_000_000 + (crypto.randomInt(10_000) * 10);
    const customerId = base + 9;
    const reference = `SO-V3-EDIT-${suffix}`;
    await insertCustomer({ id: customerId, suffix });
    await insertSalesOrder({
      id: base + 1,
      reference,
      completedAt: "2039-10-10T15:00:00.000Z",
      method: "Delivery",
      address: `${reference} destination`
    });
    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedDate: "2039-10-10",
      search: reference,
      limit: 100
    });
    const candidate = listed.items.find((item) => item.references[0]?.rootReference === reference);
    assert.ok(candidate);
    const distance = async () => ({
      provider: "mbbs-v3-edit-test",
      providerMetres: 12_000,
      routeHash: "e".repeat(64)
    });
    const preview = await candidates.previewMbbsBillingCandidatesBatch({
      actor: ACTOR,
      candidateIds: [candidate.candidateId],
      completedMonth: "2039-10",
      completedDate: "2039-10-10",
      rateCardVersionId
    }, { resolveDistance: distance });
    assert.equal(preview.results[0].charge.calculatedAmountMinor, 20_000);
    assert.equal(preview.results[0].charge.adjustmentMinor, 0);
    assert.equal(preview.results[0].charge.finalAmountMinor, 20_000);

    const command = {
      actor: ACTOR,
      candidateIds: [candidate.candidateId],
      completedMonth: "2039-10",
      completedDate: "2039-10-10",
      rateCardVersionId,
      customerNetsuiteId: String(customerId),
      reason: "Staff-verified reduction with retained route evidence",
      correlationId: `mbbs-v3-edit-correlation-${suffix}`,
      requestId: `mbbs-v3-edit-request-${suffix}`
    };
    await assert.rejects(
      candidates.createMbbsBillingCasesFromCandidates({
        ...command,
        idempotencyKey: `mbbs-v3-edit-stale-${suffix}`,
        manualAmountEdits: [{
          candidateId: candidate.candidateId,
          calculatedAmountMinor: 19_999,
          adjustmentMinor: -2_500,
          finalAmountMinor: 17_499
        }]
      }, { resolveDistance: distance }),
      (error) => error?.code === "MBT_BILLING_MANUAL_AMOUNT_STALE"
    );
    const created = await candidates.createMbbsBillingCasesFromCandidates({
      ...command,
      idempotencyKey: `mbbs-v3-edit-create-${suffix}`,
      manualAmountEdits: [{
        candidateId: candidate.candidateId,
        calculatedAmountMinor: 20_000,
        adjustmentMinor: -2_500,
        finalAmountMinor: 17_500
      }]
    }, { resolveDistance: distance });
    assert.deepEqual(created.body.manualAmountEdits, [{
      candidateId: candidate.candidateId,
      calculatedAmountMinor: 20_000,
      adjustmentMinor: -2_500,
      finalAmountMinor: 17_500,
      edited: true,
      editorId: ACTOR.operatorId
    }]);
    const durable = await query(
      `SELECT charge.base_amount_minor::int,
              charge.allocated_amount_minor::int,
              line.net_amount_minor::int,
              charge.source_snapshot->'billingEvidence' AS source_billing,
              charge.calculation_snapshot->'billingEvidence' AS calculation_billing,
              line.calculation_detail->'billingEvidence' AS line_billing
         FROM mbt_cross_charge_cases charge
         JOIN mbt_billing_cases billing_case USING (cross_charge_case_id)
         JOIN mbt_billing_versions version USING (billing_case_id)
         JOIN mbt_billing_lines line USING (billing_version_id)
        WHERE charge.root_reference = $1`,
      [reference]
    );
    assert.equal(durable.rowCount, 1);
    assert.equal(durable.rows[0].base_amount_minor, 20_000);
    assert.equal(durable.rows[0].allocated_amount_minor, 17_500);
    assert.equal(durable.rows[0].net_amount_minor, 17_500);
    for (const evidence of [
      durable.rows[0].source_billing,
      durable.rows[0].calculation_billing,
      durable.rows[0].line_billing
    ]) {
      assert.equal(evidence.calculatedAmountMinor, 20_000);
      assert.equal(evidence.adjustmentMinor, -2_500);
      assert.equal(evidence.finalAmountMinor, 17_500);
      assert.equal(evidence.editorId, ACTOR.operatorId);
    }
  });
});

test("an inactive historical SO group matching its dispatch date is one candidate with every child retained", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_970_000_000 + (crypto.randomInt(10_000) * 10);
    const planDate = "2039-11-07";
    const groupRef = `GOA-${suffix.slice(0, 6)}-${suffix.slice(6, 12)}`;
    const references = [`SOA${suffix.slice(0, 8)}`, `SOA${suffix.slice(8, 16)}`];
    for (const [index, reference] of references.entries()) {
      await insertSalesOrder({
        id: base + index,
        reference,
        completedAt: `2039-11-0${8 + index}T15:00:00.000Z`,
        method: "Delivery",
        address: "37 Sunmount Road, Scarborough, ON"
      });
      await query(
        "UPDATE sales_orders SET dispatch_plan_date = $2::date WHERE netsuite_id = $1",
        [base + index, planDate]
      );
    }
    const plan = await query(
      `INSERT INTO dispatch_plans (plan_date, status, note)
       VALUES ($1::date, 'confirmed', $2)
       RETURNING id::text`,
      [planDate, `Historical group ${suffix}`]
    );
    await query(
      `INSERT INTO dispatch_delivery_groups (
         group_ref, plan_id, plan_date, order_type, active, updated_at
       ) VALUES ($1, $2::bigint, $3::date, 'sales_order', false, now())`,
      [groupRef, plan.rows[0].id, planDate]
    );
    for (const [position, reference] of references.entries()) {
      await query(
        `INSERT INTO dispatch_delivery_group_members (group_ref, member_order_ref, position)
         VALUES ($1, $2, $3)`,
        [groupRef, reference, position]
      );
    }

    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedMonth: "2039-11",
      search: references[0],
      limit: 100
    });
    const grouped = listed.items.find((item) => item.references[0]?.rootReference === groupRef);
    assert.ok(grouped);
    assert.equal(grouped.billingRule, "so_group");
    assert.deepEqual(grouped.memberReferences, references.map((rootReference) => ({ sourceType: "SO", rootReference })));
    assert.equal(listed.items.some((item) => references.includes(item.references[0]?.rootReference)), false);
    const preview = await candidates.previewMbbsBillingCandidatesBatch({
      actor: ACTOR,
      candidateIds: [grouped.candidateId],
      completedMonth: "2039-11",
      rateCardVersionId
    }, {
      async resolveDistance() {
        return { provider: "historical-group-test", providerMetres: 12_000 };
      }
    });
    assert.equal(preview.results[0].status, "calculated");
    assert.equal(preview.results[0].candidate.references[0].rootReference, groupRef);
  });
});

test("a searched candidate older than the source-page limit still previews and converts by opaque identity", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_980_000_000 + (crypto.randomInt(1_000) * 10_000);
    const reference = `SO-OLDER-${suffix}`;
    const customerId = base + 9_999;
    await insertCustomer({ id: customerId, suffix });
    await insertSalesOrder({
      id: base,
      reference,
      completedAt: "2041-02-01T15:00:00.000Z",
      method: "Delivery",
      address: "1 Older Candidate Road, Toronto, ON"
    });
    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, fulfillment_status, fulfilled_at,
         outbound_location, sales_order_type, dispatch_address,
         netsuite_active, synced_at
       )
       SELECT $1::bigint + series,
              $2 || series::text,
              'fulfilled',
              ('2041-02-02T12:00:00.000Z'::timestamptz + (series * interval '1 second')),
              '2967', 'Delivery', '2 Newer Candidate Road, Toronto, ON', true,
              ('2041-02-02T12:00:00.000Z'::timestamptz + (series * interval '1 second'))
         FROM generate_series(1, 1005) series`,
      [base, `SO-NEWER-${suffix}-`]
    );
    const searched = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedMonth: "2041-02",
      search: reference,
      limit: 100
    });
    const selected = searched.items.find((item) => item.references[0]?.rootReference === reference);
    assert.ok(selected);
    const distance = async () => ({ provider: "targeted-identity-test", providerMetres: 12_000 });
    const preview = await candidates.previewMbbsBillingCandidatesBatch({
      actor: ACTOR,
      candidateIds: [selected.candidateId],
      completedMonth: "2041-02",
      rateCardVersionId
    }, { resolveDistance: distance });
    assert.equal(preview.results[0].status, "calculated");
    const created = await candidates.createMbbsBillingCasesFromCandidates({
      actor: ACTOR,
      candidateIds: [selected.candidateId],
      completedMonth: "2041-02",
      rateCardVersionId,
      customerNetsuiteId: String(customerId),
      reason: "Convert the explicitly searched older completed order",
      idempotencyKey: `older-${suffix}`,
      correlationId: `older-correlation-${suffix}`,
      requestId: `older-request-${suffix}`
    }, { resolveDistance: distance });
    assert.equal(created.body.durableCaseCount, 1);
    assert.equal(created.body.cases[0].rootReference, reference);
  });
});

test("an unavailable automatic route keeps zero-base manual amounts editable and freezes a manual-rate case", async () => {
  await inRollback(async () => {
    const { rateCardVersionId } = await installRateGraph();
    const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    const base = 9_990_000_000 + (crypto.randomInt(10_000) * 10);
    const customerId = base + 9;
    const reference = `SO-MANUAL-RATE-${suffix}`;
    await insertCustomer({ id: customerId, suffix });
    await insertSalesOrder({
      id: base + 1,
      reference,
      completedAt: "2041-03-10T15:00:00.000Z",
      method: "Delivery",
      address: "Unroutable but retained address"
    });
    const listed = await candidates.listMbbsBillingCandidates({
      actor: ACTOR,
      completedMonth: "2041-03",
      search: reference,
      limit: 100
    });
    const selected = listed.items.find((item) => item.references[0]?.rootReference === reference);
    assert.ok(selected);
    const unavailableDistance = async () => {
      throw Object.assign(new Error("No supported driving route was found for these addresses."), {
        code: "MBT_MBBS_DISTANCE_LOOKUP_FAILED"
      });
    };
    const preview = await candidates.previewMbbsBillingCandidatesBatch({
      actor: ACTOR,
      candidateIds: [selected.candidateId],
      completedMonth: "2041-03",
      rateCardVersionId
    }, { resolveDistance: unavailableDistance });
    assert.equal(preview.results[0].status, "manual_required");
    assert.equal(preview.results[0].charge.calculatedAmountMinor, 0);
    assert.equal(preview.results[0].charge.finalAmountMinor, 0);
    assert.equal(preview.results[0].automaticRate.available, false);
    assert.equal(preview.manualRequiredCount, 1);

    const created = await candidates.createMbbsBillingCasesFromCandidates({
      actor: ACTOR,
      candidateIds: [selected.candidateId],
      completedMonth: "2041-03",
      rateCardVersionId,
      customerNetsuiteId: String(customerId),
      manualAmountEdits: [{
        candidateId: selected.candidateId,
        calculatedAmountMinor: 0,
        adjustmentMinor: 12_345,
        finalAmountMinor: 12_345
      }],
      reason: "Manual route charge supplied because no automatic driving route exists",
      idempotencyKey: `manual-rate-${suffix}`,
      correlationId: `manual-rate-correlation-${suffix}`,
      requestId: `manual-rate-request-${suffix}`
    }, { resolveDistance: unavailableDistance });
    assert.equal(created.body.durableCaseCount, 1);
    assert.equal(created.body.cases[0].allocatedAmountMinor, 12_345);
    assert.equal(created.body.cases[0].rateDistanceBandId, null);
    const durable = await query(
      `SELECT rate_distance_band_id, calculated_metres::int,
              allocated_amount_minor::int,
              source_snapshot->'billingEvidence'->'automaticRate' AS automatic_rate
         FROM mbt_cross_charge_cases
        WHERE root_reference = $1`,
      [reference]
    );
    assert.deepEqual(durable.rows[0], {
      rate_distance_band_id: null,
      calculated_metres: 0,
      allocated_amount_minor: 12_345,
      automatic_rate: {
        available: false,
        code: "MBT_MBBS_DISTANCE_LOOKUP_FAILED",
        message: "No supported driving route was found for these addresses."
      }
    });
  });
});

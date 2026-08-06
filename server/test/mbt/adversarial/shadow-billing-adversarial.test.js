// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import pg from "pg";

import {
  billingActor,
  billingCalculationCommand,
  createBillingFixture
} from "../support/billing-fixtures.js";

import { calculateMbtLocalBilling } from "../../../src/mbt/local-billing-calculator.js";
import {
  approveLocalBillingVersion,
  calculateMbtBillingCase,
  generateMbbsShadowBilling
} from "../../../src/mbt/shadow-billing-service.js";
import { canonicalSha256 } from "../../../src/mbt/canonical-json.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

after(async () => {
  await pool.end();
});

async function isolatedFixture(options = {}) {
  const client = await pool.connect();
  try {
    return await createBillingFixture(client, options);
  } finally {
    client.release();
  }
}

/** @param {any} fixture @param {string} identity @param {Record<string, unknown>} [overrides] */
function crossChargeCommand(fixture, identity, overrides = {}) {
  return {
    actor: billingActor(identity),
    customerNetsuiteId: fixture.customerNetsuiteId,
    rateCardVersionId: fixture.rateCardVersionId,
    rateDistanceBandId: fixture.rateDistanceBandId,
    currency: "CAD",
    loads: [{
      physicalLoadId: `P310-ADV-${identity}`,
      planDate: "2038-04-01",
      completedAt: "2038-04-01T12:00:00.000Z",
      truckId: fixture.truckId,
      driverId: fixture.driverId,
      calculatedMetres: 12_500,
      sharedTotalMinor: 10_001,
      references: [{ sourceType: "PO", rootReference: `PO-ADV-${identity}` }]
    }],
    reason: `P3.10 adversarial cross-charge ${identity}`,
    idempotencyKey: `p3.10-adversarial-mbbs-${identity}`,
    correlationId: `p3.10-adversarial-mbbs-correlation-${identity}`,
    requestId: `p3.10-adversarial-mbbs-request-${identity}`,
    ...overrides
  };
}

function calculatorInput() {
  return {
    rateCardVersionId: "10000000-0000-4000-8000-000000000001",
    currency: "CAD",
    taxBasisPoints: 1_300,
    contractSnapshot: { contractId: "20000000-0000-4000-8000-000000000001", revision: 1 },
    visitSnapshot: { serviceVisitId: "30000000-0000-4000-8000-000000000001", revision: 1 },
    distanceSnapshot: {
      distanceSnapshotId: "40000000-0000-4000-8000-000000000001",
      rawMetres: 1_000,
      selectedBandId: "50000000-0000-4000-8000-000000000001",
      amountMinor: 10_000,
      currency: "CAD",
      taxable: false
    },
    localItem: { code: "20YD", revision: 1 },
    components: [{
      componentId: "60000000-0000-4000-8000-000000000001",
      lineCode: "rental_daily",
      lineType: "rental",
      rateBasis: "flat",
      amountMinor: 100,
      currency: "USD",
      taxable: false,
      localItem: { code: "20YD", revision: 1 }
    }],
    customPrices: [],
    dump: null
  };
}

/** @param {any} fixture @param {{overrideMetres?: number, overrideAmountMinor?: number}} [overrides] */
async function copyDistance(fixture, overrides = {}) {
  const distanceSnapshotId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_distance_snapshots (
       distance_snapshot_id, subject_type, subject_id, rate_card_version_id,
       rate_distance_band_id, provider, provider_metres, route_hash,
       origin_snapshot, destination_snapshot, route_snapshot,
       calculated_amount_minor, currency, override_metres,
       override_amount_minor, override_reason, overridden_by, overridden_at
     )
     SELECT $1, subject_type, subject_id, rate_card_version_id,
            rate_distance_band_id, provider, provider_metres, $2,
            origin_snapshot, destination_snapshot, route_snapshot,
            calculated_amount_minor, currency, $3, $4,
            CASE WHEN $3::bigint IS NULL THEN NULL ELSE 'Adversarial audited override' END,
            CASE WHEN $3::bigint IS NULL THEN NULL ELSE 'p3.10-adversarial' END,
            CASE WHEN $3::bigint IS NULL THEN NULL ELSE clock_timestamp() END
       FROM mbt_distance_snapshots
      WHERE distance_snapshot_id = $5`,
    [
      distanceSnapshotId,
      crypto.randomBytes(32).toString("hex"),
      overrides.overrideMetres ?? null,
      overrides.overrideAmountMinor ?? null,
      fixture.distanceSnapshotId
    ]
  );
  return distanceSnapshotId;
}

/** @param {any} fixture */
async function siblingVisitEvidence(fixture) {
  const serviceVisitId = crypto.randomUUID();
  const visitReference = `P310-ADV-VISIT-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO mbt_service_visits (
       service_visit_id, contract_id, visit_number, visit_reference,
       service_template_version_id, service_action, status,
       customer_site_profile_id, bin_type_id, scheduled_start_at,
       scheduled_end_at, customer_snapshot, site_snapshot, service_snapshot,
       created_by, updated_by
     )
     SELECT $1, contract_id,
            (SELECT COALESCE(max(other.visit_number), 0) + 1
               FROM mbt_service_visits other
              WHERE other.contract_id = source.contract_id),
            $2, service_template_version_id, service_action, status,
            customer_site_profile_id, bin_type_id,
            scheduled_start_at + interval '1 day',
            scheduled_end_at + interval '1 day',
            customer_snapshot, site_snapshot, service_snapshot,
            'p3.10-adversarial', 'p3.10-adversarial'
       FROM mbt_service_visits source
      WHERE service_visit_id = $3`,
    [serviceVisitId, visitReference, fixture.visitId]
  );
  const distanceSnapshotId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_distance_snapshots (
       distance_snapshot_id, subject_type, subject_id, rate_card_version_id,
       rate_distance_band_id, provider, provider_metres, route_hash,
       origin_snapshot, destination_snapshot, route_snapshot,
       calculated_amount_minor, currency
     )
     SELECT $1, 'visit', $2, rate_card_version_id,
            rate_distance_band_id, provider, provider_metres, $3,
            origin_snapshot, destination_snapshot, route_snapshot,
            calculated_amount_minor, currency
       FROM mbt_distance_snapshots
      WHERE distance_snapshot_id = $4`,
    [
      distanceSnapshotId,
      serviceVisitId,
      crypto.randomBytes(32).toString("hex"),
      fixture.distanceSnapshotId
    ]
  );
  return { serviceVisitId, distanceSnapshotId };
}

test("P3.10 adversarial: every shadow-billing mutation rejects a non-billing actor before durable work", async () => {
  const fixture = await isolatedFixture();
  const command = billingCalculationCommand(fixture, "unauthorized");
  command.actor = billingActor("unauthorized", ["driver"]);

  await assert.rejects(
    () => calculateMbtBillingCase(command),
    (error) => error?.code === "MBT_BILLING_FORBIDDEN"
  );
  const versions = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_billing_versions WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  assert.equal(versions.rows[0].count, 0);
});

test("P3.10 adversarial: a billing case cannot consume another visit from the same contract", async () => {
  const fixture = await isolatedFixture();
  const sibling = await siblingVisitEvidence(fixture);
  const command = {
    ...billingCalculationCommand(fixture, "cross-visit"),
    serviceVisitId: sibling.serviceVisitId,
    distanceSnapshotId: sibling.distanceSnapshotId,
    dumpReceiptId: null
  };

  await assert.rejects(
    () => calculateMbtBillingCase(command),
    (error) => error?.code === "MBT_BILLING_VISIT_MISMATCH"
  );
});

test("P3.10 adversarial: pre-completion billing is rejected without durable work", async () => {
  const fixture = await isolatedFixture({ completed: false });

  await assert.rejects(
    () => calculateMbtBillingCase(
      billingCalculationCommand(fixture, `pre-completion-${fixture.fixtureId}`)
    ),
    (error) => error?.code === "MBT_BILLING_VISIT_INCOMPLETE"
  );
  const versions = await pool.query(
    "SELECT count(*)::int AS count FROM mbt_billing_versions WHERE billing_case_id = $1",
    [fixture.billingCaseId]
  );
  assert.equal(versions.rows[0].count, 0);
});

test("P3.10 adversarial: every configured rate component must match the billing currency", () => {
  assert.throws(
    () => calculateMbtLocalBilling(calculatorInput()),
    (error) => error?.code === "MBT_BILLING_CURRENCY_MISMATCH"
  );
});

test("P3.10 adversarial: an audited distance override is the frozen billed metres and amount", async () => {
  const fixture = await isolatedFixture();
  const distanceSnapshotId = await copyDistance(fixture, {
    overrideMetres: 7_777,
    overrideAmountMinor: 4_321
  });
  const calculated = await calculateMbtBillingCase({
    ...billingCalculationCommand(fixture, `distance-override-${fixture.fixtureId}`),
    distanceSnapshotId,
    dumpReceiptId: null
  });

  assert.equal(calculated.body.lines[0].netAmountMinor, 4_321);
  const snapshot = await pool.query(
    `SELECT calculation_snapshot->'distanceSnapshot' AS distance
       FROM mbt_billing_versions
      WHERE billing_version_id = $1`,
    [calculated.body.billingVersionId]
  );
  assert.equal(snapshot.rows[0].distance.rawMetres, 7_777);
  assert.equal(snapshot.rows[0].distance.amountMinor, 4_321);
});

test("P3.10 adversarial: dump billing freezes the durable receipt-photo identity and content hash", async () => {
  const fixture = await isolatedFixture();
  const expected = await pool.query(
    `SELECT receipt.receipt_photo_evidence_id::text AS evidence_id,
            evidence.content_sha256
       FROM mbt_dump_receipts receipt
       JOIN mbt_evidence evidence
         ON evidence.evidence_id = receipt.receipt_photo_evidence_id
      WHERE receipt.dump_receipt_id = $1`,
    [fixture.dumpReceiptId]
  );
  const calculated = await calculateMbtBillingCase(
    billingCalculationCommand(fixture, `receipt-photo-${fixture.fixtureId}`)
  );
  const snapshot = await pool.query(
    `SELECT calculation_snapshot->'receiptSnapshot' AS receipt
       FROM mbt_billing_versions
      WHERE billing_version_id = $1`,
    [calculated.body.billingVersionId]
  );

  assert.equal(snapshot.rows[0].receipt.photoEvidence.evidenceId, expected.rows[0].evidence_id);
  assert.equal(snapshot.rows[0].receipt.photoEvidence.contentSha256, expected.rows[0].content_sha256);
});

test("P3.10 adversarial: cross-charge generation requires a band from its selected rate version", async () => {
  const fixture = await isolatedFixture();
  const command = crossChargeCommand(fixture, "missing-band", {
    rateDistanceBandId: null
  });
  await assert.rejects(
    () => generateMbbsShadowBilling(command),
    (error) => error?.code === "MBT_BILLING_INPUT_INVALID"
  );
});

test("P3.10 adversarial schema: a completed-load source is frozen by immutable durable identity", async () => {
  const fixture = await isolatedFixture();
  const completedLoadSnapshotId = crypto.randomUUID();
  const physicalLoadId = `P310-ADV-FROZEN-${fixture.fixtureId}`;
  const references = [{
    sourceType: "PO",
    rootReference: `PO-ADV-FROZEN-${fixture.fixtureId}`,
    childReference: null
  }];
  const sourceSnapshot = {
    schemaVersion: "mbbs-completed-physical-load-v1",
    sourceSystem: "dispatch",
    sourcePlanId: `P310-ADV-PLAN-${fixture.fixtureId}`,
    sourcePlanRevision: 1,
    physicalLoadId,
    completed: true,
    completedAt: "2038-04-02T12:00:00.000Z",
    references
  };
  await pool.query(
    `INSERT INTO mbt_mbbs_completed_load_snapshots (
       completed_load_snapshot_id, source_system, source_plan_id,
       source_plan_revision, plan_date, physical_load_id, completed_at,
       truck_id, driver_id, calculated_metres, shared_total_minor, currency,
       source_references, source_snapshot, source_snapshot_hash, created_by
     ) VALUES (
       $1, 'dispatch', $2, 1, '2038-04-02', $3,
       '2038-04-02T12:00:00.000Z', $4, $5, 12500, 10001, 'CAD',
       $6::jsonb, $7::jsonb, $8, 'p3.10-adversarial-materializer'
     )`,
    [
      completedLoadSnapshotId,
      sourceSnapshot.sourcePlanId,
      physicalLoadId,
      fixture.truckId,
      fixture.driverId,
      JSON.stringify(references),
      JSON.stringify(sourceSnapshot),
      canonicalSha256(sourceSnapshot)
    ]
  );
  const retained = await pool.query(
    `SELECT completed_load_snapshot_id::text AS snapshot_id,
            physical_load_id, shared_total_minor::int AS shared_total_minor,
            source_references, source_snapshot, source_snapshot_hash
       FROM mbt_mbbs_completed_load_snapshots
      WHERE completed_load_snapshot_id = $1`,
    [completedLoadSnapshotId]
  );
  assert.deepEqual(retained.rows, [{
    snapshot_id: completedLoadSnapshotId,
    physical_load_id: physicalLoadId,
    shared_total_minor: 10_001,
    source_references: references,
    source_snapshot: sourceSnapshot,
    source_snapshot_hash: canonicalSha256(sourceSnapshot)
  }]);
  await assert.rejects(
    () => pool.query(
      `UPDATE mbt_mbbs_completed_load_snapshots
          SET shared_total_minor = shared_total_minor + 1
        WHERE completed_load_snapshot_id = $1`,
      [completedLoadSnapshotId]
    ),
    (error) => error?.code === "55000"
  );
});

test("P3.10 adversarial: a durable cross-charge dedupe key rejects changed source evidence", async () => {
  const fixture = await isolatedFixture();
  const firstCommand = crossChargeCommand(fixture, `dedupe-drift-${fixture.fixtureId}`);
  await generateMbbsShadowBilling(firstCommand);
  const changedCommand = {
    ...structuredClone(firstCommand),
    idempotencyKey: `${firstCommand.idempotencyKey}-changed`,
    correlationId: `${firstCommand.correlationId}-changed`,
    requestId: `${firstCommand.requestId}-changed`
  };
  changedCommand.loads[0].completedAt = "2038-04-01T13:00:00.000Z";

  await assert.rejects(
    () => generateMbbsShadowBilling(changedCommand),
    (error) => error?.code === "MBT_CROSS_CHARGE_IDENTITY_CONFLICT"
  );
});

test("P3.10 adversarial: unknown component quantity keys fail closed instead of disappearing", async () => {
  const fixture = await isolatedFixture();
  const command = billingCalculationCommand(fixture, "unknown-quantity");
  command.componentQuantities = {
    rental_daily: "3.000000",
    rental_daliy: "99.000000"
  };

  await assert.rejects(
    () => calculateMbtBillingCase(command),
    (error) => error?.code === "MBT_BILLING_QUANTITY_COMPONENT_UNKNOWN"
  );
});

test("P3.10 adversarial: approval compares line identities with the frozen calculation, not only sums", async () => {
  const fixture = await isolatedFixture();
  const billingVersionId = crypto.randomUUID();
  const localItem = await pool.query(
    `SELECT item.item_code, item.revision
       FROM mbt_billing_cases billing_case
       JOIN mbt_contracts contract USING (contract_id)
       JOIN mbt_local_item_settings item ON item.bin_type_id = contract.bin_type_id
      WHERE billing_case.billing_case_id = $1`,
    [fixture.billingCaseId]
  );
  await pool.query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       posting_mode, billing_case_revision_before, calculated_by,
       calculation_reason, calculated_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, 'draft', $3, $4::jsonb, '{}'::jsonb,
       100, 0, 100, 'CAD', 'local_only', 1,
       'p3.10-adversarial', 'Incomplete zero-line detector', now(),
       $5, $6
     )`,
    [
      billingVersionId,
      fixture.billingCaseId,
      fixture.rateCardVersionId,
      JSON.stringify({
        schemaVersion: "mbt-local-billing-v1",
        lines: [
          { lineKey: "transport", netAmountMinor: 100, estimatedTaxMinor: 0, totalAmountMinor: 100 },
          { lineKey: "zero_required", netAmountMinor: 0, estimatedTaxMinor: 0, totalAmountMinor: 0 }
        ],
        subtotalMinor: 100,
        estimatedTaxMinor: 0,
        totalMinor: 100
      }),
      `p3.10-adversarial-incomplete-correlation-${billingVersionId}`,
      `p3.10-adversarial-incomplete-idempotency-${billingVersionId}`
    ]
  );
  await pool.query(
    `INSERT INTO mbt_billing_lines (
       billing_line_id, billing_version_id, sequence_number, line_key,
       line_type, description, quantity, unit_of_measure,
       unit_amount_minor, net_amount_minor, estimated_tax_minor,
       total_amount_minor, currency, revenue_class,
       distance_snapshot_id, source_entity_type, source_entity_id,
       calculation_detail, local_item_code, local_item_revision
     ) VALUES (
       $1, $2, 0, 'transport', 'transport', 'Transport', 1, 'TRIP',
       100, 100, 0, 100, 'CAD', 'transport', $3,
       'contract', $4, '{}'::jsonb, $5, $6
     )`,
    [
      crypto.randomUUID(),
      billingVersionId,
      fixture.distanceSnapshotId,
      fixture.contractId,
      localItem.rows[0].item_code,
      localItem.rows[0].revision
    ]
  );
  await pool.query(
    `UPDATE mbt_billing_cases
        SET status = 'ready', current_version_number = 1, revision = 2
      WHERE billing_case_id = $1`,
    [fixture.billingCaseId]
  );

  await assert.rejects(
    () => approveLocalBillingVersion({
      actor: billingActor("incomplete-approval"),
      billingCaseId: fixture.billingCaseId,
      billingVersionId,
      expectedRevision: 2,
      reason: "Reject a sum-matching incomplete draft",
      idempotencyKey: `p3.10-adversarial-approve-${billingVersionId}`,
      correlationId: `p3.10-adversarial-approve-correlation-${billingVersionId}`,
      requestId: `p3.10-adversarial-approve-request-${billingVersionId}`
    }),
    (error) => error?.code === "MBT_BILLING_DRAFT_INCOMPLETE"
  );
});

test("P3.10 adversarial schema: activated rate graphs can represent a discount component", async () => {
  const constraint = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conname = 'mbt_rate_components_kind'`
  );
  assert.equal(constraint.rowCount, 1);
  assert.match(String(constraint.rows[0].definition), /'discount'/u);
});

test("P3.10 adversarial schema: a signed discount tax can persist when subtotal and total stay nonnegative", async () => {
  const fixture = await isolatedFixture();
  const billingVersionId = crypto.randomUUID();
  await assert.doesNotReject(() => pool.query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       posting_mode, billing_case_revision_before, calculated_by,
       calculation_reason, calculated_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, 'draft', $3, '{}'::jsonb, '{}'::jsonb,
       900, -13, 887, 'CAD', 'local_only', 1,
       'p3.10-adversarial', 'Signed discount tax detector', now(), $4, $5
     )`,
    [
      billingVersionId,
      fixture.billingCaseId,
      fixture.rateCardVersionId,
      `p3.10-adversarial-negative-tax-correlation-${billingVersionId}`,
      `p3.10-adversarial-negative-tax-idempotency-${billingVersionId}`
    ]
  ));
});

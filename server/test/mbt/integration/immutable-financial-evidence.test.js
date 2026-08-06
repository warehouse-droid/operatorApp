import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import { createAssetFixture } from "../support/asset-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let fixture;
let contract;

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createAssetFixture(client, { assetCount: 1, visitCount: 1 });
    const result = await client.query(
      `SELECT contract_id, customer_netsuite_id,
              rate_card_version_id, rate_card_id
         FROM mbt_contracts c
         JOIN mbt_rate_card_versions v USING (rate_card_version_id)
        WHERE contract_id = $1`,
      [fixture.contractId]
    );
    contract = result.rows[0];
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

test("F09: first-used rate versions and their pricing rows are immutable while a new version remains possible", async () => {
  const componentId = fixture.rateComponentId;

  const automaticFirstUse = await pool.query(
    `SELECT first_used_at IS NOT NULL AS first_used,
            first_used_entity_type, first_used_entity_id
       FROM mbt_rate_card_versions
      WHERE rate_card_version_id = $1`,
    [contract.rate_card_version_id]
  );
  assert.deepEqual(automaticFirstUse.rows, [{
    first_used: true,
    first_used_entity_type: "contract",
    first_used_entity_id: fixture.contractId
  }]);

  for (const statement of [
    {
      sql: "UPDATE mbt_rate_card_versions SET calculation_notes = 'rewritten' WHERE rate_card_version_id = $1",
      params: [contract.rate_card_version_id]
    },
    {
      sql: "UPDATE mbt_rate_components SET amount_minor = 1 WHERE rate_component_id = $1",
      params: [componentId]
    },
    {
      sql: "DELETE FROM mbt_rate_components WHERE rate_component_id = $1",
      params: [componentId]
    },
    {
      sql: `INSERT INTO mbt_rate_components (
              rate_component_id, rate_card_version_id, component_code,
              component_kind, rate_basis, amount_minor, currency
            ) VALUES ($1, $2, 'late_fee', 'other', 'flat', 1, 'CAD')`,
      params: [crypto.randomUUID(), contract.rate_card_version_id]
    }
  ]) {
    await assert.rejects(
      () => pool.query(statement.sql, statement.params),
      (error) => error?.code === "55000"
    );
  }

  const newVersionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       validation_snapshot, created_by, updated_by
     ) VALUES ($1, $2, 2, 'draft', '{}'::jsonb, 'p1-test', 'p1-test')`,
    [newVersionId, contract.rate_card_id]
  );
  await pool.query(
    `INSERT INTO mbt_rate_components (
       rate_component_id, rate_card_version_id, component_code,
       component_kind, rate_basis, amount_minor, currency
     ) VALUES ($1, $2, 'base_transport', 'base_transport', 'flat', 13000, 'CAD')`,
    [crypto.randomUUID(), newVersionId]
  );
  const retained = await pool.query(
    `SELECT amount_minor::int AS amount_minor
       FROM mbt_rate_components
      WHERE rate_component_id = $1`,
    [componentId]
  );
  assert.deepEqual(retained.rows, [{ amount_minor: 12500 }]);
});

test("F11: approved billing versions and lines reject mutation; corrections append a new version", async () => {
  const billingCaseId = crypto.randomUUID();
  const originalVersionId = crypto.randomUUID();
  const originalLineId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_billing_cases (
       billing_case_id, case_type, contract_id, customer_netsuite_id,
       status, currency, current_version_number, revision, created_by, updated_by
     ) VALUES ($1, 'mbt_contract', $2, $3, 'approved', 'CAD', 1, 1, 'p1-test', 'p1-test')`,
    [billingCaseId, fixture.contractId, contract.customer_netsuite_id]
  );
  await pool.query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       billing_case_revision_before, approved_by, approval_reason,
       approved_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, 'draft', $3, '{}'::jsonb, '{}'::jsonb,
       12500, 1625, 14125, 'CAD', 1, 'p1-billing', 'initial approval', now(), $4, $5
     )`,
    [originalVersionId, billingCaseId, contract.rate_card_version_id, `corr-${billingCaseId}`, `idem-${billingCaseId}-1`]
  );
  await pool.query(
    `INSERT INTO mbt_billing_lines (
       billing_line_id, billing_version_id, sequence_number, line_key, line_type,
       description, quantity, unit_of_measure, unit_amount_minor,
       net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
       revenue_class, source_entity_type, source_entity_id,
       netsuite_item_mapping_key, calculation_detail
     ) VALUES (
       $1, $2, 0, 'legacy:0', 'transport', 'Transport', 1, 'EA', 12500,
       12500, 1625, 14125, 'CAD', 'transport', 'contract', $3,
       'transport.service', '{}'::jsonb
     )`,
    [originalLineId, originalVersionId, fixture.contractId]
  );
  await pool.query(
    "UPDATE mbt_billing_versions SET status = 'approved' WHERE billing_version_id = $1",
    [originalVersionId]
  );

  for (const statement of [
    {
      sql: "UPDATE mbt_billing_versions SET subtotal_minor = 1 WHERE billing_version_id = $1",
      params: [originalVersionId]
    },
    {
      sql: "DELETE FROM mbt_billing_versions WHERE billing_version_id = $1",
      params: [originalVersionId]
    },
    {
      sql: "UPDATE mbt_billing_lines SET description = 'rewritten' WHERE billing_line_id = $1",
      params: [originalLineId]
    },
    {
      sql: "DELETE FROM mbt_billing_lines WHERE billing_line_id = $1",
      params: [originalLineId]
    },
    {
      sql: `INSERT INTO mbt_billing_lines (
              billing_line_id, billing_version_id, sequence_number, line_key, line_type,
              description, quantity, unit_of_measure, unit_amount_minor,
              net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
              revenue_class, source_entity_type, source_entity_id,
              netsuite_item_mapping_key, calculation_detail
            ) VALUES (
              $1, $2, 1, 'legacy:1', 'other', 'Late line', 1, 'EA', 1,
              1, 0, 1, 'CAD', 'other', 'contract', $3,
              'other.late', '{}'::jsonb
            )`,
      params: [crypto.randomUUID(), originalVersionId, fixture.contractId]
    }
  ]) {
    await assert.rejects(
      () => pool.query(statement.sql, statement.params),
      (error) => error?.code === "55000"
    );
  }

  const correctionVersionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       billing_case_revision_before, approved_by, approval_reason,
       approved_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 2, 'approved', $3, '{"correctsVersion":1}'::jsonb, '{}'::jsonb,
       13000, 1690, 14690, 'CAD', 1, 'p1-billing', 'append-only correction', now(), $4, $5
     )`,
    [correctionVersionId, billingCaseId, contract.rate_card_version_id, `corr-${billingCaseId}-2`, `idem-${billingCaseId}-2`]
  );
  const versions = await pool.query(
    `SELECT version_number, subtotal_minor::int AS subtotal_minor
       FROM mbt_billing_versions
      WHERE billing_case_id = $1
      ORDER BY version_number`,
    [billingCaseId]
  );
  assert.deepEqual(versions.rows, [
    { version_number: 1, subtotal_minor: 12500 },
    { version_number: 2, subtotal_minor: 13000 }
  ]);
});

test("F11: billing-line creation and version finalization serialize on the parent row", async () => {
  const setupClient = await pool.connect();
  let isolatedFixture;
  let isolatedContract;
  try {
    isolatedFixture = await createAssetFixture(setupClient, { assetCount: 1, visitCount: 1 });
    const selected = await setupClient.query(
      `SELECT c.customer_netsuite_id, c.rate_card_version_id
         FROM mbt_contracts c
        WHERE c.contract_id = $1`,
      [isolatedFixture.contractId]
    );
    isolatedContract = selected.rows[0];
  } finally {
    setupClient.release();
  }

  const billingCaseId = crypto.randomUUID();
  const billingVersionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_billing_cases (
       billing_case_id, case_type, contract_id, customer_netsuite_id,
       status, currency, current_version_number, revision, created_by, updated_by
     ) VALUES ($1, 'mbt_contract', $2, $3, 'approved', 'CAD', 1, 1, 'p1-test', 'p1-test')`,
    [billingCaseId, isolatedFixture.contractId, isolatedContract.customer_netsuite_id]
  );
  await pool.query(
    `INSERT INTO mbt_billing_versions (
       billing_version_id, billing_case_id, version_number, status,
       rate_card_version_id, calculation_snapshot, source_revision_snapshot,
       subtotal_minor, estimated_tax_minor, total_minor, currency,
       billing_case_revision_before, approved_by, approval_reason,
       approved_at, correlation_id, idempotency_key
     ) VALUES (
       $1, $2, 1, 'draft', $3, '{}'::jsonb, '{}'::jsonb,
       100, 13, 113, 'CAD', 1, 'p1-billing', 'lock ordering', now(), $4, $5
     )`,
    [
      billingVersionId,
      billingCaseId,
      isolatedContract.rate_card_version_id,
      `corr-${billingCaseId}`,
      `idem-${billingCaseId}`
    ]
  );

  const lineClient = await pool.connect();
  const finalizeClient = await pool.connect();
  try {
    await lineClient.query("BEGIN");
    await lineClient.query(
      `INSERT INTO mbt_billing_lines (
         billing_line_id, billing_version_id, sequence_number, line_key, line_type,
         description, quantity, unit_of_measure, unit_amount_minor,
         net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
         revenue_class, source_entity_type, source_entity_id,
         netsuite_item_mapping_key, calculation_detail
       ) VALUES (
         $1, $2, 0, 'legacy:0', 'transport', 'Serialized line', 1, 'EA', 100,
         100, 13, 113, 'CAD', 'transport', 'contract', $3,
         'transport.serialized', '{}'::jsonb
       )`,
      [crypto.randomUUID(), billingVersionId, isolatedFixture.contractId]
    );

    await finalizeClient.query("BEGIN");
    await finalizeClient.query("SET LOCAL lock_timeout = '100ms'");
    await assert.rejects(
      () => finalizeClient.query(
        "UPDATE mbt_billing_versions SET status = 'approved' WHERE billing_version_id = $1",
        [billingVersionId]
      ),
      (error) => error?.code === "55P03"
    );
    await finalizeClient.query("ROLLBACK");
    await lineClient.query("COMMIT");

    await pool.query(
      "UPDATE mbt_billing_versions SET status = 'approved' WHERE billing_version_id = $1",
      [billingVersionId]
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO mbt_billing_lines (
           billing_line_id, billing_version_id, sequence_number, line_key, line_type,
           description, quantity, unit_of_measure, unit_amount_minor,
           net_amount_minor, estimated_tax_minor, total_amount_minor, currency,
           revenue_class, source_entity_type, source_entity_id,
           netsuite_item_mapping_key, calculation_detail
         ) VALUES (
           $1, $2, 1, 'legacy:1', 'other', 'Too late', 1, 'EA', 1,
           1, 0, 1, 'CAD', 'other', 'contract', $3,
           'other.too_late', '{}'::jsonb
         )`,
        [crypto.randomUUID(), billingVersionId, isolatedFixture.contractId]
      ),
      (error) => error?.code === "55000"
    );
  } finally {
    await lineClient.query("ROLLBACK").catch(() => null);
    await finalizeClient.query("ROLLBACK").catch(() => null);
    lineClient.release();
    finalizeClient.release();
  }
});

test("F11: cross-charge cases deduplicate SO/PO/VRMA by load and TO globally by root", async () => {
  async function insertCase(sourceType, rootReference, physicalLoadId) {
    return pool.query(
      `INSERT INTO mbt_cross_charge_cases (
         cross_charge_case_id, source_type, root_reference, physical_load_id,
         plan_date, truck_id, driver_id, rate_card_version_id,
         calculated_metres, base_amount_minor, downtown_surcharge_minor,
         allocated_amount_minor, currency, source_snapshot,
         calculation_snapshot, completed_load_at, deduplication_key
       ) VALUES (
         $1, $2, $3, $4, '2035-02-04'::date, $5, $6, $7,
         1000, 10000, 0, 10000, 'CAD', '{}'::jsonb, '{}'::jsonb, now(), $8
       )`,
      [
        crypto.randomUUID(),
        sourceType,
        rootReference,
        physicalLoadId,
        fixture.truckId,
        fixture.driverId,
        contract.rate_card_version_id,
        sourceType === "TO"
          ? `${sourceType}|${rootReference}`
          : `${sourceType}|${rootReference}|${physicalLoadId}`
      ]
    );
  }

  for (const sourceType of ["SO", "PO", "VRMA"]) {
    const root = `${sourceType}-${fixture.fixtureId}`;
    const load = `${sourceType}-LOAD-1-${fixture.fixtureId}`;
    await insertCase(sourceType, root, load);
    await assert.rejects(
      () => insertCase(sourceType, root, load),
      (error) => error?.code === "23505"
    );
    await assert.doesNotReject(() => insertCase(sourceType, root, `${sourceType}-LOAD-2-${fixture.fixtureId}`));
  }

  const transferRoot = `TO-${fixture.fixtureId}`;
  await insertCase("TO", transferRoot, `TO-LOAD-1-${fixture.fixtureId}`);
  await assert.rejects(
    () => insertCase("TO", transferRoot, `TO-LOAD-2-${fixture.fixtureId}`),
    (error) => error?.code === "23505"
  );
  const retained = await pool.query(
    `SELECT source_type, count(*)::int AS count
       FROM mbt_cross_charge_cases
      WHERE root_reference LIKE $1
      GROUP BY source_type
      ORDER BY source_type`,
    [`%${fixture.fixtureId}`]
  );
  assert.deepEqual(retained.rows, [
    { source_type: "PO", count: 2 },
    { source_type: "SO", count: 2 },
    { source_type: "TO", count: 1 },
    { source_type: "VRMA", count: 2 }
  ]);
});

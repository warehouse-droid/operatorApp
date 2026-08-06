import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import pg from "pg";

import { createAssetFixture } from "../support/asset-fixtures.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let fixture;
let contractContext;

before(async () => {
  const client = await pool.connect();
  try {
    fixture = await createAssetFixture(client, { assetCount: 1, visitCount: 1 });
    const context = await client.query(
      `SELECT customer_netsuite_id, customer_site_profile_id,
              service_template_version_id, rate_card_version_id, bin_type_id
         FROM mbt_contracts
        WHERE contract_id = $1`,
      [fixture.contractId]
    );
    contractContext = context.rows[0];
  } finally {
    client.release();
  }
});

after(async () => {
  await pool.end();
});

async function createRateCard() {
  const rateCardId = crypto.randomUUID();
  const suffix = rateCardId.replaceAll("-", "");
  await pool.query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, created_by, updated_by
     ) VALUES ($1, $2, $3, 'rate-lifecycle-test', 'rate-lifecycle-test')`,
    [rateCardId, `P1-RATE-${suffix}`, `Rate lifecycle ${suffix}`]
  );
  return rateCardId;
}

async function createDraftVersion() {
  const rateCardId = await createRateCard();
  const rateCardVersionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       validation_snapshot, created_by, updated_by
     ) VALUES (
       $1, $2, 1, 'draft', '{}'::jsonb,
       'rate-lifecycle-test', 'rate-lifecycle-test'
     )`,
    [rateCardVersionId, rateCardId]
  );
  return { rateCardId, rateCardVersionId };
}

async function insertBand(rateCardVersionId, minimumMetres, maximumMetres, sequenceNumber) {
  const rateDistanceBandId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code,
       sequence_number, minimum_metres, maximum_metres,
       amount_minor, currency, description
     ) VALUES ($1, $2, 'delivery', $3, $4, $5, 10000, 'CAD', 'Lifecycle test')`,
    [
      rateDistanceBandId,
      rateCardVersionId,
      sequenceNumber,
      minimumMetres,
      maximumMetres
    ]
  );
  return rateDistanceBandId;
}

async function activate(rateCardVersionId) {
  return pool.query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = 'rate-lifecycle-test'
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
}

function quoteInsert(quoteId, quoteNumber, rateCardVersionId) {
  return {
    sql: `INSERT INTO mbt_quotes (
            quote_id, quote_number, customer_netsuite_id,
            customer_site_profile_id, service_template_version_id,
            rate_card_version_id, bin_type_id, status,
            customer_snapshot, site_snapshot, pricing_snapshot,
            issued_at, created_by, updated_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, 'issued',
            '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            now(), 'rate-lifecycle-test', 'rate-lifecycle-test'
          )`,
    params: [
      quoteId,
      quoteNumber,
      contractContext.customer_netsuite_id,
      contractContext.customer_site_profile_id,
      contractContext.service_template_version_id,
      rateCardVersionId,
      contractContext.bin_type_id
    ]
  };
}

test("F09: database activation rejects every structurally invalid distance-band set", async (t) => {
  const cases = [
    { name: "empty", bands: [] },
    {
      name: "does not begin at zero",
      bands: [[1, null]]
    },
    {
      name: "gap",
      bands: [[0, 100], [101, null]]
    },
    {
      name: "overlap",
      bands: [[0, 100], [99, null]]
    },
    {
      name: "non-final open band",
      bands: [[0, null], [100, null]]
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { rateCardVersionId } = await createDraftVersion();
      for (const [index, [minimum, maximum]] of scenario.bands.entries()) {
        await insertBand(rateCardVersionId, minimum, maximum, index);
      }
      await assert.rejects(
        () => activate(rateCardVersionId),
        (error) => error?.code === "23514"
      );
      const retained = await pool.query(
        `SELECT status, effective_from, activated_at, revision::int AS revision
           FROM mbt_rate_card_versions
          WHERE rate_card_version_id = $1`,
        [rateCardVersionId]
      );
      assert.deepEqual(retained.rows, [{
        status: "draft",
        effective_from: null,
        activated_at: null,
        revision: 1
      }]);
    });
  }
});

test("F09: an active version cannot bypass the draft, bands, activate lifecycle", async () => {
  const rateCardId = await createRateCard();
  await assert.rejects(
    () => pool.query(
      `INSERT INTO mbt_rate_card_versions (
         rate_card_version_id, rate_card_id, version_number, status,
         effective_from, activated_at, validation_snapshot, created_by, updated_by
       ) VALUES (
         $1, $2, 1, 'active', now(), now(), '{}'::jsonb,
         'rate-lifecycle-test', 'rate-lifecycle-test'
       )`,
      [crypto.randomUUID(), rateCardId]
    ),
    (error) => error?.code === "23514"
  );
});

test("F09: a contiguous zero-based band set with one final open band activates", async () => {
  const { rateCardVersionId } = await createDraftVersion();
  await insertBand(rateCardVersionId, 0, 100, 0);
  await insertBand(rateCardVersionId, 100, null, 1);

  await assert.doesNotReject(() => activate(rateCardVersionId));
  const activated = await pool.query(
    `SELECT status, effective_from IS NOT NULL AS effective,
            activated_at IS NOT NULL AS activated, revision::int AS revision
       FROM mbt_rate_card_versions
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  assert.deepEqual(activated.rows, [{
    status: "active",
    effective: true,
    activated: true,
    revision: 2
  }]);
});

test("F09: first non-draft quote use requires an active rate version", async () => {
  const { rateCardVersionId } = await createDraftVersion();
  await insertBand(rateCardVersionId, 0, null, 0);
  const quoteId = crypto.randomUUID();
  const statement = quoteInsert(quoteId, `P1-Q-DRAFT-${quoteId}`, rateCardVersionId);

  await assert.rejects(
    () => pool.query(statement.sql, statement.params),
    (error) => error?.code === "55000"
  );
  const retained = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mbt_quotes WHERE quote_id = $1) AS quote_count,
       first_used_at
       FROM mbt_rate_card_versions
      WHERE rate_card_version_id = $2`,
    [quoteId, rateCardVersionId]
  );
  assert.deepEqual(retained.rows, [{ quote_count: 0, first_used_at: null }]);
});

test("F09: quote first-use stamping is atomic and exact", async () => {
  const { rateCardVersionId } = await createDraftVersion();
  await insertBand(rateCardVersionId, 0, null, 0);
  await activate(rateCardVersionId);

  const rolledBackQuoteId = crypto.randomUUID();
  const rolledBackStatement = quoteInsert(
    rolledBackQuoteId,
    `P1-Q-ROLLBACK-${rolledBackQuoteId}`,
    rateCardVersionId
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(rolledBackStatement.sql, rolledBackStatement.params);
    const insideTransaction = await client.query(
      `SELECT first_used_entity_type, first_used_entity_id
         FROM mbt_rate_card_versions
        WHERE rate_card_version_id = $1`,
      [rateCardVersionId]
    );
    assert.deepEqual(insideTransaction.rows, [{
      first_used_entity_type: "quote",
      first_used_entity_id: rolledBackQuoteId
    }]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }

  const rolledBack = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM mbt_quotes WHERE quote_id = $1) AS quote_count,
       first_used_at, first_used_entity_type, first_used_entity_id
       FROM mbt_rate_card_versions
      WHERE rate_card_version_id = $2`,
    [rolledBackQuoteId, rateCardVersionId]
  );
  assert.deepEqual(rolledBack.rows, [{
    quote_count: 0,
    first_used_at: null,
    first_used_entity_type: null,
    first_used_entity_id: null
  }]);

  const committedQuoteId = crypto.randomUUID();
  const committedStatement = quoteInsert(
    committedQuoteId,
    `P1-Q-COMMIT-${committedQuoteId}`,
    rateCardVersionId
  );
  await pool.query(committedStatement.sql, committedStatement.params);
  const committed = await pool.query(
    `SELECT first_used_at IS NOT NULL AS first_used,
            first_used_entity_type, first_used_entity_id
       FROM mbt_rate_card_versions
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  assert.deepEqual(committed.rows, [{
    first_used: true,
    first_used_entity_type: "quote",
    first_used_entity_id: committedQuoteId
  }]);
});

test("F09: active contract creation stamps and locks its rate version children", async () => {
  const used = await pool.query(
    `SELECT first_used_at IS NOT NULL AS first_used,
            first_used_entity_type, first_used_entity_id
       FROM mbt_rate_card_versions
      WHERE rate_card_version_id = $1`,
    [contractContext.rate_card_version_id]
  );
  assert.deepEqual(used.rows, [{
    first_used: true,
    first_used_entity_type: "contract",
    first_used_entity_id: fixture.contractId
  }]);

  const band = await pool.query(
    `SELECT rate_distance_band_id
       FROM mbt_rate_distance_bands
      WHERE rate_card_version_id = $1`,
    [contractContext.rate_card_version_id]
  );
  assert.equal(band.rowCount, 1);
  await assert.rejects(
    () => pool.query(
      `UPDATE mbt_rate_distance_bands
          SET amount_minor = amount_minor + 1
        WHERE rate_distance_band_id = $1`,
      [band.rows[0].rate_distance_band_id]
    ),
    (error) => error?.code === "55000"
  );
});

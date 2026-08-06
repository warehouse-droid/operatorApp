import crypto from "node:crypto";

const BIN_TYPE_ID = "00000000-0000-4000-8000-000000000020";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * @typedef {import("pg").PoolClient} PoolClient
 */

/**
 * @typedef {object} AssetFixture
 * @property {string} fixtureId
 * @property {string} yardId
 * @property {string} yardCode
 * @property {string} customerSiteProfileId
 * @property {string} templateVersionId
 * @property {string} templateStepId
 * @property {string} templateEvidenceRequirementId
 * @property {string} rateCardId
 * @property {string} rateCardVersionId
 * @property {string} rateComponentId
 * @property {string} contractId
 * @property {string[]} visitIds
 * @property {string} truckId
 * @property {string} truckPlate
 * @property {string} driverId
 * @property {{assetId: string, assetCode: string, initialMovementId: string}[]} assets
 */

/**
 * @param {PoolClient} client
 * @param {{assetCount?: number, visitCount?: number}} [options]
 * @returns {Promise<AssetFixture>}
 */
export async function createAssetFixture(client, { assetCount = 1, visitCount = 1 } = {}) {
  const fixtureId = crypto.randomUUID().replaceAll("-", "");
  const customerId = (BigInt(`0x${fixtureId.slice(0, 12)}`) + 1n).toString();
  const yardId = "00000000-0000-4000-8000-000000012441";
  const yardCode = "12441";
  const addressId = crypto.randomUUID();
  const customerSiteProfileId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const templateVersionId = crypto.randomUUID();
  const templateStepId = crypto.randomUUID();
  const templateEvidenceRequirementId = crypto.randomUUID();
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  const rateDistanceBandId = crypto.randomUUID();
  const rateComponentId = crypto.randomUUID();
  const contractId = crypto.randomUUID();

  await client.query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, $3, 'CAD', now(), 'asset-fixture-v1', $4)`,
    [customerId, `P1-C-${fixtureId}`, `Asset fixture customer ${fixtureId}`, HASH_A]
  );
  await client.query(
    `INSERT INTO netsuite_customer_addresses (
       address_id, customer_netsuite_id, netsuite_address_id, label,
       address_line_1, city, region, postal_code, country_code,
       source_modified_at, source_version, payload_hash
     ) VALUES ($1, $2, $3, 'Asset test site', '1 Test Lane',
               'Toronto', 'ON', 'M1M 1M1', 'CA', now(), 'asset-fixture-v1', $4)`,
    [addressId, customerId, `P1-A-${fixtureId}`, HASH_B]
  );
  await client.query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id, created_by, updated_by
     ) VALUES ($1, $2, $3, 'mbt-test', 'mbt-test')`,
    [customerSiteProfileId, customerId, addressId]
  );
  await client.query(
    `INSERT INTO mbt_service_templates (
       template_id, template_code, display_name, created_by, updated_by
     ) VALUES ($1, $2, $3, 'mbt-test', 'mbt-test')`,
    [templateId, `p1_asset_${fixtureId}`, `Asset fixture template ${fixtureId}`]
  );
  await client.query(
    `INSERT INTO mbt_service_template_versions (
       template_version_id, template_id, version_number, status,
       created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', 'mbt-test', 'mbt-test')`,
    [templateVersionId, templateId]
  );
  await client.query(
    `INSERT INTO mbt_service_template_steps (
       template_step_id, template_version_id, sequence_number, action_code,
       display_name, stop_kind, location_role
     ) VALUES (
       $1, $2, 0, 'deliver_bin', 'Deliver bin', 'customer', 'customer_site'
     )`,
    [templateStepId, templateVersionId]
  );
  await client.query(
    `INSERT INTO mbt_service_template_evidence_requirements (
       evidence_requirement_id, template_version_id, template_step_id,
       evidence_code, evidence_type, minimum_count, required
     ) VALUES ($1, $2, $3, 'delivery_photo', 'photo', 1, true)`,
    [templateEvidenceRequirementId, templateVersionId, templateStepId]
  );
  await client.query(
    `UPDATE mbt_service_template_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = 'mbt-test'
      WHERE template_version_id = $1`,
    [templateVersionId]
  );
  await client.query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, service_template_id,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, 'mbt-test', 'mbt-test')`,
    [rateCardId, `P1-R-${fixtureId}`, `Asset fixture rate ${fixtureId}`, templateId]
  );
  await client.query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', 'mbt-test', 'mbt-test')`,
    [rateCardVersionId, rateCardId]
  );
  await client.query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code,
       sequence_number, minimum_metres, maximum_metres,
       amount_minor, currency, description
     ) VALUES (
       $1, $2, 'delivery', 0, 0, NULL, 12500, 'CAD', 'Fixture delivery rate'
     )`,
    [rateDistanceBandId, rateCardVersionId]
  );
  await client.query(
    `INSERT INTO mbt_rate_components (
       rate_component_id, rate_card_version_id, component_code,
       component_kind, service_code, rate_basis,
       amount_minor, currency, description
     ) VALUES (
       $1, $2, 'base_transport', 'base_transport', 'delivery', 'flat',
       12500, 'CAD', 'Fixture base transport'
     )`,
    [rateComponentId, rateCardVersionId]
  );
  await client.query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = 'mbt-test'
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  await client.query(
    `INSERT INTO mbt_contracts (
       contract_id, contract_number, customer_netsuite_id,
       customer_site_profile_id, service_template_version_id,
       rate_card_version_id, bin_type_id, status, customer_snapshot,
       site_snapshot, terms_snapshot, tax_snapshot, pricing_snapshot,
       activated_at, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'active', $8::jsonb,
       $8::jsonb, $8::jsonb, $8::jsonb, $8::jsonb,
       now(), 'mbt-test', 'mbt-test'
     )`,
    [
      contractId,
      `P1-CONT-${fixtureId}`,
      customerId,
      customerSiteProfileId,
      templateVersionId,
      rateCardVersionId,
      BIN_TYPE_ID,
      JSON.stringify({ fixtureId })
    ]
  );

  const visitIds = [];
  for (let index = 0; index < visitCount; index += 1) {
    const visitId = crypto.randomUUID();
    visitIds.push(visitId);
    await client.query(
      `INSERT INTO mbt_service_visits (
         service_visit_id, contract_id, visit_number, visit_reference,
         service_template_version_id, service_action, status,
         customer_site_profile_id, bin_type_id, scheduled_start_at,
         scheduled_end_at, customer_snapshot, site_snapshot, service_snapshot,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, 'delivery', 'ready', $6, $7,
         $8::timestamptz, $9::timestamptz, $10::jsonb, $10::jsonb,
         $10::jsonb, 'mbt-test', 'mbt-test'
       )`,
      [
        visitId,
        contractId,
        index + 1,
        `P1-V-${fixtureId}-${index + 1}`,
        templateVersionId,
        customerSiteProfileId,
        BIN_TYPE_ID,
        `2035-01-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
        `2035-01-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
        JSON.stringify({ fixtureId, visit: index + 1 })
      ]
    );
  }

  const truckPlate = `P1T${fixtureId.slice(0, 10)}`;
  const truck = await client.query(
    `INSERT INTO dispatch_trucks (plate)
     VALUES ($1)
     RETURNING id::text AS id`,
    [truckPlate]
  );
  const driver = await client.query(
    `INSERT INTO dispatch_drivers (name, login)
     VALUES ($1, $2)
     RETURNING id::text AS id`,
    [`Asset fixture driver ${fixtureId}`, `p1_driver_${fixtureId}`]
  );

  const assets = [];
  for (let index = 0; index < assetCount; index += 1) {
    const assetId = crypto.randomUUID();
    const initialMovementId = crypto.randomUUID();
    const assetCode = `P1-BIN-${fixtureId}-${index + 1}`;
    await client.query(
      `INSERT INTO mbt_bin_assets (
         asset_id, asset_code, bin_type_id, home_yard_id, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, 'mbt-test', 'mbt-test')`,
      [assetId, assetCode, BIN_TYPE_ID, yardId]
    );
    await client.query(
      `WITH inserted_movement AS (
         INSERT INTO mbt_bin_movements (
           movement_id, asset_id, asset_sequence, movement_type,
           before_status, after_status, before_location_kind,
           after_location_kind, after_location_reference, to_yard_id,
           source, actor_type, actor_id, occurred_at
         ) VALUES (
           $1, $2, 1, 'asset_registered', NULL, 'available', NULL,
           'yard', $3, $4, 'test_fixture', 'system', 'mbt-test', now()
         )
         RETURNING movement_id, occurred_at
       )
       INSERT INTO mbt_bin_asset_state (
         asset_id, lifecycle_status, location_kind, location_reference,
         yard_id, last_movement_id, revision, changed_at
       )
       SELECT $2, 'available', 'yard', $3, $4, movement_id, 1, occurred_at
         FROM inserted_movement`,
      [initialMovementId, assetId, yardCode, yardId]
    );
    assets.push({ assetId, assetCode, initialMovementId });
  }

  return {
    fixtureId,
    yardId,
    yardCode,
    customerSiteProfileId,
    templateVersionId,
    templateStepId,
    templateEvidenceRequirementId,
    rateCardId,
    rateCardVersionId,
    rateComponentId,
    contractId,
    visitIds,
    truckId: truck.rows[0].id,
    truckPlate,
    driverId: driver.rows[0].id,
    assets
  };
}

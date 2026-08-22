import crypto from "node:crypto";

import { query } from "../../../src/db.js";

export const FRONTDESK_BIN_TYPE_ID = "00000000-0000-4000-8000-000000000014";
export const FRONTDESK_BIN_ITEM_CODE = "14YD";
export const FRONTDESK_DELIVERY_ITEM_CODE = "DELIVERY_CROSS_CHARGE";
export const FRONTDESK_DUMP_ITEM_CODE = "DUMP";
export const FRONTDESK_PRICING = Object.freeze({
  currency: "CAD",
  distanceMetres: 12_500,
  transportMinor: 12_500,
  rentalMinor: 35_000,
  subtotalMinor: 47_500,
  taxBasisPoints: 1_300,
  taxMinor: 6_175,
  totalMinor: 53_675,
  depositRequiredMinor: 10_000
});

const CUSTOMER_HASH = "8".repeat(64);
const ADDRESS_HASH = "9".repeat(64);
const ROUTE_HASH = "7".repeat(64);

/** @param {string} value */
function compact(value) {
  return value.replaceAll("-", "");
}

/** @param {string} runId */
function syntheticCustomerId(runId) {
  return String(8_600_000_000_000n + (BigInt(`0x${compact(runId).slice(0, 12)}`) % 1_000_000_000_000n));
}

/** @param {string} runId */
function syntheticSubsidiaryId(runId) {
  return String(6_600_000_000_000n + (BigInt(`0x${compact(runId).slice(12, 24)}`) % 1_000_000_000_000n));
}

async function ensureItemRateCard(itemCode, insertChildren) {
  const existing = await query(
    `SELECT version.rate_card_version_id::text
       FROM mbt_rate_cards card
       JOIN mbt_rate_card_versions version ON version.rate_card_id = card.rate_card_id
      WHERE card.item_code = $1 AND card.active AND version.status = 'active'
      LIMIT 1`,
    [itemCode]
  );
  if (existing.rowCount) {
    return String(existing.rows[0].rate_card_version_id);
  }
  const rateCardId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, item_code, currency,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, 'CAD', 'p3-frontdesk-test', 'p3-frontdesk-test')`,
    [rateCardId, `P3-FD-ITEM-${itemCode}`, `Synthetic ${itemCode} item rate`, itemCode]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, calculation_notes, created_by, updated_by
     ) VALUES ($1, $2, 1, 'draft', '2020-01-01T00:00:00.000Z',
       'Synthetic Front Desk itemized pricing', 'p3-frontdesk-test', 'p3-frontdesk-test')`,
    [versionId, rateCardId]
  );
  await insertChildren(versionId);
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', activated_at = now(), revision = revision + 1,
            updated_by = 'p3-frontdesk-test', updated_at = now()
      WHERE rate_card_version_id = $1`,
    [versionId]
  );
  return versionId;
}

async function ensureFrontdeskItemPricing() {
  for (const [itemCode, binTypeId, rentalMinor] of [
    ["14YD", "00000000-0000-4000-8000-000000000014", 35_000],
    ["20YD", "00000000-0000-4000-8000-000000000020", 21_000],
    ["40YD", "00000000-0000-4000-8000-000000000040", 30_000]
  ]) {
    await ensureItemRateCard(itemCode, async (versionId) => {
      for (const [kind, serviceCode, basis, amountMinor] of [
        ["rental", "delivery", "flat", rentalMinor],
        ["extension", "extension", "per_day", 0]
      ]) {
        await query(
          `INSERT INTO mbt_rate_components (
             rate_component_id, rate_card_version_id, item_code,
             component_code, component_kind, service_code, bin_type_id,
             rate_basis, amount_minor, percentage_basis_points,
             default_quantity, currency, taxable, active, description
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL,
             1, 'CAD', true, true, $10)`,
          [
            crypto.randomUUID(), versionId, itemCode, `${kind}_${itemCode.toLowerCase()}`,
            kind, serviceCode, binTypeId, basis, amountMinor,
            `Synthetic ${itemCode} ${kind}`
          ]
        );
      }
    });
  }
  await ensureItemRateCard(FRONTDESK_DELIVERY_ITEM_CODE, async (versionId) => {
    for (const [binTypeId, amountMinor] of [
      ["00000000-0000-4000-8000-000000000014", 12_500],
      ["00000000-0000-4000-8000-000000000020", 19_000],
      ["00000000-0000-4000-8000-000000000040", 25_000]
    ]) {
      await query(
        `INSERT INTO mbt_rate_distance_bands (
           rate_distance_band_id, rate_card_version_id, item_code,
           service_code, bin_type_id, sequence_number, minimum_metres,
           maximum_metres, amount_minor, currency, description
         ) VALUES ($1, $2, $3, 'delivery', $4, 0, 0, NULL, $5, 'CAD',
           'Synthetic one-way BIN delivery')`,
        [crypto.randomUUID(), versionId, FRONTDESK_DELIVERY_ITEM_CODE, binTypeId, amountMinor]
      );
    }
  });
  await ensureItemRateCard(FRONTDESK_DUMP_ITEM_CODE, async (versionId) => {
    const material = await query(
      "SELECT material_id::text FROM mbt_materials WHERE material_code = $1 AND active",
      [FRONTDESK_DUMP_ITEM_CODE]
    );
    if (!material.rowCount) {
      throw new Error("Synthetic Front Desk dump material is missing.");
    }
    await query(
      `INSERT INTO mbt_dump_tariffs (
         dump_tariff_id, rate_card_version_id, item_code, dump_site_id,
         material_id, tariff_code, pricing_basis, unit_of_measure,
         amount_minor, minimum_amount_minor, currency, active, description
       ) VALUES ($1, $2, $3, NULL, $4, 'customer_dump_estimate',
         'per_weight', 'TONNE', 0, 0, 'CAD', true,
         'Synthetic zero-value dump estimate for legacy total compatibility')`,
      [crypto.randomUUID(), versionId, FRONTDESK_DUMP_ITEM_CODE, material.rows[0].material_id]
    );
  });
}

/**
 * Create only synthetic, local prerequisites for one Front Desk quote. This
 * fixture never creates a quote, contract, visit, billing case, outbox row, or
 * record in an established SCM/Dispatch/Driver/Operator domain.
 *
 * @param {{label?: string, rateEffectiveFrom?: string | Date | null}} [options]
 */
export async function createFrontdeskPrerequisites({
  label = "fixture",
  rateEffectiveFrom = null
} = {}) {
  await ensureFrontdeskItemPricing();
  const runId = crypto.randomUUID();
  const suffix = compact(runId);
  const customerNetsuiteId = syntheticCustomerId(runId);
  const subsidiaryNetsuiteId = syntheticSubsidiaryId(runId);
  const addressId = crypto.randomUUID();
  const siteProfileId = crypto.randomUUID();
  const templateId = crypto.randomUUID();
  const templateVersionId = crypto.randomUUID();
  const templateStepId = crypto.randomUUID();
  const templateEvidenceRequirementId = crypto.randomUUID();
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  const rateDistanceBandId = crypto.randomUUID();
  const rentalComponentId = crypto.randomUUID();
  const depositRuleId = crypto.randomUUID();
  const marker = `P3-FD-${label}-${suffix}`;

  await query(
    `INSERT INTO netsuite_customers (
       netsuite_id, entity_number, legal_name, display_name, currency,
       terms, tax_status, credit_status, email, phone, active,
       source_modified_at, source_version, payload_hash
     ) VALUES (
       $1, $2, $3, $3, 'CAD', 'NET 30', 'taxable', 'good',
       $4, '+1-555-0100', true, now(), $5, $6
     )`,
    [
      customerNetsuiteId,
      marker,
      `Synthetic Front Desk Customer ${suffix}`,
      `${suffix}@example.invalid`,
      `frontdesk-fixture-${suffix}`,
      CUSTOMER_HASH
    ]
  );
  await query(
    `INSERT INTO netsuite_customer_subsidiaries (
       customer_netsuite_id, subsidiary_netsuite_id, relationship_name,
       primary_relationship, currency, terms, tax_status, credit_status,
       active, source_modified_at, source_version, payload_hash
     ) VALUES (
       $1, $2, 'Synthetic configured MBT subsidiary', true, 'CAD', 'NET 30',
       'taxable', 'good', true, now(), $3, $4
     )`,
    [customerNetsuiteId, subsidiaryNetsuiteId, `frontdesk-fixture-${suffix}`, CUSTOMER_HASH]
  );
  await query(
    `INSERT INTO netsuite_customer_addresses (
       address_id, customer_netsuite_id, netsuite_address_id, label,
       shipping_default, addressee, address_line_1, city, region,
       postal_code, country_code, active, source_modified_at,
       source_version, payload_hash
     ) VALUES (
       $1, $2, $3, 'Synthetic service site', true, $4,
       '100 Test Route', 'Toronto', 'ON', 'M1M 1M1', 'CA', true,
       now(), $5, $6
     )`,
    [
      addressId,
      customerNetsuiteId,
      `P3-FD-ADDR-${suffix}`,
      `Synthetic Front Desk Customer ${suffix}`,
      `frontdesk-fixture-${suffix}`,
      ADDRESS_HASH
    ]
  );
  await query(
    `INSERT INTO mbt_customer_site_profiles (
       site_profile_id, customer_netsuite_id, address_id,
       site_instructions, access_restrictions, geocode_latitude,
       geocode_longitude, created_by, updated_by
     ) VALUES (
       $1, $2, $3, 'Use the synthetic test entrance', 'No live access',
       43.653226, -79.383184, 'p3-frontdesk-test', 'p3-frontdesk-test'
     )`,
    [siteProfileId, customerNetsuiteId, addressId]
  );
  await query(
    `INSERT INTO mbt_service_templates (
       template_id, template_code, display_name, description,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, 'p3-frontdesk-test', 'p3-frontdesk-test')`,
    [
      templateId,
      `p3_fd_delivery_${suffix}`,
      `Synthetic 14YD delivery ${suffix}`,
      "Synthetic Front Desk delivery/return contract template"
    ]
  );
  await query(
    `INSERT INTO mbt_service_template_versions (
       template_version_id, template_id, version_number, status,
       default_rental_calendar_days, billing_ownership,
       created_by, updated_by
     ) VALUES (
       $1, $2, 1, 'draft', 14, 'customer',
       'p3-frontdesk-test', 'p3-frontdesk-test'
     )`,
    [templateVersionId, templateId]
  );
  await query(
    `INSERT INTO mbt_service_template_steps (
       template_step_id, template_version_id, sequence_number, action_code,
       display_name, stop_kind, location_role, required,
       required_asset_status_before, required_asset_status_after,
       completion_blocking
     ) VALUES (
       $1, $2, 0, 'deliver_bin', 'Deliver 14YD bin', 'customer',
       'customer_site', true, 'on_truck', 'at_customer', true
     )`,
    [templateStepId, templateVersionId]
  );
  await query(
    `INSERT INTO mbt_service_template_evidence_requirements (
       evidence_requirement_id, template_version_id, template_step_id,
       evidence_code, evidence_type, minimum_count, required
     ) VALUES ($1, $2, $3, 'delivery_photo', 'photo', 1, true)`,
    [templateEvidenceRequirementId, templateVersionId, templateStepId]
  );
  await query(
    `UPDATE mbt_service_template_versions
        SET status = 'active', effective_from = now(), activated_at = now(),
            revision = revision + 1, updated_by = 'p3-frontdesk-test'
      WHERE template_version_id = $1`,
    [templateVersionId]
  );
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, subsidiary_netsuite_id, service_template_id,
       created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, 'p3-frontdesk-test', 'p3-frontdesk-test')`,
    [rateCardId, `P3-FD-RATE-${suffix}`, `Synthetic Front Desk rate ${suffix}`, subsidiaryNetsuiteId, templateId]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       created_by, updated_by
     ) VALUES (
       $1, $2, 1, 'draft', 'p3-frontdesk-test', 'p3-frontdesk-test'
     )`,
    [rateCardVersionId, rateCardId]
  );
  await query(
    `INSERT INTO mbt_rate_distance_bands (
       rate_distance_band_id, rate_card_version_id, service_code,
       bin_type_id, sequence_number, minimum_metres, maximum_metres,
       amount_minor, currency, description
     ) VALUES (
       $1, $2, 'delivery', $3, 0, 0, NULL, $4, 'CAD',
       'Synthetic exact-distance transport'
     )`,
    [
      rateDistanceBandId,
      rateCardVersionId,
      FRONTDESK_BIN_TYPE_ID,
      FRONTDESK_PRICING.transportMinor
    ]
  );
  await query(
    `INSERT INTO mbt_rate_components (
       rate_component_id, rate_card_version_id, component_code,
       component_kind, service_code, bin_type_id, rate_basis,
       amount_minor, currency, taxable, description
     ) VALUES (
       $1, $2, 'rental_14_day', 'rental', 'delivery', $3, 'flat',
       $4, 'CAD', true, 'Synthetic 14-day rental'
     )`,
    [rentalComponentId, rateCardVersionId, FRONTDESK_BIN_TYPE_ID, FRONTDESK_PRICING.rentalMinor]
  );
  await query(
    `INSERT INTO mbt_deposit_rules (
       deposit_rule_id, rate_card_version_id, rule_code, rule_type,
       bin_type_id, fixed_amount_minor, currency,
       liability_account_mapping_key, description
     ) VALUES (
       $1, $2, 'bin_deposit_14yd', 'bin_type', $3, $4, 'CAD',
       'local_bin_deposit', 'Synthetic local-only deposit requirement'
     )`,
    [depositRuleId, rateCardVersionId, FRONTDESK_BIN_TYPE_ID, FRONTDESK_PRICING.depositRequiredMinor]
  );
  await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', effective_from = COALESCE($2::timestamptz, now()), activated_at = now(),
            revision = revision + 1, updated_by = 'p3-frontdesk-test'
      WHERE rate_card_version_id = $1`,
    [rateCardVersionId, rateEffectiveFrom]
  );

  return {
    runId,
    marker,
    customerNetsuiteId,
    subsidiaryNetsuiteId,
    addressId,
    siteProfileId,
    templateId,
    templateVersionId,
    templateStepId,
    templateEvidenceRequirementId,
    rateCardId,
    rateCardVersionId,
    rateDistanceBandId,
    rentalComponentId,
    depositRuleId,
    binTypeId: FRONTDESK_BIN_TYPE_ID,
    binItemCode: FRONTDESK_BIN_ITEM_CODE,
    deliveryItemCode: FRONTDESK_DELIVERY_ITEM_CODE,
    dumpItemCode: FRONTDESK_DUMP_ITEM_CODE,
    estimatedTonnes: "1.000",
    serviceCode: "delivery",
    proposedDeliveryAt: "2037-08-03T12:00:00.000Z",
    proposedReturnAt: "2037-08-17T12:00:00.000Z"
  };
}

/** @param {ReturnType<typeof createFrontdeskPrerequisites> extends Promise<infer T> ? T : never} fixture */
export function frontdeskDistanceResolver(fixture) {
  return async () => ({
    provider: "synthetic_route_engine",
    providerMetres: FRONTDESK_PRICING.distanceMetres,
    routeHash: ROUTE_HASH,
    originSnapshot: { kind: "yard", yardCode: "12441" },
    destinationSnapshot: {
      kind: "customer_site",
      siteProfileId: fixture.siteProfileId,
      addressId: fixture.addressId
    },
    routeSnapshot: { fixture: fixture.marker }
  });
}

export async function frontdeskTaxResolver() {
  return {
    code: "ON_HST_13",
    basisPoints: FRONTDESK_PRICING.taxBasisPoints,
    label: "Ontario HST"
  };
}

/**
 * @param {Awaited<ReturnType<typeof createFrontdeskPrerequisites>>} fixture
 * @param {{actor: {operatorId: string, roles: readonly string[]}, identity: string}} command
 */
export function quoteCommand(fixture, { actor, identity }) {
  return {
    actor,
    customerNetsuiteId: fixture.customerNetsuiteId,
    siteProfileId: fixture.siteProfileId,
    serviceTemplateVersionId: fixture.templateVersionId,
    rateCardVersionId: fixture.rateCardVersionId,
    binItemCode: fixture.binItemCode,
    binTypeId: fixture.binTypeId,
    deliveryItemCode: fixture.deliveryItemCode,
    dumpItemCode: fixture.dumpItemCode,
    estimatedTonnes: fixture.estimatedTonnes,
    surcharges: [],
    serviceCode: fixture.serviceCode,
    proposedDeliveryAt: fixture.proposedDeliveryAt,
    proposedReturnAt: fixture.proposedReturnAt,
    clientDisplayTotals: {
      subtotalMinor: 1,
      taxMinor: 1,
      totalMinor: 2
    },
    reason: "Create a synthetic local-only Front Desk quote",
    idempotencyKey: `p3-frontdesk-create-${identity}`,
    correlationId: `p3-frontdesk-corr-${identity}`,
    requestId: `p3-frontdesk-req-${identity}`
  };
}

/**
 * @param {string} prefix
 * @param {{operatorId: string, roles: readonly string[]}} actor
 * @param {Record<string, unknown>} fields
 */
export function frontdeskCommand(prefix, actor, fields) {
  const identity = `${prefix}-${compact(crypto.randomUUID())}`;
  return {
    actor,
    reason: `Synthetic Front Desk ${prefix}`,
    idempotencyKey: `p3-frontdesk-${identity}`,
    correlationId: `p3-frontdesk-corr-${identity}`,
    requestId: `p3-frontdesk-req-${identity}`,
    ...fields
  };
}

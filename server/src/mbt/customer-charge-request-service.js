// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { createDispatchCustomOrder } from "../dispatch-custom-order-repository.js";
import { executeMbtCommand } from "./command-repository.js";
import { calculateCustomerCharge } from "./customer-charge-calculator.js";
import { calculateDistanceBandChargeMinor } from "./distance-band-pricing.js";
import { MbtError } from "./errors.js";

const FRONTDESK_ROLES = new Set(["admin", "mbt_admin", "mbt_frontdesk"]);
const ADMIN_ROLES = new Set(["admin", "mbt_admin"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE_CONTRACT_STATUSES = new Set(["confirmed", "active", "return_due"]);
const CONFIGURED_AGGREGATE_CODES = Object.freeze([
  "AGG_CLEAR_LIMESTONE_34",
  "AGG_CRUSHER_RUN",
  "AGG_HPB",
  "AGG_SCREENING"
]);
const CONFIGURED_FIXED_DUMP_CODES = Object.freeze([
  "DUMP_SOIL",
  "DUMP_ASPHALT",
  "DUMP_CONCRETE"
]);

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function failure(status, code, message, details = {}) {
  return new MbtError({ status, code, message, details });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is required.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function requiredUuid(value, label) {
  const normalized = requiredText(value, label);
  if (!UUID_PATTERN.test(normalized)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be a UUID.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function optionalUuid(value, label) {
  return value === null || value === undefined || String(value).trim() === ""
    ? null
    : requiredUuid(value, label);
}

/** @param {unknown} value @param {string} label */
function positiveRevision(value, label = "Expected revision") {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be a positive integer.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} must be a non-negative integer.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label @param {number} maximum */
function snapshotText(value, label, maximum) {
  const text = requiredText(value, label);
  if (text.length > maximum) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be ${maximum} characters or fewer.`);
  }
  return text;
}

/** @param {unknown} value @param {string} label */
function itemCode(value, label) {
  const code = requiredText(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_]{0,63}$/u.test(code)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is invalid.`);
  }
  return code;
}

/** @param {unknown} value @param {string} label */
function quantityMilliYards(value, label) {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,4})(?:\.(\d{1,3}))?$/u.exec(text);
  if (!match) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must use YARD with at most three decimals.`);
  }
  const quantity = (Number(match[1]) * 1_000) + Number((match[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be between 0.001 and 1,000 yards.`);
  }
  return quantity;
}

/** @param {{operatorId?: unknown, roles?: readonly unknown[]}} actor */
function assertFrontdeskActor(actor) {
  const operatorId = requiredText(actor?.operatorId, "Operator ID");
  const roles = Array.isArray(actor?.roles) ? actor.roles.map(String) : [];
  if (!roles.some((role) => FRONTDESK_ROLES.has(role))) {
    throw failure(403, "MBT_FRONTDESK_FORBIDDEN", "MBT Front Desk access is required.");
  }
  return { operatorId, roles };
}

/** @param {{operatorId?: unknown, roles?: readonly unknown[]}} actor */
function assertAdminActor(actor) {
  const normalized = assertFrontdeskActor(actor);
  if (!normalized.roles.some((role) => ADMIN_ROLES.has(String(role).trim().toLowerCase()))) {
    throw failure(403, "MBT_ADMIN_REQUIRED", "MBT customer-charge configuration requires an Admin account.");
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function positiveConfigurationInteger(value, label) {
  const normalized = nonnegativeInteger(value, label);
  if (normalized === 0) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} must be greater than zero.`);
  }
  return normalized;
}

/** @param {unknown} value */
function configurationExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Expected configuration revision must be zero or greater.");
  }
  return Number(value);
}

/** @param {unknown} value @param {readonly string[]} expectedCodes @param {string} label */
function exactConfiguredItems(value, expectedCodes, label) {
  if (!Array.isArray(value) || value.length !== expectedCodes.length) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} must contain every supported item exactly once.`);
  }
  const rows = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} row ${index + 1} is invalid.`);
    }
    const row = /** @type {Record<string, unknown>} */ (raw);
    return {
      itemCode: itemCode(row.itemCode, `${label} item code`),
      amountMinor: positiveConfigurationInteger(row.amountMinor, `${label} amount`),
      ...(label === "Aggregate pricing"
        ? { densityLbsPerYard: positiveConfigurationInteger(row.densityLbsPerYard, `${label} density`) }
        : {})
    };
  }).sort((left, right) => left.itemCode.localeCompare(right.itemCode));
  if (new Set(rows.map((row) => row.itemCode)).size !== rows.length
      || rows.some((row, index) => row.itemCode !== [...expectedCodes].sort()[index])) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} contains an unsupported or duplicate item.`);
  }
  return rows;
}

/** @param {Record<string, any>} band @param {number} index @param {Record<string, any> | undefined} previous */
function assertConfiguredAggregateDistanceBand(band, index, previous) {
  const invalidRange = band.maximumMetres !== null && band.maximumMetres <= band.minimumMetres;
  const invalidBase = index === 0
    && (band.minimumMetres !== 0 || band.maximumMetres !== 30_000 || band.amountMinor !== 15_000);
  const invalidLater = index > 0
    && (!previous || previous.maximumMetres !== band.minimumMetres || band.amountMinor <= previous.amountMinor);
  if ([invalidRange, invalidBase, invalidLater].some(Boolean)) {
    throw failure(
      422,
      "MBT_FRONTDESK_CONFIGURATION_INVALID",
      "Aggregate distance bands must be contiguous, start with CAD 150 through 30 km, and increase thereafter."
    );
  }
}

/** @param {unknown} value */
function configuredAggregateDistanceBands(value) {
  if (!Array.isArray(value)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "Aggregate distance bands must be an array.");
  }
  if (value.length === 0 || value.length > 20) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "Provide between one and twenty aggregate distance bands.");
  }
  const codes = new Set();
  const bands = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `Aggregate distance band ${index + 1} is invalid.`);
    }
    const row = /** @type {Record<string, unknown>} */ (raw);
    const bandCode = itemCode(row.bandCode, `Aggregate distance band ${index + 1} code`);
    if (codes.has(bandCode)) {
      throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "Aggregate distance band codes must be unique.");
    }
    codes.add(bandCode);
    return {
      bandCode,
      minimumMetres: nonnegativeInteger(row.minimumMetres, `Aggregate distance band ${index + 1} minimum`),
      maximumMetres: row.maximumMetres === null
        ? null
        : positiveConfigurationInteger(row.maximumMetres, `Aggregate distance band ${index + 1} maximum`),
      amountMinor: positiveConfigurationInteger(row.amountMinor, `Aggregate distance band ${index + 1} amount`),
      description: String(row.description || "").trim().slice(0, 2_000)
    };
  }).sort((left, right) => left.minimumMetres - right.minimumMetres);
  for (const [index, band] of bands.entries()) {
    assertConfiguredAggregateDistanceBand(band, index, bands[index - 1]);
  }
  return bands;
}

/** @param {Record<string, unknown>} input */
function normalizedCustomerChargeConfiguration(input) {
  return {
    aggregateItems: exactConfiguredItems(input.aggregateItems, CONFIGURED_AGGREGATE_CODES, "Aggregate pricing"),
    fixedDumpItems: exactConfiguredItems(input.fixedDumpItems, CONFIGURED_FIXED_DUMP_CODES, "Fixed dump pricing"),
    aggregateDistanceBands: configuredAggregateDistanceBands(input.aggregateDistanceBands)
  };
}

/** @param {unknown} value @param {string} label */
function requestKind(value, label = "Request kind") {
  const kind = requiredText(value, label).toLowerCase();
  if (!["initial_bin", "add_bin", "exchange_bin", "aggregate_order"].includes(kind)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} is not supported.`);
  }
  return kind;
}

/** @param {unknown} value @param {string} label */
function timestamp(value, label) {
  const parsed = new Date(requiredText(value, label));
  if (!Number.isFinite(parsed.getTime())) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${label} must be an ISO timestamp.`);
  }
  return parsed.toISOString();
}

/** @param {number} left @param {number} right @param {string} label */
function safeAdd(left, right, label) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", `${label} exceeds safe integer cents.`);
  }
  return result;
}

/** @param {number} amountMinor @param {number} basisPoints */
function percentageAmount(amountMinor, basisPoints) {
  const product = BigInt(amountMinor) * BigInt(basisPoints);
  const result = Number((product + 5_000n) / 10_000n);
  if (!Number.isSafeInteger(result)) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The deposit amount exceeds safe integer cents.");
  }
  return result;
}

/** @param {any} row */
function chargeRequestDto(row) {
  const snapshot = row.pricing_snapshot && typeof row.pricing_snapshot === "object"
    ? row.pricing_snapshot
    : {};
  const calculation = snapshot.calculation && typeof snapshot.calculation === "object"
    ? snapshot.calculation
    : snapshot;
  return {
    ...calculation,
    chargeRequestId: String(row.charge_request_id),
    requestNumber: String(row.request_number),
    status: String(row.status),
    contractId: row.contract_id ? String(row.contract_id) : null,
    serviceLineId: row.service_line_id ? String(row.service_line_id) : null,
    rateCardVersionId: row.rate_card_version_id ? String(row.rate_card_version_id) : null,
    billingAddressText: String(row.billing_address_text),
    serviceAddressText: String(row.service_address_text),
    contractTelephone: String(row.contract_telephone),
    reason: String(row.reason),
    revision: Number(row.revision),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null,
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : null
  };
}

/** @param {string} rateCardVersionId */
async function assertActiveRateVersion(rateCardVersionId) {
  const result = await query(
    `SELECT version.rate_card_version_id::text, version.status, card.currency, card.active
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card ON card.rate_card_id = version.rate_card_id
      WHERE version.rate_card_version_id = $1::uuid`,
    [rateCardVersionId]
  );
  if (!result.rowCount || result.rows[0].status !== "active" || !result.rows[0].active) {
    throw failure(409, "MBT_FRONTDESK_RATE_NOT_ACTIVE", "The selected MBT rate version is not active.");
  }
  if (String(result.rows[0].currency) !== "CAD") {
    throw failure(422, "MBT_FRONTDESK_CURRENCY_MISMATCH", "Customer charge requests require a CAD rate card.");
  }
}

/** @param {string} rateCardVersionId */
async function configuredChargeCatalog(rateCardVersionId) {
  const configuration = await query(
      `SELECT revision::int, complete
         FROM mbt_frontdesk_charge_configurations
        WHERE rate_card_version_id = $1::uuid`,
      [rateCardVersionId]
    );
  const catalog = await query(
      `SELECT catalog.item_code, catalog.display_name, catalog.description,
              catalog.item_kind, catalog.content_code, catalog.unit_of_measure,
              catalog.default_amount_minor, catalog.density_lbs_per_yard,
              catalog.netsuite_mapping_local_key,
              rate.charge_rate_id::text, rate.amount_minor, rate.currency
         FROM mbt_frontdesk_charge_catalog catalog
         LEFT JOIN mbt_frontdesk_charge_rates rate
           ON rate.item_code = catalog.item_code
          AND rate.rate_card_version_id = $1::uuid
          AND rate.active
        WHERE catalog.active
        ORDER BY catalog.item_code`,
      [rateCardVersionId]
    );
  const bands = await query(
      `SELECT aggregate_distance_band_id::text, band_code,
              sequence_number::int, minimum_metres::int, maximum_metres::int,
              amount_minor, currency, description
         FROM mbt_frontdesk_aggregate_distance_bands
        WHERE rate_card_version_id = $1::uuid AND active
        ORDER BY sequence_number, aggregate_distance_band_id`,
      [rateCardVersionId]
    );
  return {
    configuration: configuration.rows[0] || null,
    catalog: catalog.rows,
    bands: bands.rows
  };
}

/**
 * Return only complete active configuration. Inactive seeded definitions stay
 * visible in the MBT database but cannot leak into Front Desk pricing.
 *
 * @param {Record<string, unknown>} input
 */
export async function getFrontdeskCustomerChargeConfiguration(input) {
  assertFrontdeskActor(/** @type {any} */ (input.actor));
  const rateCardVersionId = requiredUuid(input.rateCardVersionId, "Rate card version ID");
  await assertActiveRateVersion(rateCardVersionId);
  const { configuration, catalog, bands } = await configuredChargeCatalog(rateCardVersionId);
  const aggregateItems = catalog
    .filter((/** @type {any} */ row) => row.item_kind === "aggregate_material"
      && row.charge_rate_id && Number(row.density_lbs_per_yard) > 0)
    .map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      description: String(row.description || ""),
      unitOfMeasure: "YARD",
      unitAmountMinor: Number(row.amount_minor),
      densityLbsPerYard: Number(row.density_lbs_per_yard),
      netsuiteMappingLocalKey: row.netsuite_mapping_local_key
        ? String(row.netsuite_mapping_local_key)
        : null
    }));
  const fixedDumpItems = catalog
    .filter((/** @type {any} */ row) => row.item_kind === "fixed_dump" && row.charge_rate_id)
    .map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      contentCode: String(row.content_code),
      unitOfMeasure: "BIN",
      amountMinor: Number(row.amount_minor)
    }));
  const loading = catalog.find((/** @type {any} */ row) => row.item_kind === "loading_fee");
  return {
    schemaVersion: "mbt-frontdesk-customer-charge-configuration-v1",
    rateCardVersionId,
    configurationRevision: Number(configuration?.revision || 0),
    complete: configuration?.complete === true,
    paymentMethods: ["cash", "card", "debit", "e_transfer", "cheque", "account"],
    binContents: [
      { contentCode: "garbage", displayName: "Garbage", allowedBinSizesYards: [14, 20, 40], dumpPricing: "none" },
      { contentCode: "soil", displayName: "Soil", allowedBinSizesYards: [14], dumpPricing: "fixed_per_bin" },
      { contentCode: "asphalt", displayName: "Asphalt", allowedBinSizesYards: [14], dumpPricing: "fixed_per_bin" },
      { contentCode: "concrete", displayName: "Concrete", allowedBinSizesYards: [14], dumpPricing: "fixed_per_bin" }
    ],
    aggregateItems,
    fixedDumpItems,
    aggregateLoadingFeeMinor: loading
      ? Number(loading.amount_minor ?? loading.default_amount_minor ?? 0)
      : null,
    aggregateDistanceBands: bands.map((/** @type {any} */ row) => ({
      aggregateDistanceBandId: String(row.aggregate_distance_band_id),
      bandCode: String(row.band_code),
      minimumMetres: Number(row.minimum_metres),
      maximumMetres: row.maximum_metres === null ? null : Number(row.maximum_metres),
      amountMinor: Number(row.amount_minor),
      currency: String(row.currency),
      description: String(row.description || "")
    }))
  };
}

/** @param {string} rateCardVersionId @param {boolean} [lock] */
async function configurableRateVersion(rateCardVersionId, lock = false) {
  const result = await query(
    `SELECT version.rate_card_version_id::text, version.status,
            card.rate_card_code, card.display_name, card.currency, card.active
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
      WHERE version.rate_card_version_id = $1::uuid
      ${lock ? "FOR UPDATE OF version" : ""}`,
    [rateCardVersionId]
  );
  if (!result.rowCount) {
    throw failure(404, "MBT_FRONTDESK_RATE_NOT_FOUND", "The selected MBT rate-card version was not found.");
  }
  if (String(result.rows[0].currency) !== "CAD") {
    throw failure(422, "MBT_FRONTDESK_CURRENCY_MISMATCH", "Customer charge requests require a CAD rate card.");
  }
  return result.rows[0];
}

/** @param {Record<string, any> | undefined} row */
function loadingAmountMinor(row) {
  return row ? Number(row.default_amount_minor ?? row.amount_minor ?? 0) : null;
}

/** @param {unknown} value */
function optionalTextEvidence(value) {
  return value ? String(value) : null;
}

/** @param {unknown} value */
function optionalTimestampEvidence(value) {
  return value ? new Date(/** @type {string | number | Date} */ (value)).toISOString() : null;
}

/** @param {string} rateCardVersionId */
async function customerChargeAdminDto(rateCardVersionId) {
  const version = await configurableRateVersion(rateCardVersionId);
  const configuration = await query(
      `SELECT revision::int, complete, updated_by,
              created_at, updated_at
         FROM mbt_frontdesk_charge_configurations
        WHERE rate_card_version_id = $1::uuid`,
      [rateCardVersionId]
    );
  const catalog = await query(
      `SELECT catalog.item_code, catalog.display_name, catalog.description,
              catalog.item_kind, catalog.content_code, catalog.unit_of_measure,
              catalog.default_amount_minor, catalog.density_lbs_per_yard,
              catalog.netsuite_mapping_local_key, catalog.active AS catalog_active,
              rate.amount_minor, rate.active AS rate_active, rate.revision::int AS rate_revision
         FROM mbt_frontdesk_charge_catalog catalog
         LEFT JOIN mbt_frontdesk_charge_rates rate
           ON rate.item_code = catalog.item_code
          AND rate.rate_card_version_id = $1::uuid
        ORDER BY catalog.item_code`,
      [rateCardVersionId]
    );
  const bands = await query(
      `SELECT aggregate_distance_band_id::text, band_code,
              sequence_number::int, minimum_metres::int, maximum_metres::int,
              amount_minor, currency, description, active, revision::int
         FROM mbt_frontdesk_aggregate_distance_bands
        WHERE rate_card_version_id = $1::uuid
        ORDER BY sequence_number, aggregate_distance_band_id`,
      [rateCardVersionId]
    );
  const aggregateItems = catalog.rows
    .filter((/** @type {any} */ row) => CONFIGURED_AGGREGATE_CODES.includes(String(row.item_code)))
    .map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      description: String(row.description || ""),
      amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
      densityLbsPerYard: row.density_lbs_per_yard === null ? null : Number(row.density_lbs_per_yard),
      unitOfMeasure: "YARD",
      netsuiteMappingLocalKey: row.netsuite_mapping_local_key
        ? String(row.netsuite_mapping_local_key)
        : null
    }));
  const fixedDumpItems = catalog.rows
    .filter((/** @type {any} */ row) => CONFIGURED_FIXED_DUMP_CODES.includes(String(row.item_code)))
    .map((/** @type {any} */ row) => ({
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      contentCode: String(row.content_code),
      amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
      unitOfMeasure: "BIN",
      netsuiteMappingLocalKey: row.netsuite_mapping_local_key
        ? String(row.netsuite_mapping_local_key)
        : null
    }));
  const loading = catalog.rows.find((/** @type {any} */ row) => String(row.item_code) === "AGG_LOADING");
  return {
    schemaVersion: "mbt-frontdesk-customer-charge-admin-configuration-v1",
    rateCardVersionId,
    rateCardCode: String(version.rate_card_code),
    rateCardDisplayName: String(version.display_name),
    rateCardStatus: String(version.status),
    revision: Number(configuration.rows[0]?.revision || 0),
    complete: configuration.rows[0]?.complete === true,
    aggregateLoadingFeeMinor: loadingAmountMinor(loading),
    aggregateItems,
    fixedDumpItems,
    aggregateDistanceBands: bands.rows.map((/** @type {any} */ row) => ({
      aggregateDistanceBandId: String(row.aggregate_distance_band_id),
      bandCode: String(row.band_code),
      sequenceNumber: Number(row.sequence_number),
      minimumMetres: Number(row.minimum_metres),
      maximumMetres: row.maximum_metres === null ? null : Number(row.maximum_metres),
      amountMinor: Number(row.amount_minor),
      currency: String(row.currency),
      description: String(row.description || ""),
      active: row.active === true,
      revision: Number(row.revision)
    })),
    updatedBy: optionalTextEvidence(configuration.rows[0]?.updated_by),
    createdAt: optionalTimestampEvidence(configuration.rows[0]?.created_at),
    updatedAt: optionalTimestampEvidence(configuration.rows[0]?.updated_at)
  };
}

/**
 * Read the complete local-only pricing sheet, including inactive/unconfigured
 * seeded definitions. This never reads or writes NetSuite.
 *
 * @param {Record<string, unknown>} input
 */
export async function getFrontdeskCustomerChargeAdminConfiguration(input) {
  assertAdminActor(/** @type {any} */ (input.actor));
  const rateCardVersionId = requiredUuid(input.rateCardVersionId, "Rate card version ID");
  return customerChargeAdminDto(rateCardVersionId);
}

/** @param {string} rateCardVersionId @param {Record<string, any>} configuration @param {string} operatorId */
async function storeCustomerChargeConfiguration(rateCardVersionId, configuration, operatorId) {
  const catalog = await query(
    `SELECT item_code, item_kind, default_amount_minor
       FROM mbt_frontdesk_charge_catalog
      WHERE item_code = ANY($1::text[])
      ORDER BY item_code
      FOR UPDATE`,
    [[...CONFIGURED_AGGREGATE_CODES, ...CONFIGURED_FIXED_DUMP_CODES, "AGG_LOADING"]]
  );
  const configuredCodes = new Set(catalog.rows.map((/** @type {any} */ row) => String(row.item_code)));
  const requiredCodes = [...CONFIGURED_AGGREGATE_CODES, ...CONFIGURED_FIXED_DUMP_CODES, "AGG_LOADING"];
  if (requiredCodes.some((code) => !configuredCodes.has(code))) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The seeded customer-charge catalog is incomplete.");
  }
  const loading = catalog.rows.find((/** @type {any} */ row) => String(row.item_code) === "AGG_LOADING");
  if (Number(loading?.default_amount_minor) !== 5_000) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The aggregate loading fee must remain CAD 50 per combined visit.");
  }
  for (const aggregate of configuration.aggregateItems) {
    await query(
      `UPDATE mbt_frontdesk_charge_catalog
          SET density_lbs_per_yard = $2, active = true,
              revision = revision + 1, updated_by = $3, updated_at = now()
        WHERE item_code = $1`,
      [aggregate.itemCode, aggregate.densityLbsPerYard, operatorId]
    );
  }
  await query(
    `UPDATE mbt_frontdesk_charge_catalog
        SET active = true, revision = revision + 1,
            updated_by = $2, updated_at = now()
      WHERE item_code = ANY($1::text[])`,
    [CONFIGURED_FIXED_DUMP_CODES, operatorId]
  );
  for (const configured of [...configuration.aggregateItems, ...configuration.fixedDumpItems]) {
    await query(
      `INSERT INTO mbt_frontdesk_charge_rates (
         charge_rate_id, rate_card_version_id, item_code, amount_minor,
         currency, active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, 'CAD', true, 1, $5, $5)
       ON CONFLICT (rate_card_version_id, item_code) DO UPDATE
         SET amount_minor = EXCLUDED.amount_minor,
             currency = 'CAD', active = true,
             revision = mbt_frontdesk_charge_rates.revision + 1,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [crypto.randomUUID(), rateCardVersionId, configured.itemCode, configured.amountMinor, operatorId]
    );
  }
  await query(
    "DELETE FROM mbt_frontdesk_aggregate_distance_bands WHERE rate_card_version_id = $1::uuid",
    [rateCardVersionId]
  );
  for (const [index, band] of configuration.aggregateDistanceBands.entries()) {
    await query(
      `INSERT INTO mbt_frontdesk_aggregate_distance_bands (
         aggregate_distance_band_id, rate_card_version_id, band_code,
         sequence_number, minimum_metres, maximum_metres, amount_minor,
         currency, description, active, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAD', $8, true, 1, $9, $9)`,
      [crypto.randomUUID(), rateCardVersionId, band.bandCode, index + 1,
        band.minimumMetres, band.maximumMetres, band.amountMinor, band.description, operatorId]
    );
  }
}

/**
 * Atomically replace one rate card's complete customer-charge sheet. Pricing
 * evidence already attached to requests remains immutable; this command never
 * creates NetSuite work.
 *
 * @param {Record<string, any>} input
 */
export async function replaceFrontdeskCustomerChargeConfiguration(input) {
  const actor = assertAdminActor(input.actor);
  const rateCardVersionId = requiredUuid(input.rateCardVersionId, "Rate card version ID");
  const expectedRevision = configurationExpectedRevision(input.expectedRevision);
  const reason = snapshotText(input.reason, "Audit reason", 2_000);
  const configuration = normalizedCustomerChargeConfiguration(input);
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.customer_charge_configuration.replace",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    payload: { rateCardVersionId, expectedRevision, configuration, reason },
    mutation: async () => {
      await configurableRateVersion(rateCardVersionId, true);
      const existing = await query(
        `SELECT revision::int, complete
           FROM mbt_frontdesk_charge_configurations
          WHERE rate_card_version_id = $1::uuid
          FOR UPDATE`,
        [rateCardVersionId]
      );
      const actualRevision = Number(existing.rows[0]?.revision || 0);
      if (actualRevision !== expectedRevision) {
        throw failure(409, "MBT_STALE_REVISION", "Customer-charge pricing changed. Refresh before saving.");
      }
      await storeCustomerChargeConfiguration(rateCardVersionId, configuration, actor.operatorId);
      if (actualRevision === 0) {
        await query(
          `INSERT INTO mbt_frontdesk_charge_configurations (
             rate_card_version_id, complete, revision, created_by, updated_by
           ) VALUES ($1, true, 1, $2, $2)`,
          [rateCardVersionId, actor.operatorId]
        );
      } else {
        const updated = await query(
          `UPDATE mbt_frontdesk_charge_configurations
              SET complete = true, revision = revision + 1,
                  updated_by = $3, updated_at = now()
            WHERE rate_card_version_id = $1::uuid AND revision = $2
            RETURNING revision::int`,
          [rateCardVersionId, expectedRevision, actor.operatorId]
        );
        if (!updated.rowCount) {
          throw failure(409, "MBT_STALE_REVISION", "Customer-charge pricing lost an optimistic update race.");
        }
      }
      const saved = await customerChargeAdminDto(rateCardVersionId);
      return {
        status: actualRevision === 0 ? 201 : 200,
        body: {
          schemaVersion: "mbt-frontdesk-customer-charge-admin-configuration-command-v1",
          configuration: saved
        },
        audit: {
          action: "mbt.frontdesk.customer_charge_configuration.replaced",
          entityType: "mbt_frontdesk_charge_configuration",
          entityId: rateCardVersionId,
          beforeState: { revision: actualRevision, complete: existing.rows[0]?.complete === true },
          afterState: { revision: saved.revision, complete: true },
          reason,
          revisionBefore: Math.max(1, actualRevision),
          revisionAfter: saved.revision,
          source: "local"
        }
      };
    }
  });
}

/** @param {Record<string, any>} input @param {string} rateCardVersionId */
async function aggregateRateLines(input, rateCardVersionId) {
  if (!Array.isArray(input.aggregateLines) || input.aggregateLines.length === 0) {
    return [];
  }
  const requested = input.aggregateLines.map((value, index) => {
    const line = value && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, any>} */ (value)
      : {};
    return {
      itemCode: itemCode(line.itemCode, `Aggregate line ${index + 1} item`),
      quantityMilliYards: quantityMilliYards(line.quantityYards, `Aggregate line ${index + 1} quantity`)
    };
  });
  if (new Set(requested.map((line) => line.itemCode)).size !== requested.length) {
    throw failure(400, "MBT_FRONTDESK_AGGREGATE_DUPLICATE", "Aggregate material lines must be distinct.");
  }
  const selected = await query(
    `SELECT catalog.item_code, catalog.display_name, catalog.density_lbs_per_yard,
            rate.amount_minor, rate.currency
       FROM mbt_frontdesk_charge_catalog catalog
       JOIN mbt_frontdesk_charge_rates rate
         ON rate.item_code = catalog.item_code
        AND rate.rate_card_version_id = $2::uuid
        AND rate.active
      WHERE catalog.item_code = ANY($1::text[])
        AND catalog.item_kind = 'aggregate_material'
        AND catalog.active
        AND catalog.unit_of_measure = 'YARD'
        AND catalog.density_lbs_per_yard > 0`,
    [requested.map((line) => line.itemCode), rateCardVersionId]
  );
  if (selected.rowCount !== requested.length) {
    throw failure(422, "MBT_FRONTDESK_AGGREGATE_RATE_MISSING", "Every aggregate material needs an active MBT per-yard rate and density.");
  }
  const byCode = new Map(selected.rows.map((/** @type {any} */ row) => [String(row.item_code), row]));
  return requested.map((line) => {
    const rate = byCode.get(line.itemCode);
    if (!rate) {
      throw failure(422, "MBT_FRONTDESK_AGGREGATE_RATE_MISSING", "An aggregate material rate changed during pricing.");
    }
    return {
      itemCode: line.itemCode,
      displayName: String(rate.display_name),
      quantityMilliYards: line.quantityMilliYards,
      unitAmountMinor: nonnegativeInteger(Number(rate.amount_minor), "Aggregate unit amount"),
      densityLbsPerYard: nonnegativeInteger(Number(rate.density_lbs_per_yard), "Aggregate density")
    };
  });
}

/** @param {string} rateCardVersionId */
async function aggregateDistanceBands(rateCardVersionId) {
  const result = await query(
    `SELECT band_code, minimum_metres::int, maximum_metres::int, amount_minor
       FROM mbt_frontdesk_aggregate_distance_bands
      WHERE rate_card_version_id = $1::uuid AND active
      ORDER BY sequence_number, aggregate_distance_band_id`,
    [rateCardVersionId]
  );
  return result.rows.map((/** @type {any} */ row) => ({
    bandCode: String(row.band_code),
    minimumMetres: Number(row.minimum_metres),
    maximumMetres: row.maximum_metres === null ? null : Number(row.maximum_metres),
    amountMinor: Number(row.amount_minor)
  }));
}

/** @param {string} rateCardVersionId */
async function loadingFeeMinor(rateCardVersionId) {
  const selected = await query(
    `SELECT COALESCE(rate.amount_minor, catalog.default_amount_minor) AS amount_minor
       FROM mbt_frontdesk_charge_catalog catalog
       LEFT JOIN mbt_frontdesk_charge_rates rate
         ON rate.item_code = catalog.item_code
        AND rate.rate_card_version_id = $1::uuid
        AND rate.active
      WHERE catalog.item_code = 'AGG_LOADING'
        AND catalog.item_kind = 'loading_fee'
        AND catalog.active`,
    [rateCardVersionId]
  );
  if (!selected.rowCount || selected.rows[0].amount_minor === null) {
    throw failure(422, "MBT_FRONTDESK_LOADING_RATE_MISSING", "The aggregate loading fee is not configured.");
  }
  return nonnegativeInteger(Number(selected.rows[0].amount_minor), "Aggregate loading fee");
}

/** @param {string} contractId @param {number} expectedRevision */
async function contractPricingSubject(contractId, expectedRevision) {
  const selected = await query(
    `SELECT contract.*, customer.display_name AS customer_display_name,
            customer.phone AS customer_phone
       FROM mbt_contracts contract
       JOIN netsuite_customers customer ON customer.netsuite_id = contract.customer_netsuite_id
      WHERE contract.contract_id = $1::uuid
      FOR SHARE OF contract, customer`,
    [contractId]
  );
  if (!selected.rowCount) {
    throw failure(404, "MBT_FRONTDESK_CONTRACT_NOT_FOUND", "The MBT contract was not found.");
  }
  const row = selected.rows[0];
  if (!ACTIVE_CONTRACT_STATUSES.has(String(row.status))) {
    throw failure(409, "MBT_FRONTDESK_CONTRACT_STATE_CONFLICT", "This contract cannot accept a priced request in its current state.");
  }
  if (Number(row.revision) !== expectedRevision) {
    throw failure(409, "MBT_STALE_REVISION", "The contract changed. Refresh and recalculate the request.");
  }
  return row;
}

/** @param {Record<string, any>} contract */
async function currentContractTotalMinor(contract) {
  const pricing = contract.pricing_snapshot && typeof contract.pricing_snapshot === "object"
    ? contract.pricing_snapshot
    : {};
  const initial = contract.quote_id
    ? await query(
      `SELECT request_total_minor
         FROM mbt_frontdesk_charge_requests
        WHERE source_quote_id = $1::uuid
          AND request_kind = 'initial_bin'
          AND status = 'confirmed'
        ORDER BY charge_request_id`,
      [contract.quote_id]
    )
    : { rowCount: 0, rows: [] };
  if (initial.rowCount > 1) {
    throw failure(422, "MBT_FRONTDESK_CONFIGURATION_INVALID", "The contract has duplicate initial customer-charge evidence.");
  }
  const base = nonnegativeInteger(Number(
    initial.rows[0]?.request_total_minor
      ?? pricing.customerTotalMinor
      ?? pricing.totalMinor
      ?? 0
  ), "Accepted contract total");
  const additions = await query(
    `SELECT COALESCE(sum(request_total_minor), 0) AS total_minor
       FROM mbt_frontdesk_charge_requests
      WHERE contract_id = $1::uuid
        AND status = 'confirmed'
        AND request_kind <> 'initial_bin'`,
    [contract.contract_id]
  );
  return safeAdd(base, Number(additions.rows[0].total_minor), "Current contract total");
}

/** @param {string} customerNetsuiteId */
async function customerSubject(customerNetsuiteId) {
  if (!/^\d+$/u.test(customerNetsuiteId)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "Customer NetSuite ID is invalid.");
  }
  const selected = await query(
    `SELECT netsuite_id::text, display_name, phone
       FROM netsuite_customers
      WHERE netsuite_id = $1::bigint AND active`,
    [customerNetsuiteId]
  );
  if (!selected.rowCount) {
    throw failure(409, "MBT_FRONTDESK_CUSTOMER_NOT_READY", "The selected customer is not active for local service.");
  }
  return selected.rows[0];
}

/** @param {Record<string, any>} input */
function normalizedBinRequest(input) {
  const bin = input.bin && typeof input.bin === "object" && !Array.isArray(input.bin)
    ? /** @type {Record<string, any>} */ (input.bin)
    : {};
  const deliveryAt = timestamp(bin.proposedDeliveryAt, "Proposed delivery time");
  const returnAt = timestamp(bin.proposedReturnAt, "Proposed return time");
  if (new Date(returnAt) <= new Date(deliveryAt)) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "The return time must follow delivery.");
  }
  return {
    bin,
    incomingBinTypeId: requiredUuid(bin.incomingBinTypeId, "Incoming bin type ID"),
    binItemCode: itemCode(bin.binItemCode, "Incoming bin item"),
    deliveryItemCode: itemCode(bin.deliveryItemCode, "Delivery item"),
    incomingContentCode: requiredText(bin.incomingContentCode, "Incoming bin content").toLowerCase(),
    incomingBinSizeYards: nonnegativeInteger(Number(bin.incomingBinSizeYards), "Incoming bin size"),
    deliveryAt,
    returnAt,
    originYardCode: input.orderFrom150 === true ? "150" : "3445"
  };
}

/** @param {string} incomingContentCode @param {string} rateCardVersionId */
async function selectFixedDumpRate(incomingContentCode, rateCardVersionId) {
  if (incomingContentCode === "garbage") {
    return { rowCount: 0, rows: [] };
  }
  return query(
    `SELECT catalog.item_code, rate.amount_minor
       FROM mbt_frontdesk_charge_catalog catalog
       JOIN mbt_frontdesk_charge_rates rate
         ON rate.item_code = catalog.item_code
        AND rate.rate_card_version_id = $2::uuid
        AND rate.active
      WHERE catalog.item_kind = 'fixed_dump'
        AND catalog.content_code = $1
        AND catalog.active`,
    [incomingContentCode, rateCardVersionId]
  );
}

/** @param {Record<string, any>} selected @param {number} incomingBinSizeYards @param {string} incomingContentCode */
function assertBinRateSelections(selected, incomingBinSizeYards, incomingContentCode) {
  if (selected.binIdentity.rowCount !== 1
      || Number(selected.binIdentity.rows[0].nominal_yards) !== incomingBinSizeYards) {
    throw failure(409, "MBT_FRONTDESK_BIN_TYPE_NOT_ACTIVE", "The incoming bin item and size do not match active MBT configuration.");
  }
  if (selected.rental.rowCount !== 1) {
    throw failure(422, "MBT_FRONTDESK_RENTAL_RATE_MISSING", "The incoming bin needs one active rental rate.");
  }
  if (selected.delivery.rowCount !== 1) {
    throw failure(422, "MBT_FRONTDESK_RATE_BAND_MISSING", "The incoming bin needs one matching delivery distance rate.");
  }
  if (incomingContentCode !== "garbage" && selected.fixedDump.rowCount !== 1) {
    throw failure(422, "MBT_FRONTDESK_DUMP_RATE_MISSING", "The incoming non-garbage bin needs one fixed dump rate.");
  }
}

/** @param {string} kind @param {Record<string, any>} bin */
function outgoingBinEvidence(kind, bin) {
  if (kind !== "exchange_bin") {
    return { outgoingContentCode: null, outgoingBinSizeYards: null };
  }
  return {
    outgoingContentCode: requiredText(bin.outgoingContentCode, "Outgoing bin content").toLowerCase(),
    outgoingBinSizeYards: nonnegativeInteger(Number(bin.outgoingBinSizeYards), "Outgoing bin size")
  };
}

/** @param {string} incomingContentCode @param {Record<string, any> | null} depositRow */
function depositRateEvidence(incomingContentCode, depositRow) {
  if (incomingContentCode !== "garbage") {
    return { depositMinor: 0, depositRuleId: null, percentageDepositBasisPoints: null };
  }
  if (!depositRow) {
    throw failure(422, "MBT_FRONTDESK_DEPOSIT_RATE_MISSING", "The incoming garbage bin needs one active deposit rule.");
  }
  if (String(depositRow.currency) !== "CAD") {
    throw failure(422, "MBT_FRONTDESK_CURRENCY_MISMATCH", "The garbage deposit rule must use CAD.");
  }
  const isPercentage = depositRow?.rule_type === "percentage";
  const depositMinor = !isPercentage
    ? nonnegativeInteger(Number(depositRow?.fixed_amount_minor ?? 0), "Deposit amount")
    : 0;
  return {
    depositMinor,
    depositRuleId: depositRow?.deposit_rule_id ? String(depositRow.deposit_rule_id) : null,
    percentageDepositBasisPoints: isPercentage
      ? nonnegativeInteger(Number(depositRow?.percentage_basis_points), "Deposit basis points")
      : null
  };
}

/** @param {string} incomingContentCode @param {Record<string, any>} fixedDump */
function fixedDumpRateEvidence(incomingContentCode, fixedDump) {
  if (incomingContentCode === "garbage") {
    return { fixedDumpMinor: 0, fixedDumpItemCode: null };
  }
  return {
    fixedDumpMinor: nonnegativeInteger(Number(fixedDump.rows[0].amount_minor), "Fixed dump amount"),
    fixedDumpItemCode: String(fixedDump.rows[0].item_code)
  };
}

/** @param {Record<string, any>} input @param {string} rateCardVersionId @param {number} distanceMetres */
async function binRateEvidence(input, rateCardVersionId, distanceMetres) {
  const evidence = normalizedBinRequest(input);
  const {
    bin, incomingBinTypeId, binItemCode, deliveryItemCode,
    incomingContentCode, incomingBinSizeYards, deliveryAt, returnAt, originYardCode
  } = evidence;
  const binIdentity = await query(
      `SELECT type.bin_type_id::text, type.nominal_yards::int, item.item_code
         FROM mbt_bin_types type
         JOIN mbt_local_item_settings item
           ON item.bin_type_id = type.bin_type_id
          AND item.item_code = $2
          AND item.item_type = 'bin'
          AND item.active
        WHERE type.bin_type_id = $1::uuid AND type.active`,
      [incomingBinTypeId, binItemCode]
    );
  const rental = await query(
      `SELECT amount_minor, taxable, rate_component_id::text
         FROM mbt_rate_components
        WHERE rate_card_version_id = $1::uuid
          AND component_kind = 'rental'
          AND rate_basis = 'flat'
          AND active
          AND (item_code IS NULL OR item_code = $2)
          AND (bin_type_id IS NULL OR bin_type_id = $3::uuid)
          AND (service_code IS NULL OR service_code = 'delivery')
        ORDER BY (item_code IS NOT NULL) DESC, (bin_type_id IS NOT NULL) DESC,
                 rate_component_id
        LIMIT 2`,
      [rateCardVersionId, binItemCode, incomingBinTypeId]
    );
  const delivery = await query(
      `SELECT amount_minor, pricing_basis, rate_distance_band_id::text,
              minimum_metres::int, maximum_metres::int
         FROM mbt_rate_distance_bands
        WHERE rate_card_version_id = $1::uuid
          AND service_code = 'delivery'
          AND (item_code IS NULL OR item_code = $2)
          AND (bin_type_id IS NULL OR bin_type_id = $3::uuid)
          AND (cardinality(origin_yard_codes) = 0 OR $5 = ANY(origin_yard_codes))
          AND (
            (
              boundary_rule = 'upper_inclusive'
              AND (CASE WHEN minimum_metres = 0 THEN $4 >= minimum_metres ELSE $4 > minimum_metres END)
              AND (maximum_metres IS NULL OR $4 <= maximum_metres)
            )
            OR (
              boundary_rule = 'lower_inclusive'
              AND minimum_metres <= $4
              AND (maximum_metres IS NULL OR maximum_metres > $4)
            )
          )
        ORDER BY (item_code IS NOT NULL) DESC, (bin_type_id IS NOT NULL) DESC,
                 minimum_metres DESC, sequence_number, rate_distance_band_id
        LIMIT 2`,
      [rateCardVersionId, deliveryItemCode, incomingBinTypeId, distanceMetres, originYardCode]
    );
  const deposit = await query(
      `SELECT rule_type, fixed_amount_minor, percentage_basis_points,
              currency, deposit_rule_id::text
         FROM mbt_deposit_rules
        WHERE rate_card_version_id = $1::uuid AND active
          AND (bin_type_id IS NULL OR bin_type_id = $2::uuid)
          AND (service_code IS NULL OR service_code = 'delivery')
        ORDER BY (bin_type_id IS NOT NULL) DESC, (service_code IS NOT NULL) DESC,
                 rule_code, deposit_rule_id
        LIMIT 1`,
      [rateCardVersionId, incomingBinTypeId]
    );
  const fixedDump = await selectFixedDumpRate(incomingContentCode, rateCardVersionId);
  assertBinRateSelections({ binIdentity, rental, delivery, fixedDump }, incomingBinSizeYards, incomingContentCode);
  const deliveryAmountMinor = calculateDistanceBandChargeMinor({
    amountMinor: nonnegativeInteger(Number(delivery.rows[0].amount_minor), "Delivery unit amount"),
    pricingBasis: String(delivery.rows[0].pricing_basis)
  }, distanceMetres);
  const { outgoingContentCode, outgoingBinSizeYards } = outgoingBinEvidence(input.kind, bin);
  const depositRow = deposit.rows[0] || null;
  const depositEvidence = depositRateEvidence(incomingContentCode, depositRow);
  const dumpEvidence = fixedDumpRateEvidence(incomingContentCode, fixedDump);
  return {
    calculator: {
      incomingContentCode,
      incomingBinSizeYards,
      outgoingContentCode,
      outgoingBinSizeYards,
      rentalMinor: nonnegativeInteger(Number(rental.rows[0].amount_minor), "Rental amount"),
      transportMinor: deliveryAmountMinor,
      fixedDumpMinor: dumpEvidence.fixedDumpMinor,
      depositMinor: depositEvidence.depositMinor,
      discountMinor: nonnegativeInteger(Number(bin.discountMinor ?? 0), "Bin discount"),
      discountReason: bin.discountReason ?? null
    },
    schedule: { proposedDeliveryAt: deliveryAt, proposedReturnAt: returnAt },
    itemEvidence: {
      incomingBinTypeId,
      binItemCode,
      deliveryItemCode,
      rentalRateComponentId: String(rental.rows[0].rate_component_id),
      deliveryRateDistanceBandId: String(delivery.rows[0].rate_distance_band_id),
      fixedDumpItemCode: dumpEvidence.fixedDumpItemCode,
      depositRuleId: depositEvidence.depositRuleId,
      percentageDepositBasisPoints: depositEvidence.percentageDepositBasisPoints
    }
  };
}

/** @param {Record<string, any>} calculation @param {Record<string, any> | null} binRate */
function withPercentageDeposit(calculation, binRate) {
  const basisPoints = binRate?.itemEvidence?.percentageDepositBasisPoints;
  if (!basisPoints || !binRate || binRate.calculator.incomingContentCode !== "garbage") {
    return calculation;
  }
  const lines = /** @type {Array<Record<string, any>>} */ (calculation.lines);
  const binCustomerTotal = lines
    .filter((line) => !String(line.lineType).startsWith("aggregate_"))
    .reduce((sum, line) => safeAdd(sum, Number(line.customerAmountMinor), "Deposit basis"), 0);
  return percentageAmount(binCustomerTotal, basisPoints);
}

/** @param {Record<string, any>} input @param {string} rateCardVersionId @param {number} currentTotal */
async function calculatePersistableRequest(input, rateCardVersionId, currentTotal) {
  const aggregateLines = await aggregateRateLines(input, rateCardVersionId);
  const distanceMetres = nonnegativeInteger(Number(input.distanceMetres), "Server-owned distance");
  const binRate = input.kind === "aggregate_order"
    ? null
    : await binRateEvidence(input, rateCardVersionId, distanceMetres);
  const calculationInput = {
    kind: input.kind,
    paymentMethod: input.paymentMethod,
    currentContractTotalMinor: currentTotal,
    orderFrom150: input.orderFrom150 === true,
    currency: "CAD",
    taxRateBasisPoints: 1_300,
    bin: binRate?.calculator,
    aggregateLines,
    aggregateDistanceBands: input.kind === "aggregate_order"
      ? await aggregateDistanceBands(rateCardVersionId)
      : undefined,
    distanceMetres,
    loadingFeeMinor: await loadingFeeMinor(rateCardVersionId)
  };
  let calculation = calculateCustomerCharge(calculationInput);
  const percentageDeposit = withPercentageDeposit(calculation, binRate);
  if (typeof percentageDeposit === "number" && binRate) {
    calculation = calculateCustomerCharge({
      ...calculationInput,
      bin: { ...binRate.calculator, depositMinor: percentageDeposit }
    });
  }
  return { calculation, binRate, aggregateLines, distanceMetres };
}

/** @param {string} requestId */
function requestNumber(requestId) {
  return `MBT-R-${requestId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

/** @param {Record<string, any>} input @param {Record<string, any>} calculation @param {Record<string, any>} context */
async function insertChargeRequest(input, calculation, context) {
  const chargeRequestId = context.chargeRequestId
    ? requiredUuid(context.chargeRequestId, "Charge request ID")
    : crypto.randomUUID();
  const number = requestNumber(chargeRequestId);
  const actorId = String(context.actorId);
  const pricingSnapshot = {
    schemaVersion: "mbt-frontdesk-charge-request-pricing-v1",
    calculation,
    subject: {
      customerNetsuiteId: context.customerNetsuiteId,
      contractId: context.contractId,
      serviceLineId: context.serviceLineId,
      sourceQuoteId: context.sourceQuoteId || null,
      rateCardVersionId: context.rateCardVersionId
    },
    bin: context.binRate,
    aggregateLines: context.aggregateLines,
    distanceMetres: context.distanceMetres
  };
  const inserted = await query(
    `INSERT INTO mbt_frontdesk_charge_requests (
       charge_request_id, request_number, request_kind, status,
       contract_id, service_line_id, source_quote_id, rate_card_version_id,
       expected_contract_revision, expected_service_line_revision,
       payment_method, payment_category, tax_mode, tax_rate_basis_points,
       netsuite_export_policy, pricing_snapshot, netsuite_ready_snapshot,
       current_contract_total_minor, pre_tax_revenue_minor,
       included_hst_minor, added_hst_minor, request_total_minor,
       resulting_contract_total_minor, required_deposit_minor, due_now_minor,
       currency, billing_address_text, service_address_text,
       contract_telephone, order_from_150, reason, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, 'draft', $4::uuid, $5::uuid, $6::uuid, $7::uuid,
       $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb,
       $17, $18, $19, $20, $21, $22, $23, $24, $25,
       $26, $27, $28, $29, $30, $31, $31
     ) RETURNING *`,
    [
      chargeRequestId, number, input.kind, context.contractId, context.serviceLineId,
      context.sourceQuoteId || null, context.rateCardVersionId, context.expectedContractRevision,
      context.expectedServiceLineRevision, calculation.paymentMethod,
      calculation.paymentCategory, calculation.taxMode, calculation.taxRateBasisPoints,
      calculation.netsuiteExportPolicy, JSON.stringify(pricingSnapshot),
      calculation.netsuiteReadySnapshot ? JSON.stringify(calculation.netsuiteReadySnapshot) : null,
      calculation.currentContractTotalMinor, calculation.preTaxRevenueMinor,
      calculation.includedHstMinor, calculation.addedHstMinor,
      calculation.newRequestChargeableMinor, calculation.resultingContractTotalMinor,
      calculation.requiredDepositMinor, calculation.dueNowMinor, calculation.currency,
      input.billingAddressText, input.serviceAddressText, input.contractTelephone,
      calculation.orderFrom150, input.reason, actorId
    ]
  );
  for (const [index, line] of calculation.lines.entries()) {
    await query(
      `INSERT INTO mbt_frontdesk_charge_request_lines (
         charge_request_line_id, charge_request_id, sequence_number,
         line_code, line_type, description, item_code,
         quantity_milli_units, unit_of_measure, unit_amount_minor,
         configured_amount_minor, pre_tax_amount_minor,
         included_hst_minor, added_hst_minor, customer_amount_minor,
         taxable, payment_timing, pricing_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18::jsonb
       )`,
      [
        crypto.randomUUID(), chargeRequestId, index + 1,
        line.lineCode, line.lineType, line.label, line.itemCode,
        line.quantityMilliUnits, line.unitOfMeasure, line.unitAmountMinor,
        line.configuredAmountMinor, line.preTaxAmountMinor,
        line.includedHstMinor, line.addedHstMinor, line.customerAmountMinor,
        line.taxable, line.paymentTiming, JSON.stringify({ source: line.source,
          ...(line.derivedWeightLbs === undefined ? {} : { derivedWeightLbs: line.derivedWeightLbs }) })
      ]
    );
  }
  return inserted.rows[0];
}

/**
 * Price an initial-bin request inside the existing quote command. The caller
 * later persists the prepared result after its source quote exists, keeping
 * both records in one database transaction without nesting command receipts.
 *
 * @param {Record<string, unknown>} input
 */
export async function prepareFrontdeskInitialCharge(input) {
  const actor = assertFrontdeskActor(/** @type {any} */ (input.actor));
  const rateCardVersionId = requiredUuid(input.rateCardVersionId, "Rate card version ID");
  const customerNetsuiteId = requiredText(input.customerNetsuiteId, "Customer NetSuite ID");
  const normalizedInput = {
    kind: "initial_bin",
    rateCardVersionId,
    contractId: null,
    serviceLineId: null,
    expectedContractRevision: null,
    expectedServiceLineRevision: null,
    paymentMethod: input.paymentMethod,
    billingAddressText: snapshotText(input.billingAddressText, "Billing address", 1_000),
    serviceAddressText: snapshotText(input.serviceAddressText, "Service address", 1_000),
    contractTelephone: snapshotText(input.contractTelephone, "Contract telephone", 100),
    orderFrom150: input.orderFrom150 === true,
    distanceMetres: input.distanceMetres,
    bin: input.bin || null,
    aggregateLines: input.aggregateLines || [],
    reason: snapshotText(input.reason, "Audit reason", 2_000)
  };
  await assertActiveRateVersion(rateCardVersionId);
  await customerSubject(customerNetsuiteId);
  const priced = await calculatePersistableRequest(normalizedInput, rateCardVersionId, 0);
  return {
    chargeRequestId: crypto.randomUUID(),
    actorId: actor.operatorId,
    customerNetsuiteId,
    rateCardVersionId,
    normalizedInput,
    ...priced
  };
}

/** @param {Record<string, any>} prepared @param {string} sourceQuoteId */
export async function persistPreparedFrontdeskInitialCharge(prepared, sourceQuoteId) {
  const row = await insertChargeRequest(prepared.normalizedInput, prepared.calculation, {
    chargeRequestId: prepared.chargeRequestId,
    actorId: prepared.actorId,
    customerNetsuiteId: prepared.customerNetsuiteId,
    contractId: null,
    serviceLineId: null,
    sourceQuoteId: requiredUuid(sourceQuoteId, "Source quote ID"),
    rateCardVersionId: prepared.rateCardVersionId,
    expectedContractRevision: null,
    expectedServiceLineRevision: null,
    binRate: prepared.binRate,
    aggregateLines: prepared.aggregateLines,
    distanceMetres: prepared.distanceMetres
  });
  return chargeRequestDto(row);
}

/**
 * Persist a server-owned draft whose prices can be shown to the customer.
 * The draft is replaced, not edited, whenever payment/rates/request inputs
 * change; confirmation freezes it permanently.
 *
 * @param {Record<string, unknown>} input
 */
export async function previewFrontdeskChargeRequest(input) {
  const actor = assertFrontdeskActor(/** @type {any} */ (input.actor));
  const kind = requestKind(input.kind);
  const rateCardVersionId = requiredUuid(input.rateCardVersionId, "Rate card version ID");
  const contractId = optionalUuid(input.contractId, "Contract ID");
  const serviceLineId = optionalUuid(input.serviceLineId, "Service line ID");
  const expectedContractRevision = contractId
    ? positiveRevision(input.expectedContractRevision, "Expected contract revision")
    : null;
  const expectedServiceLineRevision = serviceLineId
    ? positiveRevision(input.expectedServiceLineRevision, "Expected service-line revision")
    : null;
  if (["add_bin", "exchange_bin"].includes(kind) && !contractId) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", `${kind} requires an active contract.`);
  }
  if (kind === "exchange_bin" && !serviceLineId) {
    throw failure(400, "MBT_FRONTDESK_INPUT_INVALID", "An exchange requires the outgoing service line.");
  }
  const billingAddressText = snapshotText(input.billingAddressText, "Billing address", 1_000);
  const serviceAddressText = snapshotText(input.serviceAddressText, "Service address", 1_000);
  const contractTelephone = snapshotText(input.contractTelephone, "Contract telephone", 100);
  const reason = snapshotText(input.reason, "Audit reason", 2_000);
  const payload = {
    kind, rateCardVersionId, contractId, serviceLineId,
    expectedContractRevision, expectedServiceLineRevision,
    paymentMethod: input.paymentMethod,
    billingAddressText, serviceAddressText, contractTelephone,
    orderFrom150: input.orderFrom150 === true,
    distanceMetres: input.distanceMetres,
    bin: input.bin || null,
    aggregateLines: input.aggregateLines || [],
    reason
  };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.charge_request.preview",
    idempotencyKey: requiredText(input.idempotencyKey, "Idempotency key"),
    payload,
    correlationId: requiredText(input.correlationId, "Correlation ID"),
    requestId: requiredText(input.requestId, "Request ID"),
    mutation: async () => {
      await assertActiveRateVersion(rateCardVersionId);
      let contract = null;
      let customerNetsuiteId;
      let currentTotal = 0;
      if (contractId && expectedContractRevision) {
        contract = await contractPricingSubject(contractId, expectedContractRevision);
        if (String(contract.rate_card_version_id) !== rateCardVersionId) {
          throw failure(409, "MBT_FRONTDESK_RATE_CARD_MISMATCH", "The request must use its contract's locked MBT rate version.");
        }
        customerNetsuiteId = String(contract.customer_netsuite_id);
        currentTotal = await currentContractTotalMinor(contract);
        if (serviceLineId) {
          const line = await query(
            `SELECT revision::int FROM mbt_contract_service_lines
              WHERE contract_id = $1::uuid AND service_line_id = $2::uuid`,
            [contractId, serviceLineId]
          );
          if (!line.rowCount || Number(line.rows[0].revision) !== expectedServiceLineRevision) {
            throw failure(409, "MBT_STALE_REVISION", "The service line changed. Refresh and recalculate the request.");
          }
        }
      } else {
        customerNetsuiteId = requiredText(input.customerNetsuiteId, "Customer NetSuite ID");
      }
      await customerSubject(customerNetsuiteId);
      const normalizedInput = {
        ...payload,
        kind,
        billingAddressText,
        serviceAddressText,
        contractTelephone,
        reason
      };
      const priced = await calculatePersistableRequest(normalizedInput, rateCardVersionId, currentTotal);
      const row = await insertChargeRequest(normalizedInput, priced.calculation, {
        actorId: actor.operatorId,
        customerNetsuiteId,
        contractId,
        serviceLineId,
        rateCardVersionId,
        expectedContractRevision,
        expectedServiceLineRevision,
        ...priced
      });
      const request = chargeRequestDto(row);
      return {
        status: 201,
        body: { schemaVersion: "mbt-frontdesk-charge-request-preview-v1", request },
        audit: {
          action: "mbt.frontdesk.charge_request.previewed",
          entityType: "mbt_frontdesk_charge_request",
          entityId: String(row.charge_request_id),
          beforeState: { exists: false },
          afterState: request,
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/** @param {Record<string, any>} row */
function aggregateDispatchEvidence(row) {
  const pricing = row.pricing_snapshot || {};
  const calculation = pricing.calculation || {};
  const calculationLines = /** @type {Array<Record<string, any>>} */ (
    Array.isArray(calculation.lines) ? calculation.lines : []
  );
  const materialLines = Array.isArray(calculation.lines)
    ? calculationLines.filter((line) => line.lineType === "aggregate_material")
    : [];
  const weightLbs = materialLines.reduce(
    (sum, line) => safeAdd(sum, Number(line.derivedWeightLbs || 0), "Aggregate Dispatch weight"),
    0
  );
  if (weightLbs < 1) {
    throw failure(422, "MBT_FRONTDESK_AGGREGATE_WEIGHT_MISSING", "Aggregate Dispatch work requires configured density evidence.");
  }
  const detailLines = materialLines.map((line) => (
    `${line.label} · ${(Number(line.quantityMilliUnits) / 1_000).toFixed(3)} YARD`
  ));
  return { calculation, materialLines, weightLbs, detailLines };
}

/** @param {Record<string, any>} row */
function attachedAggregateEvidence(row) {
  const calculation = row.pricing_snapshot?.calculation || {};
  const lines = /** @type {Array<Record<string, any>>} */ (
    Array.isArray(calculation.lines) ? calculation.lines : []
  );
  const materials = lines.filter((line) => line.lineType === "aggregate_material");
  if (!materials.length) {
    return null;
  }
  const loading = lines.find((line) => line.lineType === "aggregate_loading_fee");
  return {
    schemaVersion: "mbt-attached-aggregate-v1",
    chargeRequestId: String(row.charge_request_id),
    materials: materials.map((line) => ({
      itemCode: String(line.itemCode),
      displayName: String(line.label),
      quantityMilliYards: Number(line.quantityMilliUnits),
      unitOfMeasure: "YARD",
      derivedWeightLbs: Number(line.derivedWeightLbs)
    })),
    totalWeightLbs: materials.reduce(
      (sum, line) => safeAdd(sum, Number(line.derivedWeightLbs), "Attached aggregate weight"),
      0
    ),
    loadingFeeMinor: loading ? Number(loading.configuredAmountMinor) : 0
  };
}

/** @param {Record<string, any>} row @param {string} actorId */
async function createAggregateDispatchOrder(row, actorId) {
  const evidence = aggregateDispatchEvidence(row);
  const dispatchOrder = await createDispatchCustomOrder({
    refNumber: `MBT-AGG-${String(row.request_number).replace(/^MBT-R-/u, "")}`,
    pickupLocation: "Yard 150",
    dropoffLocation: String(row.service_address_text),
    orderDetails: [
      `Aggregate Order ${row.request_number}`,
      ...evidence.detailLines,
      `Customer total: ${evidence.calculation.currency} ${(Number(row.request_total_minor) / 100).toFixed(2)}`
    ].join("\n"),
    weightLbs: evidence.weightLbs,
    stopMinutes: 30
  }, actorId);
  if (!dispatchOrder) {
    throw failure(500, "MBT_FRONTDESK_DISPATCH_CREATE_FAILED", "The Aggregate Order could not be created in Dispatch.");
  }
  await query(
    `UPDATE dispatch_custom_orders
        SET mbt_customer_netsuite_id = $2::bigint,
            mbt_source = 'frontdesk_aggregate',
            mbt_charge_request_id = $3::uuid,
            updated_by = $4,
            updated_at = now()
      WHERE id = $1`,
    [dispatchOrder.id, row.pricing_snapshot.subject.customerNetsuiteId,
      row.charge_request_id, actorId]
  );
  return { ...dispatchOrder, source: "frontdesk_aggregate", chargeRequestId: String(row.charge_request_id) };
}

/** @param {Record<string, any>} row @param {number} expectedRevision */
function assertConfirmableChargeRequest(row, expectedRevision) {
  if (String(row.status) !== "draft" || Number(row.revision) !== expectedRevision) {
    throw failure(409, "MBT_STALE_REVISION", "The priced request changed or is no longer a draft.");
  }
}

/** @param {Record<string, any>} row */
async function assertChargeRequestContractCurrent(row) {
  if (!row.contract_id) {
    return;
  }
  const contract = await query(
    `SELECT revision::int, status FROM mbt_contracts
      WHERE contract_id = $1::uuid FOR SHARE`,
    [row.contract_id]
  );
  if (!contract.rowCount
      || Number(contract.rows[0].revision) !== Number(row.expected_contract_revision)
      || !ACTIVE_CONTRACT_STATUSES.has(String(contract.rows[0].status))) {
    throw failure(409, "MBT_FRONTDESK_PRICE_STALE", "The contract changed after this request was priced.");
  }
}

/** @param {Record<string, any>} pricing */
function exchangeWindow(pricing) {
  const schedule = pricing.bin?.schedule || {};
  const startAt = new Date(requiredText(schedule.proposedDeliveryAt, "Exchange time"));
  if (!Number.isFinite(startAt.getTime())) {
    throw failure(422, "MBT_FRONTDESK_PRICE_STALE", "The priced exchange has no valid service time.");
  }
  return {
    startAt: startAt.toISOString(),
    endAt: new Date(startAt.getTime() + (4 * 60 * 60 * 1_000)).toISOString()
  };
}

/**
 * @param {{row: Record<string, any>, actor: {operatorId: string, roles: string[]}, chargeRequestId: string,
 * reason: string, correlationId: string, requestId: string, attachedAggregate: Record<string, any> | null}} context
 */
async function materializeChargeRequestOperation(context) {
  const { row, actor, chargeRequestId, reason, correlationId, requestId, attachedAggregate } = context;
  const pricing = row.pricing_snapshot || {};
  const calculation = pricing.calculation || {};
  if (String(row.request_kind) === "add_bin") {
    const { materializeFrontdeskPricedAddBin } = await import("./frontdesk-service.js");
    return materializeFrontdeskPricedAddBin({
      chargeRequestId,
      contractId: String(row.contract_id),
      expectedContractRevision: Number(row.expected_contract_revision),
      calculation,
      binRate: pricing.bin,
      attachedAggregate,
      actorId: actor.operatorId
    });
  }
  if (String(row.request_kind) === "exchange_bin") {
    const { exchangeFrontdeskServiceLine } = await import("./frontdesk-service.js");
    const exchanged = await exchangeFrontdeskServiceLine({
      actor,
      contractId: String(row.contract_id),
      serviceLineId: String(row.service_line_id),
      expectedRevision: Number(row.expected_service_line_revision),
      exchangeWindow: exchangeWindow(pricing),
      incomingBinTypeId: pricing.bin?.itemEvidence?.incomingBinTypeId,
      incomingContentCode: pricing.bin?.calculator?.incomingContentCode,
      sourceChargeRequestId: chargeRequestId,
      attachedAggregate,
      chargeMode: "charged",
      reason,
      idempotencyKey: `mbt-charge-operation-${chargeRequestId}`,
      correlationId,
      requestId: `${requestId}:operation`
    });
    return exchanged.body;
  }
  return null;
}

/** @param {Record<string, any>} row @param {string} actorId */
async function materializeAggregateDispatchOrder(row, actorId) {
  if (String(row.request_kind) !== "aggregate_order") {
    return null;
  }
  return createAggregateDispatchOrder(row, actorId);
}

/**
 * Confirm one exact draft. Aggregate-only requests materialize one Dispatch
 * order; no request creates a NetSuite outbox row in this release.
 *
 * @param {Record<string, unknown>} input
 */
export async function confirmFrontdeskChargeRequest(input) {
  const actor = assertFrontdeskActor(/** @type {any} */ (input.actor));
  const chargeRequestId = requiredUuid(input.chargeRequestId, "Charge request ID");
  const expectedRevision = positiveRevision(input.expectedRevision);
  const reason = snapshotText(input.reason, "Audit reason", 2_000);
  const confirmationIdempotencyKey = requiredText(input.idempotencyKey, "Idempotency key");
  const commandCorrelationId = requiredText(input.correlationId, "Correlation ID");
  const commandRequestId = requiredText(input.requestId, "Request ID");
  const payload = { chargeRequestId, expectedRevision, reason };
  return executeMbtCommand({
    actor,
    commandName: "mbt.frontdesk.charge_request.confirm",
    idempotencyKey: confirmationIdempotencyKey,
    payload,
    correlationId: commandCorrelationId,
    requestId: commandRequestId,
    mutation: async () => {
      const selected = await query(
        `SELECT * FROM mbt_frontdesk_charge_requests
          WHERE charge_request_id = $1::uuid FOR UPDATE`,
        [chargeRequestId]
      );
      if (!selected.rowCount) {
        throw failure(404, "MBT_FRONTDESK_CHARGE_REQUEST_NOT_FOUND", "The customer charge request was not found.");
      }
      const row = selected.rows[0];
      assertConfirmableChargeRequest(row, expectedRevision);
      await assertChargeRequestContractCurrent(row);
      const before = chargeRequestDto(row);
      const attachedAggregate = attachedAggregateEvidence(row);
      const operation = await materializeChargeRequestOperation({
        row, actor, chargeRequestId, reason,
        correlationId: commandCorrelationId,
        requestId: commandRequestId,
        attachedAggregate
      });
      const dispatchOrder = await materializeAggregateDispatchOrder(row, actor.operatorId);
      const updated = await query(
        `UPDATE mbt_frontdesk_charge_requests
            SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2,
                revision = revision + 1, updated_by = $2, updated_at = now()
          WHERE charge_request_id = $1::uuid RETURNING *`,
        [chargeRequestId, actor.operatorId]
      );
      const request = {
        ...chargeRequestDto(updated.rows[0]),
        confirmationIdempotencyKey
      };
      const body = {
        schemaVersion: "mbt-frontdesk-charge-request-confirmation-v1",
        request,
        ...(operation ? { operation } : {}),
        ...(dispatchOrder ? { dispatchOrder } : {})
      };
      return {
        status: dispatchOrder || operation ? 201 : 200,
        body,
        audit: {
          action: "mbt.frontdesk.charge_request.confirmed",
          entityType: "mbt_frontdesk_charge_request",
          entityId: chargeRequestId,
          beforeState: before,
          afterState: body,
          reason,
          revisionBefore: expectedRevision,
          revisionAfter: expectedRevision + 1,
          source: "frontdesk_local"
        }
      };
    }
  });
}

/** @param {Record<string, unknown>} input */
export async function listFrontdeskContractChargeRequests(input) {
  assertFrontdeskActor(/** @type {any} */ (input.actor));
  const contractId = requiredUuid(input.contractId, "Contract ID");
  const result = await query(
    `SELECT * FROM mbt_frontdesk_charge_requests
      WHERE contract_id = $1::uuid
      ORDER BY created_at, charge_request_id`,
    [contractId]
  );
  return {
    schemaVersion: "mbt-frontdesk-contract-charge-requests-v1",
    contractId,
    items: result.rows.map(chargeRequestDto)
  };
}

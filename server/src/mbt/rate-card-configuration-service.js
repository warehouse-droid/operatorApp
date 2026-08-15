// @ts-check

import crypto from "node:crypto";

import { query } from "../db.js";
import { executeMbtCommand } from "./command-repository.js";
import { MbtError } from "./errors.js";
import { authorizeMbtPhase3Capability } from "./phase3-authorization.js";
import { validateRateBands } from "./rate-bands.js";
import {
  DISTANCE_BOUNDARY_RULES,
  DISTANCE_PRICING_BASES
} from "./distance-band-pricing.js";
import {
  isMbbsCrossChargeGraph,
  normalizeMbbsRateCardPolicy
} from "./mbbs-rate-card-policy.js";

/** @typedef {import("./audit-repository.js").MbtActor} MbtActor */

const VERSION_STATUSES = new Set(["draft", "active", "retired"]);
const COMPONENT_KINDS = new Set([
  "base_transport", "rental", "extension", "exchange", "pickup",
  "downtown_surcharge", "service", "other"
]);
const COMPONENT_BASES = new Set(["flat", "per_day", "per_week", "per_unit", "percentage"]);
const TARIFF_BASES = new Set(["fixed", "per_weight", "per_quantity"]);
const DEPOSIT_TYPES = new Set(["fixed", "percentage", "bin_type", "service", "customer_override"]);
const INTERNAL_SERVICE_TEMPLATE_CODE = "MBT_INTERNAL_BIN_SERVICE";

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new MbtError({ status: 400, code, message });
}

/** @param {string} message @returns {never} */
function invalidInput(message = "The local rate-card graph contains an invalid field.") {
  return fail("MBT_RATE_CARD_INPUT_INVALID", message);
}

/** @param {unknown} value @param {string} label */
function inputRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput(`${label} must be an object.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, any>} value @param {readonly string[]} allowed */
function allowedFields(value, allowed) {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    return invalidInput();
  }
}

/** @param {unknown} value @param {string} label @param {number} [maximum] */
function requiredText(value, label, maximum = 2000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    return invalidInput(`${label} is required and must be at most ${maximum} characters.`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label @param {number} [maximum] */
function optionalText(value, label, maximum = 2000) {
  if (typeof value !== "string" || value.length > maximum) {
    return invalidInput(`${label} must be text no longer than ${maximum} characters.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} label @param {number} [minimum] */
function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    return invalidInput(`${label} must be a safe integer of at least ${minimum}.`);
  }
  return Number(value);
}

/** @param {unknown} value @param {string} label */
function nullableSafeInteger(value, label) {
  return value === null ? null : safeInteger(value, label);
}

/** @param {unknown} value @param {string} label */
function booleanValue(value, label) {
  if (value !== true && value !== false) {
    return invalidInput(`${label} must be true or false.`);
  }
  return value;
}

/** @param {unknown} value */
function cadCurrency(value) {
  if (value !== "CAD") {
    return fail("MBT_RATE_CARD_CURRENCY_INVALID", "Local rate cards must use CAD.");
  }
  return "CAD";
}

/** @param {unknown} value @param {string} label @param {boolean} [nullable] */
function isoDate(value, label, nullable = false) {
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    return invalidInput(`${label} must be an ISO date-time.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function nullableCode(value, label) {
  if (value === null) {
    return null;
  }
  const code = requiredText(value, label, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(code)) {
    return invalidInput(`${label} is invalid.`);
  }
  return code;
}

/** @param {Record<string, any>} card */
function validateCard(card) {
  allowedFields(card, [
    "rateCardCode", "displayName", "description", "itemCode", "customerNetSuiteId",
    "subsidiaryNetSuiteId", "serviceTemplateCode", "currency", "active"
  ]);
  requiredText(card.rateCardCode, "Rate-card code", 64);
  requiredText(card.displayName, "Rate-card display name", 160);
  optionalText(card.description, "Rate-card description");
  cadCurrency(card.currency);
  booleanValue(card.active, "Rate-card active state");
  if (card.customerNetSuiteId !== null) {
    safeInteger(card.customerNetSuiteId, "Customer NetSuite ID", 1);
  }
  if (card.subsidiaryNetSuiteId !== null) {
    safeInteger(card.subsidiaryNetSuiteId, "Subsidiary NetSuite ID", 1);
  }
  nullableCode(card.serviceTemplateCode, "Service-template code");
  nullableCode(card.itemCode ?? null, "Local item code");
}

/** @param {Record<string, any>} version */
function validateVersion(version) {
  allowedFields(version, [
    "versionNumber", "effectiveFrom", "effectiveTo",
    "defaultRentalCalendarDays", "calculationNotes"
  ]);
  safeInteger(version.versionNumber, "Version number", 1);
  const from = /** @type {string} */ (isoDate(version.effectiveFrom, "Effective from"));
  const to = isoDate(version.effectiveTo, "Effective to", true);
  if (to !== null && Date.parse(to) <= Date.parse(from)) {
    return invalidInput("Effective to must be later than effective from.");
  }
  safeInteger(version.defaultRentalCalendarDays, "Default rental days", 1);
  optionalText(version.calculationNotes, "Calculation notes");
}

/** @param {Record<string, any>} band */
function validateBand(band) {
  allowedFields(band, [
    "itemCode", "serviceCode", "binTypeCode", "sequenceNumber", "minimumMetres",
    "maximumMetres", "amountMinor", "downtownSurchargeMinor", "currency",
    "description", "pricingBasis", "boundaryRule", "originYardCodes"
  ]);
  nullableCode(band.itemCode ?? null, "Band item code");
  requiredText(band.serviceCode, "Band service code", 64);
  nullableCode(band.binTypeCode, "Band BIN type");
  safeInteger(band.sequenceNumber, "Band sequence");
  safeInteger(band.minimumMetres, "Band minimum metres");
  nullableSafeInteger(band.maximumMetres, "Band maximum metres");
  safeInteger(band.amountMinor, "Band amount cents");
  safeInteger(band.downtownSurchargeMinor, "Band surcharge cents");
  if (band.pricingBasis !== undefined
      && !Object.values(DISTANCE_PRICING_BASES).includes(band.pricingBasis)) {
    return invalidInput("Band pricing basis must be flat or per_km.");
  }
  if (band.boundaryRule !== undefined
      && !Object.values(DISTANCE_BOUNDARY_RULES).includes(band.boundaryRule)) {
    return invalidInput("Band boundary rule is invalid.");
  }
  if (band.originYardCodes !== undefined) {
    if (!Array.isArray(band.originYardCodes) || band.originYardCodes.length > 20) {
      return invalidInput("Band origin yards must be a list of at most 20 yard codes.");
    }
    const codes = band.originYardCodes.map((code) => nullableCode(code, "Origin yard code"));
    if (codes.includes(null) || new Set(codes).size !== codes.length
        || codes.some((code, index) => code !== [...codes].sort()[index])) {
      return invalidInput("Band origin yard codes must be unique and sorted.");
    }
  }
  cadCurrency(band.currency);
  optionalText(band.description, "Band description");
}

/** @param {Record<string, any>[]} bands */
function validateBandGroups(bands) {
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const band of bands) {
    const normalizedBand = inputRecord(band, "Distance band");
    validateBand(normalizedBand);
    const key = `${normalizedBand.itemCode || ""}\u0000${normalizedBand.serviceCode}\u0000${normalizedBand.binTypeCode || ""}\u0000${(normalizedBand.originYardCodes || []).join("|")}`;
    groups.set(key, [...(groups.get(key) || []), normalizedBand]);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (
      left.minimumMetres - right.minimumMetres || left.sequenceNumber - right.sequenceNumber
    ));
    if (!validateRateBands(ordered).valid) {
      return fail("MBT_RATE_CARD_INVALID", "Distance bands must be contiguous and non-overlapping.");
    }
  }
}

/** @param {Record<string, any>} component */
function validateComponent(component) {
  allowedFields(component, [
    "itemCode", "componentCode", "componentKind", "serviceCode", "binTypeCode", "rateBasis",
    "amountMinor", "percentageBasisPoints", "defaultQuantity", "currency",
    "taxable", "active", "description"
  ]);
  nullableCode(component.itemCode ?? null, "Component item code");
  requiredText(component.componentCode, "Component code", 64);
  if (!COMPONENT_KINDS.has(component.componentKind) || !COMPONENT_BASES.has(component.rateBasis)) {
    return invalidInput("The component kind or basis is invalid.");
  }
  if (component.serviceCode !== null) {
    requiredText(component.serviceCode, "Component service code", 64);
  }
  nullableCode(component.binTypeCode, "Component BIN type");
  if (component.rateBasis === "percentage") {
    if (component.amountMinor !== null) {
      return invalidInput("Percentage components cannot include an amount in cents.");
    }
    safeInteger(component.percentageBasisPoints, "Component percentage basis points");
  } else {
    safeInteger(component.amountMinor, "Component amount cents");
    if (component.percentageBasisPoints !== null) {
      return invalidInput("Fixed components cannot include percentage basis points.");
    }
  }
  const quantity = Number(component.defaultQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return invalidInput("Component default quantity must be positive.");
  }
  cadCurrency(component.currency);
  booleanValue(component.taxable, "Component taxable state");
  booleanValue(component.active, "Component active state");
  optionalText(component.description, "Component description");
}

/** @param {Record<string, any>} tariff */
function validateTariff(tariff) {
  allowedFields(tariff, [
    "itemCode", "dumpSiteCode", "materialCode", "tariffCode", "pricingBasis",
    "unitOfMeasure", "amountMinor", "minimumAmountMinor", "currency",
    "active", "description"
  ]);
  nullableCode(tariff.itemCode ?? null, "Dump item code");
  nullableCode(tariff.dumpSiteCode, "Dump-site code");
  nullableCode(tariff.materialCode, "Material code");
  requiredText(tariff.tariffCode, "Tariff code", 64);
  if (!TARIFF_BASES.has(tariff.pricingBasis)) {
    return invalidInput("The dump-tariff basis is invalid.");
  }
  if (tariff.pricingBasis === "fixed" && tariff.unitOfMeasure !== null) {
    return invalidInput("A fixed dump tariff cannot include a unit.");
  }
  if (tariff.pricingBasis !== "fixed") {
    requiredText(tariff.unitOfMeasure, "Dump-tariff unit", 32);
  }
  safeInteger(tariff.amountMinor, "Dump-tariff amount cents");
  safeInteger(tariff.minimumAmountMinor, "Dump-tariff minimum cents");
  cadCurrency(tariff.currency);
  booleanValue(tariff.active, "Dump-tariff active state");
  optionalText(tariff.description, "Dump-tariff description");
}

/** @param {unknown} value @param {string} label */
function cadMinor(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return invalidInput(`${label} must be a non-negative integer number of CAD cents.`);
  }
  return amount;
}

/** @param {unknown} value @param {string} label */
function rentalBinCode(value, label) {
  const code = requiredText(value, label, 64).toUpperCase();
  if (!new Set(["14YD", "20YD", "40YD"]).has(code)) {
    return invalidInput(`${label} must be 14YD, 20YD, or 40YD.`);
  }
  return code;
}

/** @param {Record<string, any>} input */
function assertSimplifiedRateCollections(input) {
  for (const field of [
    "rentalRates", "extensionRates", "binDeliveryBands", "mbbsCrossChargeBands", "dumpTariffs"
  ]) {
    if (!Array.isArray(input[field])) {
      return invalidInput("Every simplified rate collection must be an array.");
    }
  }
  if (input.rentalRates.length !== 3 || input.extensionRates.length !== 3) {
    return invalidInput("Provide one rental and one extension price for 14YD, 20YD, and 40YD.");
  }
}

/** @param {Record<string, any>} input */
function simplifiedRentalComponents(input) {
  const suppliedRentalBins = new Set();
  const suppliedExtensionBins = new Set();
  const components = [];
  for (const raw of input.rentalRates) {
    const row = inputRecord(raw, "Rental price");
    allowedFields(row, ["binTypeCode", "amountMinor", "taxable"]);
    const binTypeCode = rentalBinCode(row.binTypeCode, "Rental bin type");
    if (suppliedRentalBins.has(binTypeCode)) {
      return invalidInput("Each rental bin type may be entered once.");
    }
    suppliedRentalBins.add(binTypeCode);
    components.push({
      itemCode: binTypeCode,
      componentCode: `rental_${binTypeCode.toLowerCase()}_14_days`, componentKind: "rental",
      serviceCode: "delivery", binTypeCode, rateBasis: "flat", amountMinor: cadMinor(row.amountMinor, "Rental price"),
      percentageBasisPoints: null, defaultQuantity: 1, currency: "CAD", taxable: row.taxable !== false,
      active: true, description: `${binTypeCode} fixed first 14 Toronto calendar days`
    });
  }
  for (const raw of input.extensionRates) {
    const row = inputRecord(raw, "Extension price");
    allowedFields(row, ["binTypeCode", "amountMinor", "taxable"]);
    const binTypeCode = rentalBinCode(row.binTypeCode, "Extension bin type");
    if (suppliedExtensionBins.has(binTypeCode)) {
      return invalidInput("Each extension bin type may be entered once.");
    }
    suppliedExtensionBins.add(binTypeCode);
    components.push({
      itemCode: binTypeCode,
      componentCode: `extension_${binTypeCode.toLowerCase()}_day`, componentKind: "extension",
      serviceCode: "extension", binTypeCode, rateBasis: "per_day", amountMinor: cadMinor(row.amountMinor, "Extension price"),
      percentageBasisPoints: null, defaultQuantity: 1, currency: "CAD", taxable: row.taxable !== false,
      active: true, description: `${binTypeCode} extension per Toronto calendar day`
    });
  }
  if (suppliedRentalBins.size !== 3 || suppliedExtensionBins.size !== 3) {
    return invalidInput("Rental and extension pricing must cover 14YD, 20YD, and 40YD exactly once.");
  }
  return components;
}

/**
 * Convert the concise operator-facing rental form into the immutable graph
 * used by the existing rate-card lifecycle. This keeps the mature CSV/API
 * path compatible while making the common local setup explicit and safe.
 *
 * @param {unknown} value
 */
export function normalizeSimplifiedRentalRateCard(value) {
  const input = inputRecord(value, "Simplified rental rate card");
  allowedFields(input, [
    "rateCard", "effectiveFrom", "calculationNotes", "rentalRates",
    "extensionRates", "binDeliveryBands", "mbbsCrossChargeBands", "dumpTariffs"
  ]);
  const header = inputRecord(input.rateCard, "Rate-card header");
  allowedFields(header, ["rateCardCode", "displayName", "description", "customerNetSuiteId", "subsidiaryNetSuiteId"]);
  assertSimplifiedRateCollections(input);
  const components = simplifiedRentalComponents(input);
  /**
   * @param {unknown[]} rows
   * @param {string} serviceCode
   * @param {boolean} binRequired
   */
  const bandRows = (rows, serviceCode, binRequired) => rows.map((raw, index) => {
    const row = inputRecord(raw, "Distance band");
    allowedFields(row, ["binTypeCode", "minimumMetres", "maximumMetres", "amountMinor", "description"]);
    const binTypeCode = binRequired ? rentalBinCode(row.binTypeCode, "Delivery bin type") : null;
    if (!binRequired && row.binTypeCode !== null && row.binTypeCode !== undefined && String(row.binTypeCode).trim()) {
      return invalidInput("MBBS cross-charge bands do not have a bin type.");
    }
    return {
      itemCode: "DELIVERY_CROSS_CHARGE", serviceCode, binTypeCode, sequenceNumber: index,
      minimumMetres: safeInteger(row.minimumMetres, "Distance-band minimum metres"),
      maximumMetres: row.maximumMetres === null || row.maximumMetres === undefined || row.maximumMetres === ""
        ? null : safeInteger(row.maximumMetres, "Distance-band maximum metres"),
      amountMinor: cadMinor(row.amountMinor, "Distance-band price"), downtownSurchargeMinor: 0,
      pricingBasis: DISTANCE_PRICING_BASES.FLAT,
      boundaryRule: DISTANCE_BOUNDARY_RULES.LEGACY_LOWER_INCLUSIVE,
      originYardCodes: [],
      currency: "CAD", description: optionalText(String(row.description || ""), "Distance-band description")
    };
  });
  const distanceBands = [
    ...bandRows(input.binDeliveryBands, "delivery", true),
    ...bandRows(input.mbbsCrossChargeBands, "mbbs_cross_charge", false)
  ];
  const dumpTariffs = (/** @type {unknown[]} */ (input.dumpTariffs)).map((raw, index) => {
    const row = inputRecord(raw, "Customer dump tariff");
    allowedFields(row, ["itemCode", "materialCode", "amountMinor", "minimumAmountMinor", "description"]);
    const itemCode = row.itemCode || row.materialCode;
    return {
      dumpSiteCode: null,
      itemCode: itemCode === null || itemCode === undefined || itemCode === ""
        ? null : nullableCode(itemCode, "Dump item code"),
      materialCode: row.materialCode === null || row.materialCode === undefined || row.materialCode === ""
        ? null : nullableCode(row.materialCode, "Dump material code"),
      tariffCode: `customer_material_${index + 1}`,
      pricingBasis: "per_weight", unitOfMeasure: "TONNE",
      amountMinor: cadMinor(row.amountMinor, "Customer dump tariff"),
      minimumAmountMinor: cadMinor(row.minimumAmountMinor ?? 0, "Customer dump tariff minimum"),
      currency: "CAD", active: true, description: optionalText(String(row.description || ""), "Customer dump tariff description")
    };
  });
  return normalizeLocalRateCardGraph({
    rateCard: { ...header, serviceTemplateCode: null, currency: "CAD", active: true },
    version: { versionNumber: 1, effectiveFrom: input.effectiveFrom, effectiveTo: null, defaultRentalCalendarDays: 14, calculationNotes: optionalText(String(input.calculationNotes || ""), "Calculation notes") },
    distanceBands, components, dumpTariffs, depositRules: []
  }, { sourceKind: "manual" });
}

/** @param {Record<string, any>} rule */
function validateDepositRule(rule) {
  allowedFields(rule, [
    "ruleCode", "ruleType", "binTypeCode", "serviceCode", "fixedAmountMinor",
    "percentageBasisPoints", "currency", "liabilityAccountMappingKey", "active",
    "description"
  ]);
  requiredText(rule.ruleCode, "Deposit rule code", 64);
  if (!DEPOSIT_TYPES.has(rule.ruleType)) {
    return invalidInput("The deposit rule type is invalid.");
  }
  nullableCode(rule.binTypeCode, "Deposit BIN type");
  if (rule.serviceCode !== null) {
    requiredText(rule.serviceCode, "Deposit service code", 64);
  }
  if (rule.ruleType === "percentage") {
    if (rule.fixedAmountMinor !== null) {
      return invalidInput("Percentage deposit rules cannot include fixed cents.");
    }
    safeInteger(rule.percentageBasisPoints, "Deposit percentage basis points");
  } else {
    safeInteger(rule.fixedAmountMinor, "Deposit fixed cents");
    if (rule.percentageBasisPoints !== null) {
      return invalidInput("Fixed deposit rules cannot include percentage basis points.");
    }
  }
  cadCurrency(rule.currency);
  optionalText(rule.liabilityAccountMappingKey, "Deposit liability mapping", 160);
  booleanValue(rule.active, "Deposit active state");
  optionalText(rule.description, "Deposit description");
}

/**
 * Validate the manual and already-normalized CSV aggregate through one pure
 * allowlisted contract. The graph is cloned but not reordered or rewritten.
 *
 * @param {unknown} value
 * @param {{sourceKind?: unknown}} [options]
 */
export function normalizeLocalRateCardGraph(value, { sourceKind } = {}) {
  if (!new Set(["manual", "csv"]).has(String(sourceKind || ""))) {
    return invalidInput("A manual or CSV rate-card source is required.");
  }
  const graph = inputRecord(value, "Rate-card graph");
  allowedFields(graph, [
    "rateCard", "version", "distanceBands", "components", "dumpTariffs",
    "depositRules", "mbbsChargingPolicy"
  ]);
  const rateCard = inputRecord(graph.rateCard, "Rate-card header");
  const version = inputRecord(graph.version, "Rate-card version");
  if (![graph.distanceBands, graph.components, graph.dumpTariffs, graph.depositRules]
    .every(Array.isArray)) {
    return invalidInput("All four rate-card child collections are required.");
  }
  validateCard(rateCard);
  validateVersion(version);
  validateBandGroups(/** @type {Record<string, any>[]} */ (graph.distanceBands));
  for (const component of graph.components) {
    validateComponent(inputRecord(component, "Rate component"));
  }
  for (const tariff of graph.dumpTariffs) {
    validateTariff(inputRecord(tariff, "Dump tariff"));
  }
  for (const rule of graph.depositRules) {
    validateDepositRule(inputRecord(rule, "Deposit rule"));
  }
  const normalized = structuredClone(graph);
  if (isMbbsCrossChargeGraph(graph)) {
    normalized.mbbsChargingPolicy = normalizeMbbsRateCardPolicy(graph.mbbsChargingPolicy);
  } else if (graph.mbbsChargingPolicy !== null && graph.mbbsChargingPolicy !== undefined) {
    return invalidInput("An MBBS charging policy requires DELIVERY_CHARGE_MBBS cross-charge bands.");
  }
  return normalized;
}

/** @param {MbtActor} actor */
async function assertMasterDataCommand(actor) {
  const admin = actor?.roles?.some((role) => String(role).trim().toLowerCase() === "admin") === true;
  if (!admin) {
    throw new MbtError({ status: 403, code: "MBT_ADMIN_REQUIRED", message: "Admin account required." });
  }
  await authorizeMbtPhase3Capability({ capability: "masterData", pilotAuthorized: true });
}

/** @param {unknown} value */
function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return invalidInput("A positive expected revision is required.");
  }
  return Number(value);
}

/** @param {number} actual @param {unknown} expected */
function assertRevision(actual, expected) {
  if (actual !== expectedRevision(expected)) {
    throw new MbtError({
      status: 409,
      code: "MBT_STALE_REVISION",
      message: "This rate-card version changed. Refresh before continuing."
    });
  }
}

/** @param {unknown} value */
function auditReason(value) {
  return requiredText(value, "Audit reason");
}

/** @param {Record<string, any>} graph */
async function resolveGraphReferences(graph) {
  const binCodes = [...new Set([
    ...graph.distanceBands.map((/** @type {Record<string, any>} */ row) => row.binTypeCode),
    ...graph.components.map((/** @type {Record<string, any>} */ row) => row.binTypeCode),
    ...graph.depositRules.map((/** @type {Record<string, any>} */ row) => row.binTypeCode)
  ].filter(Boolean))];
  const bins = await query(
    "SELECT type_code, bin_type_id::text FROM mbt_bin_types WHERE active AND type_code = ANY($1::text[])",
    [binCodes]
  );
  const dumpSiteCodes = [...new Set(graph.dumpTariffs.map(
    (/** @type {Record<string, any>} */ row) => row.dumpSiteCode
  ).filter(Boolean))];
  const dumps = await query(
    "SELECT dump_site_code, dump_site_id::text FROM mbt_dump_sites WHERE active AND dump_site_code = ANY($1::text[])",
    [dumpSiteCodes]
  );
  const itemCodes = [...new Set([
    graph.rateCard.itemCode,
    ...graph.distanceBands.map((/** @type {Record<string, any>} */ row) => row.itemCode),
    ...graph.components.map((/** @type {Record<string, any>} */ row) => row.itemCode),
    ...graph.dumpTariffs.map((/** @type {Record<string, any>} */ row) => row.itemCode)
  ].filter(Boolean))];
  const items = await query(
    `SELECT item_code, item_type, charge_basis, bin_type_id::text
       FROM mbt_local_item_settings
      WHERE active AND item_code = ANY($1::text[])`,
    [itemCodes]
  );
  const yardCodes = [...new Set(graph.distanceBands.flatMap(
    (/** @type {Record<string, any>} */ row) => row.originYardCodes || []
  ))];
  const yards = await query(
    "SELECT yard_code FROM mbt_yards WHERE active AND yard_code = ANY($1::text[])",
    [yardCodes]
  );
  const template = await query(
    "SELECT template_id::text FROM mbt_service_templates WHERE active AND template_code = $1",
    [graph.rateCard.serviceTemplateCode || INTERNAL_SERVICE_TEMPLATE_CODE]
  );
  const binTypes = new Map(bins.rows.map((/** @type {Record<string, any>} */ row) => [
    row.type_code,
    row.bin_type_id
  ]));
  const dumpSites = new Map(dumps.rows.map((/** @type {Record<string, any>} */ row) => [
    row.dump_site_code,
    row.dump_site_id
  ]));
  const localItems = new Map(items.rows.map((/** @type {Record<string, any>} */ row) => [
    row.item_code,
    { itemType: row.item_type, chargeBasis: row.charge_basis, binTypeId: row.bin_type_id }
  ]));
  const materialCodes = [...new Set(graph.dumpTariffs.map(
    (/** @type {Record<string, any>} */ row) => row.materialCode
      || (localItems.get(row.itemCode)?.itemType === "dump" ? row.itemCode : null)
  ).filter(Boolean))];
  const materials = await query(
    "SELECT material_code, material_id::text FROM mbt_materials WHERE active AND material_code = ANY($1::text[])",
    [materialCodes]
  );
  const materialTypes = new Map(materials.rows.map((/** @type {Record<string, any>} */ row) => [
    row.material_code,
    row.material_id
  ]));
  const activeYardCodes = new Set(yards.rows.map(
    (/** @type {Record<string, any>} */ row) => String(row.yard_code)
  ));
  const missing = binCodes.some((code) => !binTypes.has(code))
    || graph.dumpTariffs.some(
      (/** @type {Record<string, any>} */ row) => row.dumpSiteCode && !dumpSites.has(row.dumpSiteCode)
    )
    || graph.dumpTariffs.some((/** @type {Record<string, any>} */ row) => {
      const materialCode = row.materialCode
        || (localItems.get(row.itemCode)?.itemType === "dump" ? row.itemCode : null);
      return materialCode && !materialTypes.has(materialCode);
    })
    || itemCodes.some((code) => !localItems.has(code))
    || yardCodes.some((code) => !activeYardCodes.has(code))
    || graph.distanceBands.some((/** @type {Record<string, any>} */ row) => (
      row.itemCode && localItems.get(row.itemCode)?.itemType !== "delivery_fee"
    ))
    || graph.dumpTariffs.some((/** @type {Record<string, any>} */ row) => {
      if (!row.itemCode) {
        return false;
      }
      const item = localItems.get(row.itemCode);
      if (!item || !["dump", "aggregate"].includes(item.itemType)) {
        return true;
      }
      const unit = String(row.unitOfMeasure || "").toUpperCase();
      if (item.itemType === "aggregate") {
        return item.chargeBasis !== "per_yard"
          || row.pricingBasis !== "per_quantity" || unit !== "YARD";
      }
      if (item.chargeBasis === "per_bin") {
        return row.pricingBasis !== "per_quantity" || unit !== "BIN";
      }
      return item.chargeBasis !== "per_tonne"
        || !["per_weight", "per_quantity"].includes(row.pricingBasis) || unit !== "TONNE";
    })
    || graph.components.some((/** @type {Record<string, any>} */ row) => (
      row.itemCode && ["rental", "extension"].includes(row.componentKind)
        && localItems.get(row.itemCode)?.itemType !== "bin"
    ))
    || !template.rowCount;
  if (missing) {
    return fail("MBT_MASTER_REFERENCE_INVALID", "A referenced local rate-card record is unavailable.");
  }
  return {
    binTypes,
    dumpSites,
    materials: materialTypes,
    items: localItems,
    yardCodes: activeYardCodes,
    serviceTemplateId: template.rows[0].template_id
  };
}

/** @param {string} rateCardVersionId */
async function publicVersion(rateCardVersionId) {
  const result = await query(
    `SELECT version.rate_card_version_id::text AS "rateCardVersionId",
            version.rate_card_id::text AS "rateCardId",
            card.rate_card_code AS "rateCardCode",
            card.display_name AS "displayName",
            card.item_code AS "itemCode",
            ARRAY(
              SELECT DISTINCT priced.item_code
                FROM (
                  SELECT band.item_code FROM mbt_rate_distance_bands band
                   WHERE band.rate_card_version_id = version.rate_card_version_id
                  UNION ALL
                  SELECT component.item_code FROM mbt_rate_components component
                   WHERE component.rate_card_version_id = version.rate_card_version_id
                  UNION ALL
                  SELECT tariff.item_code FROM mbt_dump_tariffs tariff
                   WHERE tariff.rate_card_version_id = version.rate_card_version_id
                ) priced
               WHERE priced.item_code IS NOT NULL
               ORDER BY priced.item_code
            ) AS "itemCodes",
            card.active AS "cardActive",
            card.revision::int AS "cardRevision",
            card.currency,
            version.version_number AS "versionNumber",
            version.status,
            (version.status = 'draft' AND version.first_used_at IS NULL) AS editable,
            version.effective_from AS "effectiveFrom",
            version.effective_to AS "effectiveTo",
            version.default_rental_calendar_days AS "defaultRentalCalendarDays",
            version.calculation_notes AS "calculationNotes",
            version.validation_snapshot AS validation,
            version.revision::int AS revision,
            version.activated_at AS "activatedAt",
            version.first_used_at AS "firstUsedAt"
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
      WHERE version.rate_card_version_id = $1`,
    [rateCardVersionId]
  );
  if (!result.rowCount) {
    throw new MbtError({ status: 404, code: "MBT_RATE_CARD_NOT_FOUND", message: "Rate-card version not found." });
  }
  return result.rows[0];
}

/** @param {Record<string, any>} graph @param {MbtActor} actor @param {Record<string, any>} references */
async function insertGraph(graph, actor, references) {
  const rateCardId = crypto.randomUUID();
  const rateCardVersionId = crypto.randomUUID();
  await query(
    `INSERT INTO mbt_rate_cards (
       rate_card_id, rate_card_code, display_name, description, item_code,
       customer_netsuite_id, subsidiary_netsuite_id, service_template_id,
       currency, active, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)`,
    [
      rateCardId, graph.rateCard.rateCardCode, graph.rateCard.displayName,
      graph.rateCard.description, graph.rateCard.itemCode ?? null,
      graph.rateCard.customerNetSuiteId,
      graph.rateCard.subsidiaryNetSuiteId, references.serviceTemplateId,
      graph.rateCard.currency, graph.rateCard.active, actor.operatorId
    ]
  );
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, effective_to, default_rental_calendar_days,
       calculation_notes, validation_snapshot, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, '{}'::jsonb, 1, $8, $8)`,
    [
      rateCardVersionId, rateCardId, graph.version.versionNumber,
      graph.version.effectiveFrom, graph.version.effectiveTo,
      graph.version.defaultRentalCalendarDays, graph.version.calculationNotes,
      actor.operatorId
    ]
  );
  await replaceMbbsChargingPolicy(rateCardVersionId, graph.mbbsChargingPolicy, actor);
  await insertDistanceBands(rateCardVersionId, graph.distanceBands, references);
  await insertComponents(rateCardVersionId, graph.components, references);
  await insertDumpTariffs(rateCardVersionId, graph.dumpTariffs, references);
  await insertDepositRules(rateCardVersionId, graph.depositRules, references);
  return { rateCardId, rateCardVersionId };
}

/** @param {string} versionId @param {Record<string, any>[]} rows @param {Record<string, any>} references */
async function insertDistanceBands(versionId, rows, references) {
  for (const row of rows) {
    await query(
      `INSERT INTO mbt_rate_distance_bands (
         rate_distance_band_id, rate_card_version_id, item_code, service_code, bin_type_id,
         sequence_number, minimum_metres, maximum_metres, amount_minor,
         pricing_basis, boundary_rule, origin_yard_codes,
         currency, downtown_surcharge_minor, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13, $14, $15)`,
      [
        crypto.randomUUID(), versionId, row.itemCode || null, row.serviceCode,
        row.binTypeCode ? references.binTypes.get(row.binTypeCode) : null,
        row.sequenceNumber, row.minimumMetres, row.maximumMetres, row.amountMinor,
        row.pricingBasis || DISTANCE_PRICING_BASES.FLAT,
        row.boundaryRule || DISTANCE_BOUNDARY_RULES.LEGACY_LOWER_INCLUSIVE,
        row.originYardCodes || [],
        row.currency, row.downtownSurchargeMinor, row.description
      ]
    );
  }
}

/** @param {string} versionId @param {Record<string, any>[]} rows @param {Record<string, any>} references */
async function insertComponents(versionId, rows, references) {
  for (const row of rows) {
    await query(
      `INSERT INTO mbt_rate_components (
         rate_component_id, rate_card_version_id, item_code, component_code, component_kind,
         service_code, bin_type_id, rate_basis, amount_minor,
         percentage_basis_points, default_quantity, currency, taxable, active, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        crypto.randomUUID(), versionId, row.itemCode || null, row.componentCode, row.componentKind,
        row.serviceCode, row.binTypeCode ? references.binTypes.get(row.binTypeCode) : null,
        row.rateBasis, row.amountMinor, row.percentageBasisPoints, row.defaultQuantity,
        row.currency, row.taxable, row.active, row.description
      ]
    );
  }
}

/** @param {string} versionId @param {Record<string, any>[]} rows @param {Record<string, any>} references */
async function insertDumpTariffs(versionId, rows, references) {
  for (const row of rows) {
    await query(
      `INSERT INTO mbt_dump_tariffs (
         dump_tariff_id, rate_card_version_id, item_code, dump_site_id, material_id,
         tariff_code, pricing_basis, unit_of_measure, amount_minor,
         minimum_amount_minor, currency, active, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        crypto.randomUUID(), versionId, row.itemCode || null,
        row.dumpSiteCode ? references.dumpSites.get(row.dumpSiteCode) : null,
        (() => {
          const item = references.items.get(row.itemCode);
          const materialCode = row.materialCode || (item?.itemType === "dump" ? row.itemCode : null);
          return materialCode ? references.materials.get(materialCode) : null;
        })(),
        row.tariffCode, row.pricingBasis, row.unitOfMeasure, row.amountMinor,
        row.minimumAmountMinor, row.currency, row.active, row.description
      ]
    );
  }
}

/** @param {string} versionId @param {Record<string, any>[]} rows @param {Record<string, any>} references */
async function insertDepositRules(versionId, rows, references) {
  for (const row of rows) {
    await query(
      `INSERT INTO mbt_deposit_rules (
         deposit_rule_id, rate_card_version_id, rule_code, rule_type, bin_type_id,
         service_code, fixed_amount_minor, percentage_basis_points, currency,
         liability_account_mapping_key, active, description
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        crypto.randomUUID(), versionId, row.ruleCode, row.ruleType,
        row.binTypeCode ? references.binTypes.get(row.binTypeCode) : null,
        row.serviceCode, row.fixedAmountMinor, row.percentageBasisPoints,
        row.currency, row.liabilityAccountMappingKey, row.active, row.description
      ]
    );
  }
}

/** @param {string} versionId @param {Record<string, any> | null | undefined} policy @param {MbtActor} actor */
async function replaceMbbsChargingPolicy(versionId, policy, actor) {
  if (!policy) {
    await query(
      "DELETE FROM mbt_mbbs_rate_card_policies WHERE rate_card_version_id = $1",
      [versionId]
    );
    return;
  }
  await query(
    `INSERT INTO mbt_mbbs_rate_card_policies (
       rate_card_version_id, schema_version, currency,
       direct_pickup_unit_amount_minor, po_additional_drop_unit_amount_minor,
       so_charge_basis, to_replenishment_charge_basis,
       to_direct_pickup_charge_basis, po_charge_basis,
       po_additional_drop_basis, dispatch_load_split_basis,
       revision, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $12)
     ON CONFLICT (rate_card_version_id) DO UPDATE
       SET schema_version = EXCLUDED.schema_version,
           currency = EXCLUDED.currency,
           direct_pickup_unit_amount_minor = EXCLUDED.direct_pickup_unit_amount_minor,
           po_additional_drop_unit_amount_minor = EXCLUDED.po_additional_drop_unit_amount_minor,
           so_charge_basis = EXCLUDED.so_charge_basis,
           to_replenishment_charge_basis = EXCLUDED.to_replenishment_charge_basis,
           to_direct_pickup_charge_basis = EXCLUDED.to_direct_pickup_charge_basis,
           po_charge_basis = EXCLUDED.po_charge_basis,
           po_additional_drop_basis = EXCLUDED.po_additional_drop_basis,
           dispatch_load_split_basis = EXCLUDED.dispatch_load_split_basis,
           revision = mbt_mbbs_rate_card_policies.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [
      versionId, policy.schemaVersion, policy.currency,
      policy.directPickupUnitAmountMinor, policy.poAdditionalDropUnitAmountMinor,
      policy.soChargeBasis, policy.toReplenishmentChargeBasis,
      policy.toDirectPickupChargeBasis, policy.poChargeBasis,
      policy.poAdditionalDropBasis, policy.dispatchLoadSplitBasis,
      actor.operatorId
    ]
  );
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.sourceKind
 * @param {unknown} input.graph
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function applyLocalRateCardDraft(input) {
  const graph = normalizeLocalRateCardGraph(input.graph, { sourceKind: input.sourceKind });
  const reason = String(input.reason || "").trim() || "Created local rate-card draft";
  await assertMasterDataCommand(input.actor);
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.draft.apply",
    idempotencyKey: input.idempotencyKey,
    payload: { sourceKind: input.sourceKind, graph, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const references = await resolveGraphReferences(graph);
      const created = await insertGraph(graph, input.actor, references);
      const version = await publicVersion(created.rateCardVersionId);
      return {
        status: 201,
        body: { schemaVersion: "mbt-rate-card-v1", version },
        audit: {
          action: "mbt.rate_card.draft.applied",
          entityType: "mbt_rate_card_version",
          entityId: created.rateCardVersionId,
          beforeState: { exists: false },
          afterState: { version },
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: input.sourceKind
        }
      };
    }
  });
}

/**
 * Replace only an unused draft version. Rate-card identity belongs to the
 * shared card and is intentionally not changed here; if its name/code needs
 * to change, the operator creates a new card instead. Active, retired, and
 * previously-used versions are immutable and must be cloned first.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.rateCardVersionId
 * @param {number} input.expectedRevision
 * @param {string} input.sourceKind
 * @param {unknown} input.graph
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function replaceLocalRateCardDraft(input) {
  const graph = normalizeLocalRateCardGraph(input.graph, { sourceKind: input.sourceKind });
  const revision = expectedRevision(input.expectedRevision);
  const reason = auditReason(input.reason);
  await assertMasterDataCommand(input.actor);
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.draft.replace",
    idempotencyKey: input.idempotencyKey,
    payload: { rateCardVersionId: input.rateCardVersionId, expectedRevision: revision, sourceKind: input.sourceKind, graph, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const before = await lockedVersion(input.rateCardVersionId);
      assertRevision(Number(before.revision), revision);
      if (before.status !== "draft" || before.first_used_at) {
        return fail("MBT_RATE_CARD_EDIT_REQUIRES_CLONE", "Only an unused draft can be edited; clone this version first.");
      }
      const card = await query(
        "SELECT rate_card_code, display_name, item_code FROM mbt_rate_cards WHERE rate_card_id = $1 FOR UPDATE",
        [before.rate_card_id]
      );
      if (!card.rowCount || String(card.rows[0].rate_card_code) !== graph.rateCard.rateCardCode
          || String(card.rows[0].display_name) !== graph.rateCard.displayName) {
        return fail("MBT_RATE_CARD_IDENTITY_IMMUTABLE", "Rate-card code and name are immutable after draft creation; create a new rate card for a new identity.");
      }
      const references = await resolveGraphReferences(graph);
      for (const table of ["mbt_deposit_rules", "mbt_dump_tariffs", "mbt_rate_components", "mbt_rate_distance_bands"]) {
        await query(`DELETE FROM ${table} WHERE rate_card_version_id = $1`, [input.rateCardVersionId]);
      }
      await replaceMbbsChargingPolicy(input.rateCardVersionId, graph.mbbsChargingPolicy, input.actor);
      await insertDistanceBands(input.rateCardVersionId, graph.distanceBands, references);
      await insertComponents(input.rateCardVersionId, graph.components, references);
      await insertDumpTariffs(input.rateCardVersionId, graph.dumpTariffs, references);
      await insertDepositRules(input.rateCardVersionId, graph.depositRules, references);
      const updated = await query(
        `UPDATE mbt_rate_card_versions
            SET effective_from = $2, effective_to = $3,
                default_rental_calendar_days = $4, calculation_notes = $5,
                validation_snapshot = '{}'::jsonb, revision = revision + 1,
                updated_by = $6, updated_at = now()
          WHERE rate_card_version_id = $1 AND revision = $7
          RETURNING revision::int`,
        [input.rateCardVersionId, graph.version.effectiveFrom, graph.version.effectiveTo,
          graph.version.defaultRentalCalendarDays, graph.version.calculationNotes,
          input.actor.operatorId, revision]
      );
      if (!updated.rowCount) {
        throw new MbtError({ status: 409, code: "MBT_STALE_REVISION", message: "This draft rate-card changed. Refresh before saving." });
      }
      const version = await publicVersion(input.rateCardVersionId);
      return {
        status: 200,
        body: { schemaVersion: "mbt-rate-card-v1", version },
        audit: {
          action: "mbt.rate_card.draft.replaced", entityType: "mbt_rate_card_version", entityId: input.rateCardVersionId,
          beforeState: { status: before.status, revision }, afterState: { version }, reason,
          revisionBefore: revision, revisionAfter: Number(updated.rows[0].revision), source: input.sourceKind
        }
      };
    }
  });
}

/** @param {string} rateCardVersionId */
async function lockedVersion(rateCardVersionId) {
  const result = await query(
    `SELECT version.*, card.rate_card_code, card.currency
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
      WHERE version.rate_card_version_id = $1
      FOR UPDATE OF version`,
    [rateCardVersionId]
  );
  if (!result.rowCount) {
    throw new MbtError({ status: 404, code: "MBT_RATE_CARD_NOT_FOUND", message: "Rate-card version not found." });
  }
  return result.rows[0];
}

/** @param {string} rateCardVersionId */
// eslint-disable-next-line complexity -- Each item type has a distinct complete pricing mechanism to validate.
async function storedBandValidation(rateCardVersionId) {
  const rows = await query(
    `SELECT item_code, service_code, bin_type_id::text, sequence_number,
            minimum_metres::int, maximum_metres::int, boundary_rule,
            origin_yard_codes
       FROM mbt_rate_distance_bands
      WHERE rate_card_version_id = $1
      ORDER BY item_code NULLS FIRST, service_code, bin_type_id NULLS FIRST,
               origin_yard_codes, minimum_metres, sequence_number`,
    [rateCardVersionId]
  );
  const components = await query(
    `SELECT item_code, component_kind
       FROM mbt_rate_components
      WHERE rate_card_version_id = $1 AND active`,
    [rateCardVersionId]
  );
  const tariffs = await query(
    `SELECT item_code
       FROM mbt_dump_tariffs
      WHERE rate_card_version_id = $1 AND active`,
    [rateCardVersionId]
  );
  const itemTypes = await query(
    `SELECT item.item_code, item.item_type
       FROM mbt_local_item_settings item
      WHERE item.item_code IN (
        SELECT band.item_code FROM mbt_rate_distance_bands band
         WHERE band.rate_card_version_id = $1 AND band.item_code IS NOT NULL
        UNION
        SELECT component.item_code FROM mbt_rate_components component
         WHERE component.rate_card_version_id = $1 AND component.item_code IS NOT NULL
        UNION
        SELECT tariff.item_code FROM mbt_dump_tariffs tariff
         WHERE tariff.rate_card_version_id = $1 AND tariff.item_code IS NOT NULL
      )`,
    [rateCardVersionId]
  );
  const mbbsPolicy = await query(
    `SELECT EXISTS (
              SELECT 1 FROM mbt_rate_distance_bands band
               WHERE band.rate_card_version_id = $1
                 AND band.item_code = 'DELIVERY_CHARGE_MBBS'
                 AND band.service_code = 'mbbs_cross_charge'
            ) AS has_mbbs_bands,
            EXISTS (
              SELECT 1 FROM mbt_mbbs_rate_card_policies policy
               WHERE policy.rate_card_version_id = $1
            ) AS has_mbbs_policy`,
    [rateCardVersionId]
  );
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  for (const row of rows.rows) {
    const key = `${row.item_code || ""}\u0000${row.service_code}\u0000${row.bin_type_id || ""}\u0000${(row.origin_yard_codes || []).join("|")}`;
    const band = {
      minimumMetres: row.minimum_metres,
      maximumMetres: row.maximum_metres,
      boundaryRule: row.boundary_rule
    };
    groups.set(key, [...(groups.get(key) || []), band]);
  }
  let valid = (rows.rowCount + components.rowCount + tariffs.rowCount) > 0
    && [...groups.values()].every((bands) => validateRateBands(bands).valid);
  const componentKinds = new Map();
  for (const row of components.rows) {
    const kinds = componentKinds.get(row.item_code) || new Set();
    kinds.add(row.component_kind);
    componentKinds.set(row.item_code, kinds);
  }
  const tariffItems = new Set(tariffs.rows.map((/** @type {Record<string, any>} */ row) => row.item_code));
  for (const item of itemTypes.rows) {
    if (item.item_type === "bin") {
      const kinds = componentKinds.get(item.item_code) || new Set();
      valid &&= kinds.has("rental") && kinds.has("extension");
    } else if (["dump", "aggregate"].includes(item.item_type)) {
      valid &&= tariffItems.has(item.item_code);
    } else if (item.item_type === "delivery_fee") {
      valid &&= [...groups.keys()].some((key) => key.startsWith(`${item.item_code}\u0000`));
    }
  }
  if (mbbsPolicy.rows[0]?.has_mbbs_bands === true) {
    valid &&= mbbsPolicy.rows[0]?.has_mbbs_policy === true;
  }
  return {
    valid,
    issues: valid ? [] : [{
      code: "MBT_RATE_CARD_INVALID",
      message: "The multi-item rate card has incomplete or invalid item pricing."
    }]
  };
}

/** @param {string} rateCardVersionId @param {number} revision @param {Record<string, any>} validation @param {MbtActor} actor */
async function storeValidation(rateCardVersionId, revision, validation, actor) {
  const result = await query(
    `UPDATE mbt_rate_card_versions
        SET validation_snapshot = $3::jsonb,
            revision = revision + 1,
            updated_by = $4,
            updated_at = now()
      WHERE rate_card_version_id = $1 AND revision = $2 AND status = 'draft'
      RETURNING revision::int`,
    [rateCardVersionId, revision, JSON.stringify(validation), actor.operatorId]
  );
  if (!result.rowCount) {
    throw new MbtError({ status: 409, code: "MBT_STALE_REVISION", message: "Rate-card validation lost an optimistic race." });
  }
  return Number(result.rows[0].revision);
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.rateCardVersionId
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function validateLocalRateCardVersion(input) {
  const revision = expectedRevision(input.expectedRevision);
  const reason = auditReason(input.reason);
  await assertMasterDataCommand(input.actor);
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.validate",
    idempotencyKey: input.idempotencyKey,
    payload: { rateCardVersionId: input.rateCardVersionId, expectedRevision: revision, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const before = await lockedVersion(input.rateCardVersionId);
      assertRevision(Number(before.revision), revision);
      if (before.status !== "draft" || before.first_used_at) {
        return fail("MBT_RATE_CARD_INPUT_INVALID", "Only an unused draft rate-card version can be validated.");
      }
      const validation = await storedBandValidation(input.rateCardVersionId);
      if (!validation.valid) {
        return fail("MBT_RATE_CARD_INVALID", "The rate-card version did not pass validation.");
      }
      const nextRevision = await storeValidation(
        input.rateCardVersionId,
        revision,
        { ...validation, validatedAt: new Date().toISOString() },
        input.actor
      );
      const version = await publicVersion(input.rateCardVersionId);
      return {
        status: 200,
        body: { schemaVersion: "mbt-rate-card-v1", version },
        audit: {
          action: "mbt.rate_card.validated",
          entityType: "mbt_rate_card_version",
          entityId: input.rateCardVersionId,
          beforeState: { status: before.status, revision },
          afterState: { version },
          reason,
          revisionBefore: revision,
          revisionAfter: nextRevision,
          source: "local"
        }
      };
    }
  });
}

/**
 * @param {Record<string, any>} before
 * @param {number} revision
 * @param {MbtActor} actor
 * @param {string | null} replacesRateCardVersionId
 */
async function activateVersion(before, revision, actor, replacesRateCardVersionId) {
  if (before.status !== "draft" || before.first_used_at || before.validation_snapshot?.valid !== true) {
    return fail("MBT_RATE_CARD_INVALID", "Only a validated, unused draft rate-card version can be activated.");
  }
  await query("SELECT rate_card_id FROM mbt_rate_cards WHERE rate_card_id = $1 FOR UPDATE", [before.rate_card_id]);
  const active = await query(
    `SELECT rate_card_version_id::text
       FROM mbt_rate_card_versions
      WHERE rate_card_id = $1 AND status = 'active' AND rate_card_version_id <> $2
      FOR UPDATE`,
    [before.rate_card_id, before.rate_card_version_id]
  );
  const activeVersionId = active.rowCount
    ? String(active.rows[0].rate_card_version_id)
    : null;
  if (activeVersionId !== replacesRateCardVersionId) {
    throw new MbtError({
      status: 409,
      code: "MBT_RATE_ACTIVE_CONFLICT",
      message: "The active rate-card version changed. Refresh before activating this version."
    });
  }
  const cutover = await query("SELECT transaction_timestamp() AS cutover_at");
  const cutoverAt = cutover.rows[0].cutover_at;
  if (activeVersionId) {
    const retired = await query(
      `UPDATE mbt_rate_card_versions
          SET status = 'retired',
              effective_to = CASE
                WHEN effective_from IS NULL OR effective_from >= $2 THEN effective_to
                WHEN effective_to IS NULL OR effective_to > $2 THEN $2
                ELSE effective_to
              END,
              retired_at = $2,
              revision = revision + 1,
              updated_by = $3,
              updated_at = $2
        WHERE rate_card_version_id = $1 AND status = 'active'
        RETURNING revision::int`,
      [activeVersionId, cutoverAt, actor.operatorId]
    );
    if (!retired.rowCount) {
      throw new MbtError({
        status: 409,
        code: "MBT_RATE_ACTIVE_CONFLICT",
        message: "The active rate-card version changed. Refresh before activating this version."
      });
    }
  }
  await query(
    `UPDATE mbt_rate_cards
        SET active = true,
            revision = revision + 1,
            updated_by = $2,
            updated_at = $3
      WHERE rate_card_id = $1 AND active = false`,
    [before.rate_card_id, actor.operatorId, cutoverAt]
  );
  const updated = await query(
    `UPDATE mbt_rate_card_versions
        SET status = 'active', activated_at = $4, revision = revision + 1,
            updated_by = $3, updated_at = $4
      WHERE rate_card_version_id = $1 AND revision = $2 AND status = 'draft'
      RETURNING revision::int`,
    [before.rate_card_version_id, revision, actor.operatorId, cutoverAt]
  );
  if (!updated.rowCount) {
    throw new MbtError({ status: 409, code: "MBT_STALE_REVISION", message: "Rate-card activation lost an optimistic race." });
  }
  return {
    revision: Number(updated.rows[0].revision),
    replacedRateCardVersionId: activeVersionId
  };
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.rateCardVersionId
 * @param {unknown} [input.replacesRateCardVersionId]
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function activateLocalRateCardVersion(input) {
  const rateCardVersionId = normalizeRateCardVersionId(input.rateCardVersionId);
  const replacesRateCardVersionId = optionalRateCardVersionId(input.replacesRateCardVersionId);
  if (rateCardVersionId === replacesRateCardVersionId) {
    return invalidInput("A rate-card version cannot replace itself.");
  }
  const revision = expectedRevision(input.expectedRevision);
  const reason = auditReason(input.reason);
  await assertMasterDataCommand(input.actor);
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.activate",
    idempotencyKey: input.idempotencyKey,
    payload: { rateCardVersionId, replacesRateCardVersionId, expectedRevision: revision, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const before = await lockedVersion(rateCardVersionId);
      assertRevision(Number(before.revision), revision);
      const activated = await activateVersion(
        before,
        revision,
        input.actor,
        replacesRateCardVersionId
      );
      const version = await publicVersion(rateCardVersionId);
      return {
        status: 200,
        body: {
          schemaVersion: "mbt-rate-card-v1",
          version,
          replacedRateCardVersionId: activated.replacedRateCardVersionId
        },
        audit: {
          action: "mbt.rate_card.activated",
          entityType: "mbt_rate_card_version",
          entityId: rateCardVersionId,
          beforeState: {
            status: before.status,
            revision,
            replacesRateCardVersionId
          },
          afterState: {
            version,
            replacedRateCardVersionId: activated.replacedRateCardVersionId
          },
          reason,
          revisionBefore: revision,
          revisionAfter: activated.revision,
          source: "local"
        }
      };
    }
  });
}

/** @param {Record<string, any>} source @param {string} cloneId @param {number} versionNumber @param {MbtActor} actor */
async function insertCloneVersion(source, cloneId, versionNumber, actor) {
  await query(
    `INSERT INTO mbt_rate_card_versions (
       rate_card_version_id, rate_card_id, version_number, status,
       effective_from, effective_to, default_rental_calendar_days,
       calculation_notes, validation_snapshot, revision, created_by, updated_by
     ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7, '{}'::jsonb, 1, $8, $8)`,
    [
      cloneId, source.rate_card_id, versionNumber, source.effective_from,
      source.effective_to, source.default_rental_calendar_days,
      source.calculation_notes, actor.operatorId
    ]
  );
}

/** @param {string} sourceId @param {string} cloneId @param {MbtActor} actor */
async function cloneChildren(sourceId, cloneId, actor) {
  await query(
    `INSERT INTO mbt_mbbs_rate_card_policies (
       rate_card_version_id, schema_version, currency,
       direct_pickup_unit_amount_minor, po_additional_drop_unit_amount_minor,
       so_charge_basis, to_replenishment_charge_basis,
       to_direct_pickup_charge_basis, po_charge_basis,
       po_additional_drop_basis, dispatch_load_split_basis,
       revision, created_by, updated_by
     )
     SELECT $2, schema_version, currency,
            direct_pickup_unit_amount_minor, po_additional_drop_unit_amount_minor,
            so_charge_basis, to_replenishment_charge_basis,
            to_direct_pickup_charge_basis, po_charge_basis,
            po_additional_drop_basis, dispatch_load_split_basis,
            1, $3, $3
       FROM mbt_mbbs_rate_card_policies
      WHERE rate_card_version_id = $1`,
    [sourceId, cloneId, actor.operatorId]
  );
  const tables = [
    {
      table: "mbt_rate_distance_bands",
      id: "rate_distance_band_id",
      columns: "item_code, service_code, bin_type_id, sequence_number, minimum_metres, maximum_metres, amount_minor, pricing_basis, boundary_rule, origin_yard_codes, currency, downtown_surcharge_minor, description"
    },
    {
      table: "mbt_rate_components",
      id: "rate_component_id",
      columns: "item_code, component_code, component_kind, service_code, bin_type_id, rate_basis, amount_minor, percentage_basis_points, default_quantity, currency, taxable, active, description"
    },
    {
      table: "mbt_dump_tariffs",
      id: "dump_tariff_id",
      columns: "item_code, dump_site_id, material_id, tariff_code, pricing_basis, unit_of_measure, amount_minor, minimum_amount_minor, currency, active, description"
    },
    {
      table: "mbt_deposit_rules",
      id: "deposit_rule_id",
      columns: "rule_code, rule_type, bin_type_id, service_code, fixed_amount_minor, percentage_basis_points, currency, liability_account_mapping_key, active, description"
    }
  ];
  for (const definition of tables) {
    await query(
      `INSERT INTO ${definition.table} (${definition.id}, rate_card_version_id, ${definition.columns})
       SELECT gen_random_uuid(), $2, ${definition.columns}
         FROM ${definition.table}
        WHERE rate_card_version_id = $1`,
      [sourceId, cloneId]
    );
  }
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {string} input.sourceRateCardVersionId
 * @param {number} input.expectedRevision
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function cloneLocalRateCardVersion(input) {
  const revision = expectedRevision(input.expectedRevision);
  const reason = auditReason(input.reason);
  await assertMasterDataCommand(input.actor);
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.clone",
    idempotencyKey: input.idempotencyKey,
    payload: { sourceRateCardVersionId: input.sourceRateCardVersionId, expectedRevision: revision, reason },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const source = await lockedVersion(input.sourceRateCardVersionId);
      assertRevision(Number(source.revision), revision);
      await query("SELECT rate_card_id FROM mbt_rate_cards WHERE rate_card_id = $1 FOR UPDATE", [source.rate_card_id]);
      const next = await query(
        "SELECT COALESCE(max(version_number), 0)::int + 1 AS version_number FROM mbt_rate_card_versions WHERE rate_card_id = $1",
        [source.rate_card_id]
      );
      const cloneId = crypto.randomUUID();
      await insertCloneVersion(source, cloneId, Number(next.rows[0].version_number), input.actor);
      await cloneChildren(input.sourceRateCardVersionId, cloneId, input.actor);
      const version = await publicVersion(cloneId);
      return {
        status: 201,
        body: { schemaVersion: "mbt-rate-card-v1", version },
        audit: {
          action: "mbt.rate_card.cloned",
          entityType: "mbt_rate_card_version",
          entityId: cloneId,
          beforeState: { sourceRateCardVersionId: input.sourceRateCardVersionId, revision },
          afterState: { version },
          reason,
          revisionBefore: 1,
          revisionAfter: 1,
          source: "local"
        }
      };
    }
  });
}

/** @param {{query?: unknown, status?: unknown, limit?: unknown, cursor?: unknown}} input */
function listFilters(input) {
  const search = String(input.query || "").trim();
  const status = String(input.status || "").trim().toLowerCase();
  if (status && !VERSION_STATUSES.has(status)) {
    return invalidInput("The rate-card status filter is invalid.");
  }
  const limit = input.limit === undefined ? 50 : safeInteger(input.limit, "Rate-card list limit", 1);
  if (limit > 100) {
    return invalidInput("The rate-card list limit cannot exceed 100.");
  }
  const cursor = input.cursor === null || input.cursor === undefined
    ? ""
    : String(input.cursor);
  return { search, status, limit, cursor };
}

/** @param {{query?: unknown, status?: unknown, limit?: unknown, cursor?: unknown}} [input] */
export async function listLocalRateCards(input = {}) {
  const { search, status, limit, cursor } = listFilters(input);
  const [result, yards] = await Promise.all([query(
      `SELECT version.rate_card_version_id::text AS "rateCardVersionId",
            version.rate_card_id::text AS "rateCardId",
            card.rate_card_code AS "rateCardCode", card.display_name AS "displayName",
            card.item_code AS "itemCode", card.active AS "cardActive",
            ARRAY(
              SELECT DISTINCT priced.item_code
                FROM (
                  SELECT band.item_code FROM mbt_rate_distance_bands band
                   WHERE band.rate_card_version_id = version.rate_card_version_id
                  UNION ALL
                  SELECT component.item_code FROM mbt_rate_components component
                   WHERE component.rate_card_version_id = version.rate_card_version_id
                  UNION ALL
                  SELECT tariff.item_code FROM mbt_dump_tariffs tariff
                   WHERE tariff.rate_card_version_id = version.rate_card_version_id
                ) priced
               WHERE priced.item_code IS NOT NULL
               ORDER BY priced.item_code
            ) AS "itemCodes",
            card.revision::int AS "cardRevision",
            card.currency, version.version_number AS "versionNumber",
            version.status, version.revision::int AS revision,
            version.effective_from AS "effectiveFrom",
            version.effective_to AS "effectiveTo",
            (version.status = 'draft' AND version.first_used_at IS NULL) AS editable,
            version.validation_snapshot AS validation
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
      WHERE ($1 = '' OR card.rate_card_code ILIKE '%' || $1 || '%' OR card.display_name ILIKE '%' || $1 || '%')
        AND ($2 = '' OR version.status = $2)
        AND ($3 = '' OR version.rate_card_version_id::text > $3)
      ORDER BY version.rate_card_version_id
      LIMIT $4`,
    [search, status, cursor, limit + 1]
  ), query(
    `SELECT yard_code AS "yardCode", display_name AS "displayName"
       FROM mbt_yards
      WHERE active
      ORDER BY CASE yard_code WHEN '3445' THEN 1 WHEN '2967' THEN 2 WHEN '150' THEN 3 WHEN '12441' THEN 4 ELSE 5 END,
               yard_code`
  )]);
  const items = result.rows.slice(0, limit);
  return {
    schemaVersion: "mbt-rate-cards-v1",
    items,
    yardOptions: yards.rows,
    nextCursor: result.rows.length > limit ? items.at(-1)?.rateCardVersionId || null : null
  };
}

/** @param {unknown} value */
function normalizeRateCardVersionId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw new MbtError({ status: 400, code: "MBT_RATE_CARD_INPUT_INVALID", message: "Rate-card version ID must be a UUID." });
  }
  return id;
}

/** @param {unknown} value */
function optionalRateCardVersionId(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return normalizeRateCardVersionId(value);
}

/**
 * Named detail read model for the business-unit editor. It exposes only local
 * rate configuration, never customer financial history or external mappings.
 *
 * @param {unknown} rawVersionId
 */
export async function getLocalRateCardGraph(rawVersionId) {
  const versionId = normalizeRateCardVersionId(rawVersionId);
  const header = await query(
    `SELECT version.rate_card_version_id::text AS "rateCardVersionId",
            version.rate_card_id::text AS "rateCardId", version.version_number AS "versionNumber",
            version.status, version.revision::int AS revision,
            version.effective_from AS "effectiveFrom", version.effective_to AS "effectiveTo",
            (version.status = 'draft' AND version.first_used_at IS NULL) AS editable,
            version.default_rental_calendar_days AS "defaultRentalCalendarDays",
            version.calculation_notes AS "calculationNotes",
            card.rate_card_code AS "rateCardCode", card.display_name AS "displayName",
            card.item_code AS "itemCode", card.active AS "cardActive",
            card.revision::int AS "cardRevision",
            card.description, card.customer_netsuite_id AS "customerNetSuiteId",
            card.subsidiary_netsuite_id AS "subsidiaryNetSuiteId", card.currency,
            policy.schema_version AS "policySchemaVersion",
            policy.currency AS "policyCurrency",
            policy.direct_pickup_unit_amount_minor AS "directPickupUnitAmountMinor",
            policy.po_additional_drop_unit_amount_minor AS "poAdditionalDropUnitAmountMinor",
            policy.so_charge_basis AS "soChargeBasis",
            policy.to_replenishment_charge_basis AS "toReplenishmentChargeBasis",
            policy.to_direct_pickup_charge_basis AS "toDirectPickupChargeBasis",
            policy.po_charge_basis AS "poChargeBasis",
            policy.po_additional_drop_basis AS "poAdditionalDropBasis",
            policy.dispatch_load_split_basis AS "dispatchLoadSplitBasis"
       FROM mbt_rate_card_versions version
       JOIN mbt_rate_cards card USING (rate_card_id)
       LEFT JOIN mbt_mbbs_rate_card_policies policy USING (rate_card_version_id)
      WHERE version.rate_card_version_id = $1`,
    [versionId]
  );
  if (!header.rowCount) {
    throw new MbtError({ status: 404, code: "MBT_RATE_CARD_NOT_FOUND", message: "Rate-card version not found." });
  }
  // Transaction-scoped reads share one pg client. Keep them sequential so pg
  // never receives overlapping client.query calls (which pg 9 will reject).
  const bands = await query(
      `SELECT band.item_code AS "itemCode", band.service_code AS "serviceCode", bin.type_code AS "binTypeCode",
              band.sequence_number AS "sequenceNumber", band.minimum_metres AS "minimumMetres",
              band.maximum_metres AS "maximumMetres", band.amount_minor AS "amountMinor",
              band.pricing_basis AS "pricingBasis", band.boundary_rule AS "boundaryRule",
              band.origin_yard_codes AS "originYardCodes",
              band.downtown_surcharge_minor AS "downtownSurchargeMinor", band.currency, band.description
         FROM mbt_rate_distance_bands band
         LEFT JOIN mbt_bin_types bin ON bin.bin_type_id = band.bin_type_id
        WHERE band.rate_card_version_id = $1
        ORDER BY band.item_code NULLS FIRST, band.service_code, bin.type_code NULLS FIRST, band.sequence_number`, [versionId]
  );
  const components = await query(
      `SELECT component.item_code AS "itemCode", component.component_code AS "componentCode", component.component_kind AS "componentKind",
              component.service_code AS "serviceCode", bin.type_code AS "binTypeCode",
              component.rate_basis AS "rateBasis", component.amount_minor AS "amountMinor",
              component.percentage_basis_points AS "percentageBasisPoints",
              component.default_quantity::text AS "defaultQuantity", component.currency,
              component.taxable, component.active, component.description
         FROM mbt_rate_components component
         LEFT JOIN mbt_bin_types bin ON bin.bin_type_id = component.bin_type_id
        WHERE component.rate_card_version_id = $1
        ORDER BY component.component_code`, [versionId]
  );
  const tariffs = await query(
      `SELECT tariff.item_code AS "itemCode", site.dump_site_code AS "dumpSiteCode",
              material.material_code AS "materialCode",
              tariff.tariff_code AS "tariffCode", tariff.pricing_basis AS "pricingBasis",
              tariff.unit_of_measure AS "unitOfMeasure", tariff.amount_minor AS "amountMinor",
              tariff.minimum_amount_minor AS "minimumAmountMinor", tariff.currency, tariff.active, tariff.description
         FROM mbt_dump_tariffs tariff
         LEFT JOIN mbt_dump_sites site ON site.dump_site_id = tariff.dump_site_id
         LEFT JOIN mbt_materials material ON material.material_id = tariff.material_id
        WHERE tariff.rate_card_version_id = $1
        ORDER BY tariff.item_code NULLS FIRST, material.material_code NULLS FIRST, tariff.tariff_code`, [versionId]
  );
  return {
    schemaVersion: "mbt-rate-card-detail-v1",
    version: header.rows[0],
    graph: {
      rateCard: {
        rateCardCode: String(header.rows[0].rateCardCode), displayName: String(header.rows[0].displayName),
        itemCode: header.rows[0].itemCode === null ? null : String(header.rows[0].itemCode),
        description: String(header.rows[0].description || ""),
        customerNetSuiteId: header.rows[0].customerNetSuiteId === null ? null : Number(header.rows[0].customerNetSuiteId),
        subsidiaryNetSuiteId: header.rows[0].subsidiaryNetSuiteId === null ? null : Number(header.rows[0].subsidiaryNetSuiteId),
        serviceTemplateCode: null, currency: String(header.rows[0].currency), active: header.rows[0].cardActive === true
      },
      version: {
        versionNumber: Number(header.rows[0].versionNumber), effectiveFrom: new Date(header.rows[0].effectiveFrom).toISOString(),
        effectiveTo: header.rows[0].effectiveTo === null ? null : new Date(header.rows[0].effectiveTo).toISOString(),
        defaultRentalCalendarDays: Number(header.rows[0].defaultRentalCalendarDays),
        calculationNotes: String(header.rows[0].calculationNotes || "")
      },
      distanceBands: (/** @type {Array<Record<string, any>>} */ (bands.rows)).map((row) => ({
        ...row,
        sequenceNumber: Number(row.sequenceNumber),
        minimumMetres: Number(row.minimumMetres),
        maximumMetres: row.maximumMetres === null ? null : Number(row.maximumMetres),
        amountMinor: Number(row.amountMinor),
        downtownSurchargeMinor: Number(row.downtownSurchargeMinor),
        originYardCodes: Array.isArray(row.originYardCodes) ? row.originYardCodes.map(String) : []
      })),
      components: (/** @type {Array<Record<string, any>>} */ (components.rows)).map((row) => ({ ...row, amountMinor: row.amountMinor === null ? null : Number(row.amountMinor), percentageBasisPoints: row.percentageBasisPoints === null ? null : Number(row.percentageBasisPoints), defaultQuantity: Number(row.defaultQuantity) })),
      dumpTariffs: (/** @type {Array<Record<string, any>>} */ (tariffs.rows)).map((row) => ({ ...row, amountMinor: Number(row.amountMinor), minimumAmountMinor: Number(row.minimumAmountMinor) })),
      depositRules: [],
      mbbsChargingPolicy: header.rows[0].policySchemaVersion === null
        ? null
        : normalizeMbbsRateCardPolicy({
            schemaVersion: Number(header.rows[0].policySchemaVersion),
            currency: String(header.rows[0].policyCurrency),
            directPickupUnitAmountMinor: Number(header.rows[0].directPickupUnitAmountMinor),
            poAdditionalDropUnitAmountMinor: Number(header.rows[0].poAdditionalDropUnitAmountMinor),
            soChargeBasis: String(header.rows[0].soChargeBasis),
            toReplenishmentChargeBasis: String(header.rows[0].toReplenishmentChargeBasis),
            toDirectPickupChargeBasis: String(header.rows[0].toDirectPickupChargeBasis),
            poChargeBasis: String(header.rows[0].poChargeBasis),
            poAdditionalDropBasis: String(header.rows[0].poAdditionalDropBasis),
            dispatchLoadSplitBasis: String(header.rows[0].dispatchLoadSplitBasis)
          })
    }
  };
}

/** @param {unknown} error @returns {never} */
function rateCardInUse(error) {
  if (error instanceof MbtError) {
    throw error;
  }
  const code = String(error && typeof error === "object" && "code" in error ? error.code : "");
  if (["23503", "23514", "55000"].includes(code)) {
    throw new MbtError({
      status: 409,
      code: "MBT_ENTITY_IN_USE",
      message: "This rate card is linked to pricing evidence or operational history. Make it inactive instead of deleting it."
    });
  }
  throw error;
}

/**
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {unknown} input.rateCardVersionId
 * @param {unknown} input.active
 * @param {unknown} input.expectedRevision
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function setLocalRateCardActive(input) {
  const versionId = normalizeRateCardVersionId(input.rateCardVersionId);
  const revision = expectedRevision(input.expectedRevision);
  if (typeof input.active !== "boolean") {
    return invalidInput("A rate-card active state is required.");
  }
  await assertMasterDataCommand(input.actor);
  const reason = `${input.active ? "Activated" : "Inactivated"} rate card from MBT configuration`;
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.state",
    idempotencyKey: input.idempotencyKey,
    payload: { rateCardVersionId: versionId, active: input.active, expectedRevision: revision },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      const selected = await query(
        `SELECT card.*
           FROM mbt_rate_card_versions version
           JOIN mbt_rate_cards card USING (rate_card_id)
          WHERE version.rate_card_version_id = $1
          FOR UPDATE OF card`,
        [versionId]
      );
      if (!selected.rowCount) {
        throw new MbtError({ status: 404, code: "MBT_RATE_CARD_NOT_FOUND", message: "Rate card not found." });
      }
      const before = selected.rows[0];
      assertRevision(Number(before.revision), revision);
      await query(
        `UPDATE mbt_rate_cards
            SET active = $2, revision = revision + 1,
                updated_by = $3, updated_at = now()
          WHERE rate_card_id = $1`,
        [before.rate_card_id, input.active, input.actor.operatorId]
      );
      const version = await publicVersion(versionId);
      return {
        status: 200,
        body: { schemaVersion: "mbt-rate-card-v1", version },
        audit: {
          action: `mbt.rate_card.${input.active ? "activated" : "inactivated"}`,
          entityType: "mbt_rate_card",
          entityId: String(before.rate_card_id),
          beforeState: { active: before.active === true, revision },
          afterState: { active: input.active, revision: revision + 1 },
          reason,
          revisionBefore: revision,
          revisionAfter: revision + 1,
          source: "local"
        }
      };
    }
  });
}

/**
 * Delete an entire card/version graph only while no quote, contract, billing,
 * distance snapshot, tariff consumer, or other historical row references it.
 *
 * @param {object} input
 * @param {MbtActor} input.actor
 * @param {unknown} input.rateCardVersionId
 * @param {unknown} input.expectedRevision
 * @param {string} input.idempotencyKey
 * @param {string} input.correlationId
 * @param {string} input.requestId
 */
export async function deleteLocalRateCard(input) {
  const versionId = normalizeRateCardVersionId(input.rateCardVersionId);
  const revision = expectedRevision(input.expectedRevision);
  await assertMasterDataCommand(input.actor);
  const reason = "Deleted unused rate card from MBT configuration";
  return executeMbtCommand({
    actor: input.actor,
    commandName: "mbt.rate_card.delete",
    idempotencyKey: input.idempotencyKey,
    payload: { rateCardVersionId: versionId, expectedRevision: revision },
    correlationId: input.correlationId,
    requestId: input.requestId,
    mutation: async () => {
      try {
        const selected = await query(
          `SELECT card.*
             FROM mbt_rate_card_versions version
             JOIN mbt_rate_cards card USING (rate_card_id)
            WHERE version.rate_card_version_id = $1
            FOR UPDATE OF card`,
          [versionId]
        );
        if (!selected.rowCount) {
          throw new MbtError({ status: 404, code: "MBT_RATE_CARD_NOT_FOUND", message: "Rate card not found." });
        }
        const card = selected.rows[0];
        assertRevision(Number(card.revision), revision);
        const versions = await query(
          `SELECT rate_card_version_id::text, first_used_at
             FROM mbt_rate_card_versions
            WHERE rate_card_id = $1
            ORDER BY version_number
            FOR UPDATE`,
          [card.rate_card_id]
        );
        if (versions.rows.some((/** @type {Record<string, any>} */ row) => row.first_used_at !== null)) {
          throw new MbtError({
            status: 409,
            code: "MBT_ENTITY_IN_USE",
            message: "This rate card has already been used. Make it inactive to preserve its pricing history."
          });
        }
        const versionIds = versions.rows.map(
          (/** @type {Record<string, any>} */ row) => String(row.rate_card_version_id)
        );
        await query(
          "DELETE FROM mbt_mbbs_rate_card_policies WHERE rate_card_version_id = ANY($1::uuid[])",
          [versionIds]
        );
        for (const table of [
          "mbt_deposit_rules", "mbt_dump_tariffs", "mbt_rate_components", "mbt_rate_distance_bands"
        ]) {
          await query(`DELETE FROM ${table} WHERE rate_card_version_id = ANY($1::uuid[])`, [versionIds]);
        }
        await query("DELETE FROM mbt_rate_card_versions WHERE rate_card_id = $1", [card.rate_card_id]);
        await query("DELETE FROM mbt_rate_cards WHERE rate_card_id = $1", [card.rate_card_id]);
        return {
          status: 200,
          body: { rateCardId: String(card.rate_card_id), deleted: true },
          audit: {
            action: "mbt.rate_card.deleted",
            entityType: "mbt_rate_card",
            entityId: String(card.rate_card_id),
            beforeState: {
              rateCardCode: String(card.rate_card_code),
              itemCode: card.item_code === null ? null : String(card.item_code),
              active: card.active === true,
              revision
            },
            afterState: { exists: false },
            reason,
            revisionBefore: revision,
            revisionAfter: revision,
            source: "local"
          }
        };
      } catch (error) {
        return rateCardInUse(error);
      }
    }
  });
}

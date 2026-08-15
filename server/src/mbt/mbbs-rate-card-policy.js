// @ts-check

import { MbtError } from "./errors.js";

export const MBBS_RATE_CARD_POLICY_SCHEMA_VERSION = 1;

export const MBBS_RATE_CARD_POLICY_RULES = Object.freeze({
  soChargeBasis: "per_order_group_as_one",
  toReplenishmentChargeBasis: "full_route_once",
  toDirectPickupChargeBasis: "fixed_unit_once",
  poChargeBasis: "shared_leg_equal_split",
  poAdditionalDropBasis: "each_distinct_drop_after_first",
  dispatchLoadSplitBasis: "ignored_for_charge"
});

export const DEFAULT_MBBS_RATE_CARD_POLICY = Object.freeze({
  schemaVersion: MBBS_RATE_CARD_POLICY_SCHEMA_VERSION,
  currency: "CAD",
  directPickupUnitAmountMinor: 10_000,
  poAdditionalDropUnitAmountMinor: 10_000,
  ...MBBS_RATE_CARD_POLICY_RULES
});

const POLICY_FIELDS = new Set(Object.keys(DEFAULT_MBBS_RATE_CARD_POLICY));

/** @param {string} message @param {string} [code] @returns {never} */
function invalid(message, code = "MBT_RATE_CARD_POLICY_INVALID") {
  throw new MbtError({ status: 422, code, message });
}

/** @param {unknown} value @param {string} label */
function exactCadMinor(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${label} must be a non-negative safe integer number of CAD cents.`);
  }
  return value;
}

/**
 * Normalize the complete, allowlisted policy contract. Rule identifiers are
 * deliberately fixed in schema version 1; only the two exact CAD unit prices
 * are editable. A future rule change requires a new schema version instead of
 * silently changing the meaning of old billing evidence.
 *
 * @param {unknown} value
 */
export function normalizeMbbsRateCardPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("An MBBS charging policy object is required.");
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(input).some((field) => !POLICY_FIELDS.has(field))) {
    return invalid("The MBBS charging policy contains an unsupported field.");
  }
  if (input.schemaVersion !== MBBS_RATE_CARD_POLICY_SCHEMA_VERSION) {
    return invalid(`MBBS charging policy schema version ${MBBS_RATE_CARD_POLICY_SCHEMA_VERSION} is required.`);
  }
  if (input.currency !== "CAD") {
    return invalid("The MBBS charging policy currency must be CAD.");
  }
  for (const [field, expected] of Object.entries(MBBS_RATE_CARD_POLICY_RULES)) {
    if (input[field] !== expected) {
      return invalid(`The MBBS charging policy rule ${field} must be ${expected}.`);
    }
  }
  return {
    schemaVersion: MBBS_RATE_CARD_POLICY_SCHEMA_VERSION,
    currency: "CAD",
    directPickupUnitAmountMinor: exactCadMinor(
      input.directPickupUnitAmountMinor,
      "Direct-pickup TO unit price"
    ),
    poAdditionalDropUnitAmountMinor: exactCadMinor(
      input.poAdditionalDropUnitAmountMinor,
      "PO additional-drop unit price"
    ),
    ...MBBS_RATE_CARD_POLICY_RULES
  };
}

/** @param {unknown} value */
export function requireMbbsRateCardPolicy(value) {
  if (value === null || value === undefined) {
    return invalid(
      "The selected MBBS rate-card version has no charging policy.",
      "MBT_RATE_CARD_POLICY_REQUIRED"
    );
  }
  return normalizeMbbsRateCardPolicy(value);
}

/** @param {unknown} value */
export function isMbbsCrossChargeGraph(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const bands = /** @type {Record<string, unknown>} */ (value).distanceBands;
  return Array.isArray(bands) && bands.some((band) => (
    band && typeof band === "object" && !Array.isArray(band)
      && /** @type {Record<string, unknown>} */ (band).itemCode === "DELIVERY_CHARGE_MBBS"
      && /** @type {Record<string, unknown>} */ (band).serviceCode === "mbbs_cross_charge"
  ));
}

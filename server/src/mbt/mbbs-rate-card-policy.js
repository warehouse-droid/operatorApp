// @ts-check

import { MbtError } from "./errors.js";
import { MBBS_VENDOR_ROUTE_RATE_POLICY_RULES } from "./mbbs-vendor-route-rates.js";

export const MBBS_RATE_CARD_POLICY_SCHEMA_VERSION = 1;
export const MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V2 = 2;
export const MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V3 = 3;

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

export const MBBS_RATE_CARD_POLICY_RULES_V2 = Object.freeze({
  soChargeBasis: "per_order_group_as_one",
  toReplenishmentChargeBasis: "full_route_once",
  toDirectPickupChargeBasis: "fixed_unit_once",
  poChargeBasis: "shared_leg_equal_split",
  dispatchLoadSplitBasis: "ignored_for_charge",
  ...MBBS_VENDOR_ROUTE_RATE_POLICY_RULES
});

export const DEFAULT_MBBS_RATE_CARD_POLICY_V2 = Object.freeze({
  schemaVersion: MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V2,
  currency: "CAD",
  directPickupUnitAmountMinor: 10_000,
  poVrmaAdditionalStopUnitAmountMinor: 10_000,
  ...MBBS_RATE_CARD_POLICY_RULES_V2
});

export const MBBS_RATE_CARD_POLICY_RULES_V3 = Object.freeze({
  ...MBBS_RATE_CARD_POLICY_RULES_V2,
  toReplenishmentMultiDropBasis: "longest_origin_drop_plus_each_distinct_drop_after_first"
});

export const DEFAULT_MBBS_RATE_CARD_POLICY_V3 = Object.freeze({
  schemaVersion: MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V3,
  currency: "CAD",
  directPickupUnitAmountMinor: 10_000,
  poVrmaAdditionalStopUnitAmountMinor: 10_000,
  toReplenishmentAdditionalDropUnitAmountMinor: 10_000,
  ...MBBS_RATE_CARD_POLICY_RULES_V3
});

const POLICY_FIELDS_V1 = new Set(Object.keys(DEFAULT_MBBS_RATE_CARD_POLICY));
const POLICY_FIELDS_V2 = new Set(Object.keys(DEFAULT_MBBS_RATE_CARD_POLICY_V2));
const POLICY_FIELDS_V3 = new Set(Object.keys(DEFAULT_MBBS_RATE_CARD_POLICY_V3));

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
// eslint-disable-next-line complexity -- Schema versions are deliberately validated as one closed policy contract.
export function normalizeMbbsRateCardPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("An MBBS charging policy object is required.");
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  const schemaVersion = Number(input.schemaVersion);
  const fields = schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION
    ? POLICY_FIELDS_V1
    : schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V2
      ? POLICY_FIELDS_V2
      : schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V3
        ? POLICY_FIELDS_V3
      : null;
  if (!fields) {
    return invalid("MBBS charging policy schema version 1, 2, or 3 is required.");
  }
  if (Object.keys(input).some((field) => !fields.has(field))) {
    return invalid("The MBBS charging policy contains an unsupported field.");
  }
  if (input.currency !== "CAD") {
    return invalid("The MBBS charging policy currency must be CAD.");
  }
  const rules = schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION
    ? MBBS_RATE_CARD_POLICY_RULES
    : schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V2
      ? MBBS_RATE_CARD_POLICY_RULES_V2
      : MBBS_RATE_CARD_POLICY_RULES_V3;
  for (const [field, expected] of Object.entries(rules)) {
    if (input[field] !== expected) {
      return invalid(`The MBBS charging policy rule ${field} must be ${expected}.`);
    }
  }
  if (schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V3) {
    return {
      schemaVersion: MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V3,
      currency: "CAD",
      directPickupUnitAmountMinor: exactCadMinor(
        input.directPickupUnitAmountMinor,
        "Direct-pickup TO unit price"
      ),
      poVrmaAdditionalStopUnitAmountMinor: exactCadMinor(
        input.poVrmaAdditionalStopUnitAmountMinor,
        "PO/VRMA additional-stop unit price"
      ),
      toReplenishmentAdditionalDropUnitAmountMinor: exactCadMinor(
        input.toReplenishmentAdditionalDropUnitAmountMinor,
        "Replenishment TO additional-drop unit price"
      ),
      ...MBBS_RATE_CARD_POLICY_RULES_V3
    };
  }
  if (schemaVersion === MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V2) {
    return {
      schemaVersion: MBBS_RATE_CARD_POLICY_SCHEMA_VERSION_V2,
      currency: "CAD",
      directPickupUnitAmountMinor: exactCadMinor(
        input.directPickupUnitAmountMinor,
        "Direct-pickup TO unit price"
      ),
      poVrmaAdditionalStopUnitAmountMinor: exactCadMinor(
        input.poVrmaAdditionalStopUnitAmountMinor,
        "PO/VRMA additional-stop unit price"
      ),
      ...MBBS_RATE_CARD_POLICY_RULES_V2
    };
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

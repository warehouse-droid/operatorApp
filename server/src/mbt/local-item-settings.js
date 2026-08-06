// @ts-check

import { MbtError } from "./errors.js";

/**
 * Local item identity is deliberately code-owned. The database stores the
 * editable presentation fields and a copy of this identity for durable
 * evidence, but neither the HTTP API nor repository may redefine it.
 */
const POLICIES = [
  {
    itemCode: "DELIVERY_CROSS_CHARGE",
    itemType: "delivery_fee",
    category: "cross_charge",
    priceMode: "rate_card",
    applicableSourceTypes: ["SO", "TO", "PO", "VRMA"],
    binTypeCode: null,
    netSuiteMappingLocalKey: "delivery_charge"
  },
  {
    itemCode: "14YD",
    itemType: "bin",
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: "14YD",
    netSuiteMappingLocalKey: "bin_14yd"
  },
  {
    itemCode: "20YD",
    itemType: "bin",
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: "20YD",
    netSuiteMappingLocalKey: "bin_20yd"
  },
  {
    itemCode: "40YD",
    itemType: "bin",
    category: "bin_charge",
    priceMode: "rental_item",
    applicableSourceTypes: [],
    binTypeCode: "40YD",
    netSuiteMappingLocalKey: "bin_40yd"
  },
  {
    itemCode: "DUMP",
    itemType: "dump",
    category: "dump",
    priceMode: "rate_card",
    applicableSourceTypes: [],
    binTypeCode: null,
    netSuiteMappingLocalKey: null
  }
];

for (const policy of POLICIES) {
  Object.freeze(policy.applicableSourceTypes);
  Object.freeze(policy);
}

export const MBT_LOCAL_ITEM_POLICIES = Object.freeze(POLICIES);

const EDITABLE_FIELDS = Object.freeze(["displayName", "description", "active"]);

/** @returns {never} */
function invalidLocalItemInput() {
  throw new MbtError({
    status: 400,
    code: "MBT_LOCAL_ITEM_INPUT_INVALID",
    message: "Local item settings may update only the display name, description, and active status."
  });
}

/** @param {unknown} value @param {number} maximum @param {boolean} allowBlank */
function boundedText(value, maximum, allowBlank) {
  if (typeof value !== "string") {
    return invalidLocalItemInput();
  }
  const normalized = value.trim();
  if ((!allowBlank && !normalized) || normalized.length > maximum) {
    return invalidLocalItemInput();
  }
  return normalized;
}

/** @param {unknown} policy */
function recognizedItemPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return false;
  }
  return /^[A-Z0-9][A-Z0-9_]{0,63}$/u.test(String(/** @type {any} */ (policy).itemCode || ""));
}

/**
 * @param {unknown} raw
 * @param {unknown} policy
 * @returns {{displayName: string, description: string, active: boolean}}
 */
export function normalizeMbtLocalItemUpdate(raw, policy) {
  const recognizedPolicy = recognizedItemPolicy(policy);
  if (!recognizedPolicy || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidLocalItemInput();
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const keys = Object.keys(input).sort();
  if (keys.length !== EDITABLE_FIELDS.length
      || !EDITABLE_FIELDS.every((field) => Object.hasOwn(input, field))) {
    return invalidLocalItemInput();
  }
  if (input.active !== true && input.active !== false) {
    return invalidLocalItemInput();
  }
  return {
    displayName: boundedText(input.displayName, 160, false),
    description: boundedText(input.description, 2000, true),
    active: input.active
  };
}

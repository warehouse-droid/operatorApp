// @ts-check

import { MbtError } from "./errors.js";

export const MBBS_VENDOR_ROUTE_RATE_POLICY_RULES = Object.freeze({
  poVrmaBaseChargeBasis: "vendor_yard_pair_then_distance_band",
  vrmaDirectionBasis: "same_pair_reverse",
  poVrmaAdditionalStopBasis: "each_distinct_stop_after_base_pair",
  endpointOverrideBasis: "flat_default_user_may_choose_distance"
});

const PRICING_METHODS = new Set(["vendor_yard_flat", "distance_band"]);

/** @param {string} code @param {string} message @returns {never} */
function invalid(code, message) {
  throw new MbtError({ status: 422, code, message });
}

/** @param {unknown} value */
function normalizedText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
}

/** @param {unknown} value @param {string} label @param {number} [maximum] */
function requiredText(value, label, maximum = 240) {
  const retained = String(value ?? "").trim();
  if (!retained || retained.length > maximum) {
    return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", `${label} is required and must be at most ${maximum} characters.`);
  }
  return retained;
}

/** @param {unknown} value @param {string} label */
function exactMoney(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", `${label} must be a non-negative safe integer number of CAD cents.`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} minimum */
function exactInteger(value, label, minimum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", `${label} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

/** @param {number} left @param {number} right */
function safeProduct(left, right) {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    return invalid("MBT_BILLING_AMOUNT_INVALID", "The MBBS billing amount exceeds the supported CAD range.");
  }
  return product;
}

/** @param {number[]} amounts */
function safeSum(amounts) {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (!Number.isSafeInteger(total)) {
      return invalid("MBT_BILLING_AMOUNT_INVALID", "The MBBS billing amount exceeds the supported CAD range.");
    }
  }
  return total;
}

/** @param {unknown} value */
export function normalizeMbbsVendorRouteRates(value) {
  if (!Array.isArray(value) || value.length > 2_000) {
    return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", "MBBS vendor-route rates must be a list of at most 2,000 rows.");
  }
  const allowed = new Set([
    "rateName", "displayName", "localVendorId", "localVendorName",
    "vendorYardName", "vendorYardAddress", "destinationYardCode",
    "baseAmountMinor", "currency"
  ]);
  const seen = new Set();
  const normalized = value.map((rawRow) => {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", "Every MBBS vendor-route rate must be an object.");
    }
    const row = /** @type {Record<string, unknown>} */ (rawRow);
    if (Object.keys(row).some((field) => !allowed.has(field))) {
      return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", "An MBBS vendor-route rate contains an unsupported field.");
    }
    if (row.currency !== "CAD") {
      return invalid("MBT_VENDOR_ROUTE_RATE_INVALID", "MBBS vendor-route rate currency must be CAD.");
    }
    const retained = {
      rateName: requiredText(row.rateName, "Rate name"),
      displayName: requiredText(row.displayName, "Rate display name"),
      localVendorId: exactInteger(row.localVendorId, "Local vendor ID", 1),
      localVendorName: requiredText(row.localVendorName, "Local vendor name", 160),
      vendorYardName: requiredText(row.vendorYardName, "Vendor yard name", 240),
      vendorYardAddress: requiredText(row.vendorYardAddress, "Vendor yard address", 500),
      destinationYardCode: requiredText(row.destinationYardCode, "Destination yard code", 64).toUpperCase(),
      baseAmountMinor: exactMoney(row.baseAmountMinor, "Vendor-route base price"),
      currency: "CAD"
    };
    const key = `${retained.localVendorId}|${normalizedText(retained.vendorYardName)}|${retained.destinationYardCode}`;
    if (seen.has(key)) {
      return invalid("MBT_VENDOR_ROUTE_RATE_DUPLICATE", "Only one MBBS rate is allowed for each vendor-yard/destination pair.");
    }
    seen.add(key);
    return retained;
  });
  return normalized.sort((left, right) => (
    left.localVendorName.localeCompare(right.localVendorName)
      || left.vendorYardName.localeCompare(right.vendorYardName)
      || left.destinationYardCode.localeCompare(right.destinationYardCode)
      || left.rateName.localeCompare(right.rateName)
  ));
}

/**
 * Exact identity lookup. Callers may supply exact retained aliases, but no
 * substring, edit-distance, or geocoder-based match is attempted here.
 *
 * @param {unknown} rawRates
 * @param {unknown} rawIdentity
 */
export function selectMbbsVendorRouteRate(rawRates, rawIdentity) {
  const identity = rawIdentity && typeof rawIdentity === "object" && !Array.isArray(rawIdentity)
    ? /** @type {Record<string, unknown>} */ (rawIdentity)
    : {};
  const sourceType = String(identity.sourceType ?? "").trim().toUpperCase();
  if (!new Set(["PO", "VRMA"]).has(sourceType)) {
    return null;
  }
  const localVendorId = Number(identity.localVendorId);
  if (!Number.isSafeInteger(localVendorId) || localVendorId < 1) {
    return null;
  }
  const destinationYardCode = String(identity.mbbsYardCode ?? "").trim().toUpperCase();
  const exactNames = new Set([
    normalizedText(identity.vendorYardName),
    ...(Array.isArray(identity.vendorYardAliases) ? identity.vendorYardAliases.map(normalizedText) : [])
  ].filter(Boolean));
  const selected = normalizeMbbsVendorRouteRates(rawRates).find((rate) => (
    rate.localVendorId === localVendorId
      && rate.destinationYardCode === destinationYardCode
      && exactNames.has(normalizedText(rate.vendorYardName))
  ));
  return selected ? { ...selected, pricingSource: "vendor_yard_flat" } : null;
}

/** @param {unknown} rawInput */
// eslint-disable-next-line complexity -- Monetary inputs are independently validated before exact-cent calculation.
export function calculateMbbsPurchaseRouteAmount(rawInput) {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? /** @type {Record<string, any>} */ (rawInput)
    : {};
  const policy = input.mbbsChargingPolicy && typeof input.mbbsChargingPolicy === "object"
    ? input.mbbsChargingPolicy
    : {};
  const supportedSchema = policy.schemaVersion === 2 || policy.schemaVersion === 3;
  if (!supportedSchema || policy.currency !== "CAD") {
    return invalid("MBT_RATE_CARD_POLICY_INVALID", "MBBS policy schema version 2 or 3 in CAD is required for vendor-route pricing.");
  }
  const pricingMethod = String(input.pricingMethod ?? "");
  if (!PRICING_METHODS.has(pricingMethod)) {
    return invalid("MBT_VENDOR_ROUTE_PRICING_METHOD_INVALID", "PO/VRMA pricing must use a vendor-yard flat rate or a distance band.");
  }
  const routeStopCount = exactInteger(input.routeStopCount, "Route stop count", 2);
  const distanceBandAmountMinor = exactMoney(input.distanceBandAmountMinor, "Distance-band charge");
  const vendorRouteAmountMinor = exactMoney(input.vendorRouteAmountMinor, "Vendor-route charge");
  const additionalStopUnitAmountMinor = exactMoney(
    policy.poVrmaAdditionalStopUnitAmountMinor,
    "PO/VRMA additional-stop price"
  );
  const additionalStopCount = Math.max(0, routeStopCount - 2);
  const additionalStopFeeMinor = safeProduct(additionalStopUnitAmountMinor, additionalStopCount);
  const baseAmountMinor = pricingMethod === "vendor_yard_flat"
    ? vendorRouteAmountMinor
    : distanceBandAmountMinor;
  return {
    pricingMethod,
    pricingSource: pricingMethod,
    baseAmountMinor,
    distanceBandAmountMinor: pricingMethod === "distance_band" ? distanceBandAmountMinor : 0,
    vendorRouteAmountMinor: pricingMethod === "vendor_yard_flat" ? vendorRouteAmountMinor : 0,
    additionalStopCount,
    additionalStopUnitAmountMinor,
    additionalStopFeeMinor,
    calculatedAmountMinor: safeSum([baseAmountMinor, additionalStopFeeMinor])
  };
}

/** @param {string} originKey @param {string} prefix @param {Array<[string, number]>} destinations */
function seedRows(originKey, prefix, destinations) {
  return destinations.map(([destinationLabel, dollars]) => Object.freeze({
    originKey,
    rateName: `${prefix} to ${destinationLabel}`,
    displayName: `${prefix} to ${destinationLabel}`,
    destinationLabel,
    baseAmountMinor: dollars * 100
  }));
}

/** @param {[number, number, number, number]} dollars @returns {Array<[string, number]>} */
function fourYardPrices(dollars) {
  return [
    ["12441", dollars[0]],
    ["2967", dollars[1]],
    ["3445", dollars[2]],
    ["150", dollars[3]]
  ];
}

export const MBBS_PO_VRMA_RATE_SEED = Object.freeze([
  ...seedRows("beaver_valley_maple", "Beaver Valley Stone - Maple", fourYardPrices([200, 250, 250, 300])),
  ...seedRows("bestway_uxbridge", "Bestway Stone - Uxbridge", fourYardPrices([200, 250, 250, 450])),
  ...seedRows("bestway_woodbridge", "Bestway Stone -Woodbridge", fourYardPrices([350, 350, 350, 400])),
  ...seedRows("browns_sudbury", "Browns - Sudbury", fourYardPrices([1550, 1650, 1650, 1700])),
  ...seedRows("canada_fastening_mississauga", "Canada Fasting", [["2967", 350], ["3445", 350]]),
  ...seedRows("crupi_markham", "Crupi - Markham", [["2967", 150], ["3445", 150]]),
  ...seedRows("crupi_scarborough", "Crupi - Scarborough", [["2967", 150], ["3445", 150]]),
  ...seedRows("draglam_vaughan", "Draglam - Vaughan", [["2967", 300], ["3445", 300]]),
  ...seedRows("oakville_mississauga", "Oakville Stone - Mississaga", fourYardPrices([350, 450, 450, 400])),
  ...seedRows("permacon_bolton", "Permacon - Bolton", fourYardPrices([350, 450, 450, 450])),
  ...seedRows("permacon_cambridge", "Permacon - Cambridge", [["12441", 550], ["2967", 600], ["3445", 600], ["150", 550]]),
  ...seedRows("permacon_milton", "Permacon - Milton", fourYardPrices([450, 500, 500, 500])),
  ...seedRows("permacon_woodstock", "Permacon - Woodstock", [["2967", 700], ["3445", 700]]),
  ...seedRows("techo_ayr", "Techo - AYR", fourYardPrices([550, 600, 600, 550])),
  ...seedRows("techo_vaughan", "Techo - VAUGHAN", fourYardPrices([300, 350, 350, 400])),
  ...seedRows("unilock_ayr", "Unilock - Ayr", fourYardPrices([550, 600, 600, 550])),
  ...seedRows("unilock_barrie", "Unilock - Barrie", [["2967", 450], ["3445", 450]]),
  ...seedRows("unilock_georgetown", "Unilock - Georgetown", [["12441", 450], ["2967", 450], ["3445", 450], ["150", 400]]),
  ...seedRows("unilock_gormley", "Unilock - Gormly", [["2967", 250], ["3445", 250], ["150", 400]]),
  ...seedRows("unilock_gormley", "Unilock- Gormly", [["12441", 150]]),
  ...seedRows("unilock_pickering", "Unilock - Pickering", fourYardPrices([300, 300, 300, 500])),
  ...seedRows("voyage_scarborough", "Voyage - Scarborough", [["12441", 250], ["2967", 250], ["3445", 250]])
]);

const ORIGIN_IDENTITIES = /** @type {Readonly<Record<string, readonly [string, string]>>} */ (Object.freeze({
  beaver_valley_maple: ["Beaver Valley Stone", "Beaver Valley Stone"],
  bestway_uxbridge: ["BWS", "BWS Uxbridge"],
  bestway_woodbridge: ["BWS", "BWS Woodbridge"],
  canada_fastening_mississauga: ["CFC", "CFC"],
  oakville_mississauga: ["Oakville", "Oakville Stone"],
  permacon_bolton: ["PERMACON", "PERMACON Bolton"],
  permacon_cambridge: ["PERMACON", "PERMACON Cambridge"],
  permacon_milton: ["PERMACON", "PERMACON Milton"],
  techo_ayr: ["Techo-Bloc", "TECHO BLOC Ayr"],
  techo_vaughan: ["Techo-Bloc", "TECHO BLOC Vaughan"],
  unilock_ayr: ["Unilock Ltd", "Ayr Yard - Unilock"],
  unilock_georgetown: ["Unilock Ltd", "UNILOCK Georgetown"],
  unilock_gormley: ["Unilock Ltd", "UNILOCK Gormley"],
  unilock_pickering: ["Unilock Ltd", "UNILOCK Pickering"]
}));

/** @param {unknown} rawInput */
export function planMbbsPoVrmaRateSeed(rawInput) {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? /** @type {Record<string, any>} */ (rawInput)
    : {};
  const vendorYards = Array.isArray(input.vendorYards) ? input.vendorYards : [];
  const mbbsYards = new Set((Array.isArray(input.mbbsYards) ? input.mbbsYards : [])
    .map((yard) => String(yard).trim().toUpperCase()));
  const mapped = [];
  const fallback = [];
  for (const seed of MBBS_PO_VRMA_RATE_SEED) {
    const configuredIdentity = ORIGIN_IDENTITIES[seed.originKey];
    const destinationYardCode = seed.destinationLabel;
    const vendorYard = configuredIdentity
      ? vendorYards.find((candidate) => (
          normalizedText(candidate.localVendorName) === normalizedText(configuredIdentity[0])
            && normalizedText(candidate.vendorYardName) === normalizedText(configuredIdentity[1])
        ))
      : null;
    if (!vendorYard || !mbbsYards.has(destinationYardCode)) {
      fallback.push({ ...seed, destinationYardCode, reason: "No current exact local vendor-yard/MBBS-yard pair." });
      continue;
    }
    mapped.push({
      rateName: seed.rateName,
      displayName: seed.displayName,
      localVendorId: Number(vendorYard.localVendorId),
      localVendorName: String(vendorYard.localVendorName),
      vendorYardName: String(vendorYard.vendorYardName),
      vendorYardAddress: String(vendorYard.vendorYardAddress),
      destinationYardCode,
      baseAmountMinor: seed.baseAmountMinor,
      currency: "CAD"
    });
  }
  return {
    suppliedCount: MBBS_PO_VRMA_RATE_SEED.length,
    mapped: normalizeMbbsVendorRouteRates(mapped),
    fallback: fallback.sort((left, right) => left.rateName.localeCompare(right.rateName))
  };
}

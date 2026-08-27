// @ts-check

export const OPERATOR_NETSUITE_POSTING_FUNCTIONS = Object.freeze({
  customerPickup: Object.freeze({
    functionKey: "customer_pickup",
    transactionType: "IF",
    gateSegment: "customer_pickup_if"
  }),
  receiving: Object.freeze({
    functionKey: "receiving",
    transactionType: "IR",
    gateSegment: "receiving_ir"
  }),
  deliveryPrep: Object.freeze({
    functionKey: "delivery_prep",
    transactionType: "IF",
    gateSegment: "delivery_prep_if"
  })
});

export const OPERATOR_NETSUITE_YARDS = Object.freeze([
  Object.freeze({ locationId: 1, yardCode: "3445" }),
  Object.freeze({ locationId: 28, yardCode: "2967" }),
  Object.freeze({ locationId: 15, yardCode: "12441" }),
  Object.freeze({ locationId: 26, yardCode: "150" })
]);

/** @type {Map<string, Record<string, any>>} */
const FUNCTIONS_BY_KEY = new Map(
  Object.values(OPERATOR_NETSUITE_POSTING_FUNCTIONS)
    .map((details) => [details.functionKey, details])
);
/** @type {Map<number, Record<string, any>>} */
const YARDS_BY_ID = new Map(OPERATOR_NETSUITE_YARDS.map((yard) => [yard.locationId, yard]));
/** @type {Map<string, Record<string, any>>} */
const YARDS_BY_CODE = new Map(OPERATOR_NETSUITE_YARDS.map((yard) => [yard.yardCode, yard]));

export const OPERATOR_NETSUITE_GATE_DEFINITIONS = Object.freeze(
  OPERATOR_NETSUITE_YARDS.flatMap((yard) => (
    Object.values(OPERATOR_NETSUITE_POSTING_FUNCTIONS).map((details) => Object.freeze({
      flagKey: `operator_netsuite_${details.gateSegment}_${yard.yardCode}`,
      label: `${yard.yardCode} ${details.functionKey.replaceAll("_", " ")} ${details.transactionType}`,
      description: `Allow Operator ${details.functionKey.replaceAll("_", " ")} at yard ${yard.yardCode} to create a NetSuite ${details.transactionType}.`,
      operatorFunction: details.functionKey,
      transactionType: details.transactionType,
      locationId: yard.locationId,
      yardCode: yard.yardCode,
      configuredDefault: false,
      requiresNetSuiteDirectAccess: true,
      independent: true,
      locked: false,
      lockReason: null
    }))
  ))
);

/** @type {Map<string, Record<string, any>>} */
const GATES_BY_IDENTITY = new Map(OPERATOR_NETSUITE_GATE_DEFINITIONS.map((definition) => [
  `${definition.operatorFunction}:${definition.locationId}`,
  definition
]));

/** @param {unknown} value */
export function normalizeOperatorNetSuiteLocationId(value) {
  if (typeof value !== "string" && typeof value !== "number") {return null;}
  const normalized = String(value).trim();
  if (!normalized) {return null;}
  if (normalized === "13") {return 28;}
  const byCode = YARDS_BY_CODE.get(normalized);
  if (byCode) {return byCode.locationId;}
  if (!/^\d+$/u.test(normalized)) {return null;}
  const numeric = Number(normalized);
  return YARDS_BY_ID.has(numeric) ? numeric : null;
}

/** @param {{functionKey?: unknown, locationId?: unknown}} input */
export function operatorNetSuitePostingGateKey({ functionKey, locationId } = {}) {
  const canonicalLocationId = normalizeOperatorNetSuiteLocationId(locationId);
  const normalizedFunction = String(functionKey || "").trim().toLowerCase();
  if (!canonicalLocationId || !FUNCTIONS_BY_KEY.has(normalizedFunction)) {return null;}
  return GATES_BY_IDENTITY.get(`${normalizedFunction}:${canonicalLocationId}`)?.flagKey || null;
}

/** @param {{enabled?: unknown, revision?: unknown} | null | undefined} flag @param {unknown} directAccessEnabled */
function materializedFlagState(flag, directAccessEnabled) {
  const present = Boolean(flag && typeof flag === "object");
  const numericRevision = Number(flag?.revision);
  const revision = present && Number.isSafeInteger(numericRevision) && numericRevision > 0 ? numericRevision : null;
  const configured = present && flag?.enabled === true;
  const environmentAllowed = directAccessEnabled === true;
  return { present, revision, configured, environmentAllowed };
}

/** @param {string} functionKey @param {number | null} locationId @param {unknown} directAccessEnabled */
function unsupportedPolicy(functionKey, locationId, directAccessEnabled) {
  return {
    schemaVersion: "operator-netsuite-posting-policy-v1",
    supported: false,
    gateKey: null,
    functionKey: functionKey || null,
    transactionType: null,
    locationId,
    yardCode: null,
    present: false,
    configured: false,
    environmentAllowed: directAccessEnabled === true,
    effective: false,
    revision: null
  };
}

/**
 * @param {object} input
 * @param {unknown} [input.functionKey]
 * @param {unknown} [input.locationId]
 * @param {{enabled?: unknown, revision?: unknown} | null | undefined} [input.flag]
 * @param {unknown} [input.directAccessEnabled]
 */
export function materializeOperatorNetSuitePostingPolicy({
  functionKey,
  locationId,
  flag,
  directAccessEnabled
} = {}) {
  const canonicalLocationId = normalizeOperatorNetSuiteLocationId(locationId);
  const normalizedFunction = String(functionKey || "").trim().toLowerCase();
  const definition = canonicalLocationId
    ? GATES_BY_IDENTITY.get(`${normalizedFunction}:${canonicalLocationId}`)
    : null;
  if (!definition) {
    return unsupportedPolicy(normalizedFunction, canonicalLocationId, directAccessEnabled);
  }
  const { present, revision, configured, environmentAllowed } = materializedFlagState(flag, directAccessEnabled);
  return {
    schemaVersion: "operator-netsuite-posting-policy-v1",
    supported: true,
    gateKey: definition.flagKey,
    functionKey: definition.operatorFunction,
    transactionType: definition.transactionType,
    locationId: definition.locationId,
    yardCode: definition.yardCode,
    present,
    configured,
    environmentAllowed,
    effective: configured && environmentAllowed,
    revision
  };
}

/** @param {Record<string, unknown> | null} supplied @param {Record<string, unknown> | undefined} actual */
function expectedPolicyMatches(supplied, actual) {
  if (!supplied) {return false;}
  if (String(supplied.gateKey || "") !== String(actual?.gateKey || "")) {return false;}
  if (Number(supplied.revision) !== Number(actual?.revision)) {return false;}
  return typeof supplied.effective === "boolean" && supplied.effective === actual?.effective;
}

/** @param {{expected?: unknown, actual?: Record<string, unknown>}} input */
export function assertExpectedOperatorNetSuitePostingPolicy({ expected, actual } = {}) {
  const supplied = expected && typeof expected === "object"
    ? /** @type {Record<string, unknown>} */ (expected)
    : null;
  if (expectedPolicyMatches(supplied, actual)) {return actual;}
  throw Object.assign(new Error("The Operator NetSuite posting policy changed. Refresh and confirm again."), {
    status: 409,
    code: "OPERATOR_NETSUITE_POSTING_POLICY_CHANGED"
  });
}

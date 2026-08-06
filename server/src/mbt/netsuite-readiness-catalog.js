// @ts-check

/** @template T @param {T} value @param {Set<object>} [seen] @returns {Readonly<T>} */
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

/**
 * @param {object} input
 * @param {string} input.checkCode
 * @param {string} input.mappingType
 * @param {string} input.localKey
 * @param {string} input.expectedRecordType
 * @param {string} input.label
 * @param {string} input.group
 * @param {string} [input.verificationKind]
 * @param {string} [input.requiredStatus]
 * @param {Record<string, unknown>} [input.expected]
 * @param {string} [input.readStrategy]
 * @param {readonly string[]} [input.allowedRecordTypes]
 * @param {readonly string[]} [input.requiredExpectedFields]
 * @param {boolean} [input.requiresSubsidiaryNetSuiteId]
 * @param {boolean} [input.requiresSubsidiaryMembership]
 * @param {readonly string[]} [input.allowedAccountTypes]
 */
function requirement({
  checkCode,
  mappingType,
  localKey,
  expectedRecordType,
  label,
  group,
  verificationKind = "record_read",
  requiredStatus = "verified",
  expected = { active: true },
  readStrategy = "record_by_id",
  allowedRecordTypes = [expectedRecordType],
  requiredExpectedFields = [],
  requiresSubsidiaryNetSuiteId = false,
  requiresSubsidiaryMembership = false,
  allowedAccountTypes = []
}) {
  return {
    checkCode,
    mappingType,
    localKey,
    expectedRecordType,
    verificationKind,
    required: true,
    requiredStatus,
    severity: "error",
    expected,
    display: { group, label },
    readStrategy,
    allowedRecordTypes: [...allowedRecordTypes],
    requiredExpectedFields: [...requiredExpectedFields],
    requiresSubsidiaryNetSuiteId,
    requiresSubsidiaryMembership,
    allowedAccountTypes: [...allowedAccountTypes]
  };
}

const RECORD_REQUIREMENTS = [
  requirement({
    checkCode: "mbt_subsidiary",
    mappingType: "subsidiary",
    localKey: "mbt",
    expectedRecordType: "subsidiary",
    label: "MBT subsidiary",
    group: "Organization",
    expected: { active: true },
    requiredExpectedFields: ["legalName", "baseCurrency"]
  }),
  requirement({
    checkCode: "customer_33",
    mappingType: "intercompany_customer",
    localKey: "customer_33",
    expectedRecordType: "customer",
    label: "Intercompany customer 33",
    group: "Organization",
    verificationKind: "relationship_read",
    expected: { active: true, externalId: "33" },
    requiredExpectedFields: [
      "entityId",
      "companyName",
      "currencyId",
      "termsId",
      "taxItemId",
      "creditHold"
    ],
    requiresSubsidiaryNetSuiteId: true,
    requiresSubsidiaryMembership: true
  }),
  requirement({
    checkCode: "customer_sales_order_form",
    mappingType: "sales_order_form",
    localKey: "customer",
    expectedRecordType: "sales_order_form",
    label: "Customer Sales Order form",
    group: "Transaction forms",
    readStrategy: "unsupported",
    allowedRecordTypes: []
  }),
  requirement({
    checkCode: "sot_sales_order_form",
    mappingType: "sales_order_form",
    localKey: "sot_cross_charge",
    expectedRecordType: "sales_order_form",
    label: "SOT cross-charge Sales Order form",
    group: "Transaction forms",
    readStrategy: "unsupported",
    allowedRecordTypes: []
  }),
  requirement({
    checkCode: "customer_deposit_form",
    mappingType: "customer_deposit_form",
    localKey: "customer_deposit",
    expectedRecordType: "customer_deposit_form",
    label: "Customer Deposit form",
    group: "Transaction forms",
    readStrategy: "unsupported",
    allowedRecordTypes: []
  })
];

/** @type {ReadonlyArray<readonly [string, string]>} */
const ITEM_DEFINITIONS = [
  ["initial_service", "Initial service item"],
  ["rental", "Rental item"],
  ["extension", "Extension item"],
  ["exchange", "Exchange item"],
  ["pickup", "Pickup item"],
  ["dump", "Dump item"],
  ["downtown_surcharge", "Downtown surcharge item"],
  ["discount", "Discount item"],
  ["cross_charge", "Cross-charge item"]
];

const ITEM_REQUIREMENTS = ITEM_DEFINITIONS.map(([localKey, label]) => {
  const allowedRecordTypes = localKey === "discount"
    ? ["discountItem"]
    : ["servicesaleitem", "noninventorySaleItem", "otherChargeSaleItem"];
  return requirement({
    checkCode: `item_${localKey}`,
    mappingType: "sales_order_item",
    localKey,
    expectedRecordType: "sales_order_item",
    label,
    group: "Items",
    verificationKind: "subsidiary_record_read",
    expected: { active: true },
    allowedRecordTypes,
    requiresSubsidiaryNetSuiteId: true,
    requiresSubsidiaryMembership: true
  });
});

/** @type {ReadonlyArray<readonly [string, string]>} */
const INCOME_ACCOUNT_DEFINITIONS = [
  ["transport_revenue", "Transport revenue account"],
  ["dump_revenue", "Dump revenue account"],
  ["rental_revenue", "Rental revenue account"]
];

const FINANCIAL_REQUIREMENTS = [
  requirement({
    checkCode: "default_tax_mapping",
    mappingType: "tax_code",
    localKey: "default",
    expectedRecordType: "tax_code",
    label: "Default tax mapping",
    group: "Tax and accounts",
    allowedRecordTypes: ["salesTaxItem"]
  }),
  ...INCOME_ACCOUNT_DEFINITIONS.map(([localKey, label]) => requirement({
    checkCode: `account_${localKey}`,
    mappingType: "income_account",
    localKey,
    expectedRecordType: "account",
    label,
    group: "Tax and accounts",
    expected: { active: true },
    requiredExpectedFields: ["accountType", "name"],
    requiresSubsidiaryMembership: true,
    allowedAccountTypes: ["Income", "OthIncome"]
  })),
  requirement({
    checkCode: "account_deposit_liability",
    mappingType: "liability_account",
    localKey: "deposit",
    expectedRecordType: "account",
    label: "Deposit liability account",
    group: "Tax and accounts",
    expected: { active: true },
    requiredExpectedFields: ["accountType", "name"],
    requiresSubsidiaryMembership: true,
    allowedAccountTypes: [
      "AcctPay",
      "CredCard",
      "DeferRevenue",
      "LongTermLiab",
      "OthCurrLiab"
    ]
  }),
  requirement({
    checkCode: "receipt_file_cabinet_folder",
    mappingType: "file_cabinet_folder",
    localKey: "receipt",
    expectedRecordType: "folder",
    label: "Receipt File Cabinet folder",
    group: "File Cabinet",
    readStrategy: "unsupported",
    allowedRecordTypes: []
  })
];

/** @type {ReadonlyArray<readonly [string, string, readonly string[]]>} */
const READ_PERMISSION_DEFINITIONS = [
  ["read_subsidiary", "Read subsidiary metadata", ["mbt_subsidiary"]],
  ["read_customer", "Read customer metadata", ["customer_33"]],
  ["read_forms", "Read transaction-form metadata", [
    "customer_sales_order_form",
    "sot_sales_order_form",
    "customer_deposit_form"
  ]],
  ["read_items", "Read item metadata", ["item_initial_service"]],
  ["read_accounts_tax", "Read account and tax metadata", [
    "default_tax_mapping",
    "account_transport_revenue",
    "account_deposit_liability"
  ]],
  ["read_custom_fields", "Read custom-field metadata", ["custom_field_local_contract_uuid"]],
  ["read_file_cabinet_folder", "Read File Cabinet folder metadata", ["receipt_file_cabinet_folder"]]
];

const READ_PERMISSION_REQUIREMENTS = READ_PERMISSION_DEFINITIONS.map(([localKey, label, derivedFromCheckCodes]) => requirement({
  checkCode: `permission_${localKey}`,
  mappingType: "integration_permission",
  localKey,
  expectedRecordType: "integration_permission",
  label,
  group: "Integration permissions",
  verificationKind: "metadata_read",
  expected: { permissionLevel: "view", derivedFromCheckCodes },
  readStrategy: "derived_permission",
  allowedRecordTypes: []
}));

/** @type {ReadonlyArray<readonly [string, string]>} */
const FUTURE_PERMISSION_DEFINITIONS = [
  ["future_sales_order_write", "Future Sales Order write permission"],
  ["future_customer_deposit_write", "Future Customer Deposit write permission"],
  ["future_file_cabinet_write", "Future File Cabinet write permission"]
];

const FUTURE_PERMISSION_REQUIREMENTS = FUTURE_PERMISSION_DEFINITIONS.map(([localKey, label]) => requirement({
  checkCode: `permission_${localKey}`,
  mappingType: "integration_permission",
  localKey,
  expectedRecordType: "integration_permission",
  label,
  group: "Future write permissions",
  verificationKind: "metadata_read",
  requiredStatus: "configured_unproven",
  expected: { permissionLevel: "configured_unproven" },
  readStrategy: "configured_unproven",
  allowedRecordTypes: []
}));

/** @type {ReadonlyArray<readonly [string, string]>} */
const CUSTOM_FIELD_DEFINITIONS = [
  ["local_contract_uuid", "Local contract UUID"],
  ["contract_sequence", "Contract sequence"],
  ["predecessor_sales_order", "Predecessor NetSuite Sales Order"],
  ["billing_version_id", "Billing version ID"],
  ["billing_line_uuid", "Billing-line UUID"],
  ["external_idempotency_key", "External idempotency key"],
  ["physical_load", "Physical load"],
  ["plan_date", "Plan date"],
  ["truck", "Truck"],
  ["driver", "Driver"],
  ["source_references", "Source references"],
  ["raw_distance_metres", "Raw distance metres"],
  ["display_distance_kilometres", "Display distance kilometres"],
  ["rate_band_reference", "Rate-band reference"],
  ["downtown_surcharge", "Downtown surcharge"],
  ["allocation_evidence", "Allocation evidence"]
];

const CUSTOM_FIELD_REQUIREMENTS = CUSTOM_FIELD_DEFINITIONS.map(([localKey, label]) => requirement({
  checkCode: `custom_field_${localKey}`,
  mappingType: "custom_field",
  localKey,
  expectedRecordType: "transaction_custom_field",
  label,
  group: "Transaction custom fields",
  verificationKind: "custom_field_metadata",
  expected: { active: true },
  readStrategy: "metadata_catalog",
  allowedRecordTypes: ["salesOrder", "customerDeposit"],
  requiredExpectedFields: ["fieldType"]
}));

export const NETSUITE_READINESS_REQUIREMENTS = deepFreeze([
  ...RECORD_REQUIREMENTS,
  ...ITEM_REQUIREMENTS,
  ...FINANCIAL_REQUIREMENTS,
  ...READ_PERMISSION_REQUIREMENTS,
  ...FUTURE_PERMISSION_REQUIREMENTS,
  ...CUSTOM_FIELD_REQUIREMENTS
]);

/**
 * The catalog deliberately accepts no request input. Phase 2 callers can join
 * mappings to these requirements, but cannot remove or downgrade a check.
 */
export function getNetSuiteReadinessCatalog() {
  return NETSUITE_READINESS_REQUIREMENTS;
}
